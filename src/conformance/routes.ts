import { ErrorBody, NotFoundReport, PREFIX, type Meta as MetaType } from "../contract.js";
import type { ConformanceContext } from "./context.js";
import { PROBE_ID, STALE_VERSION } from "./context.js";

// The insight group, and the content routes added since v0.17.0: each answers on the probe id, or 501 where the site lacks it.
export async function routeChecks(ctx: ConformanceContext): Promise<void> {
  const {
    config,
    doFetch,
    origin,
    auth,
    capabilities,
    check,
    skip,
    probe,
    errorCode,
    expectStatus,
  } = ctx;

  const hasNotFound = capabilities?.insightNotFound === true;
  const notFoundPath = `${origin}${PREFIX}/insight/not-found`;

  await check("not-found report: advertised in capabilities, or answered 501", async () => {
    const response = await doFetch(`${notFoundPath}?days=7&limit=5`, { headers: auth });
    if (hasNotFound) {
      expectStatus(response, 200, "not-found report");
      const { rows } = NotFoundReport.parse(await response.json());
      if (rows.length > 5) throw new Error(`${rows.length} rows for a limit of 5`);
      return `${rows.length} missing path(s) in 7 days`;
    }
    expectStatus(response, 501, "not-found report on a site without it");
    const code = await errorCode(response);
    if (code !== "not-implemented")
      throw new Error(`error code ${code ?? "missing"}, expected not-implemented`);
    return "501 not-implemented";
  });

  if (hasNotFound) {
    await check("not-found report past 90 days: refused", async () => {
      expectStatus(await doFetch(`${notFoundPath}?days=91`, { headers: auth }), 400, "days=91");
      return "400 invalid";
    });
  }

  // ---------- v0.17.0: each new route answers on the probe id, or 501 where the site lacks it

  await check("errors: problem details with type, title and status", async () => {
    const response = await doFetch(`${origin}${PREFIX}/no-such-route`, { headers: auth });
    const type = response.headers.get("content-type") ?? "";
    if (!type.startsWith("application/problem+json"))
      throw new Error(`content-type ${type || "missing"}, expected application/problem+json`);
    const body = ErrorBody.parse(await response.json());
    if (!body.type || !body.title || body.status !== response.status)
      throw new Error(`type, title or status missing or wrong: ${JSON.stringify(body)}`);
    return `${response.status} ${body.title}`;
  });

  await check("preview: a tiny source answers HTML that is never indexed", async () => {
    const response = await doFetch(`${origin}${PREFIX}/preview`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ source: "# Conformance probe\n" }),
    });
    expectStatus(response, 200, "preview");
    const type = response.headers.get("content-type") ?? "";
    if (!type.startsWith("text/html"))
      throw new Error(`content-type ${type || "missing"}, expected text/html`);
    const html = await response.text();
    if (
      !/noindex/i.test(response.headers.get("x-robots-tag") ?? "") &&
      !/<meta[^>]+noindex/i.test(html)
    )
      throw new Error("neither x-robots-tag nor a robots meta says noindex");
    return "200 text/html, noindex";
  });

  if (config.probeWrites !== false) {
    const caps = capabilities ?? ({} as Partial<MetaType["capabilities"]>);
    const send = (method: string, path: string, body: unknown) =>
      doFetch(`${origin}${PREFIX}${path}`, {
        method,
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    async function expectCode(
      response: Response,
      allowed: Array<[number, string]>,
      what: string,
    ): Promise<string> {
      const code = await errorCode(response);
      if (!allowed.some(([status, c]) => response.status === status && code === c)) {
        throw new Error(
          `${what}: ${response.status} ${code ?? "no error code"}, expected ${allowed.map((a) => a.join(" ")).join(" or ")}`,
        );
      }
      return `${response.status} ${code}`;
    }
    const absent: [number, string] = [501, "not-implemented"];
    const unknown: [number, string] = [404, "not-found"];

    await check("publish of an unknown id: refused", async () =>
      expectCode(
        await send("POST", `/content/${PROBE_ID}/publish`, {
          expectedVersion: STALE_VERSION,
          changeId: probe(),
        }),
        [unknown, [409, "version-conflict"]],
        "publish",
      ),
    );

    await check(
      "publish with a future publishedAt: refused, or not implemented where the site cannot set the date",
      async () =>
        expectCode(
          await send("POST", `/content/${PROBE_ID}/publish`, {
            expectedVersion: STALE_VERSION,
            changeId: probe(),
            publishedAt: "2999-01-01T00:00:00Z",
          }),
          [caps.contentPublishedAt ? [400, "invalid"] : absent],
          "future publishedAt",
        ),
    );

    const writes: Array<[string, boolean | undefined, unknown]> = [
      [
        "rename",
        caps.contentRename,
        { newId: `${PROBE_ID}-renamed`, expectedVersion: STALE_VERSION },
      ],
      ["trash", caps.contentTrash, { expectedVersion: STALE_VERSION }],
      ["restore", caps.contentTrash, { expectedVersion: STALE_VERSION }],
    ];
    for (const [route, offered, body] of writes) {
      await check(
        `content ${route} of an unknown id: refused, or not implemented where the site lacks it`,
        async () =>
          expectCode(
            await send("POST", `/content/${PROBE_ID}/${route}`, {
              ...(body as object),
              changeId: probe(),
            }),
            [offered ? unknown : absent],
            `content ${route}`,
          ),
      );
    }

    await check(
      "preview link for an unknown id: refused, or not implemented where the site has none",
      async () =>
        expectCode(
          await send("POST", "/preview-links", { id: PROBE_ID, changeId: probe() }),
          [caps.previewLinks ? unknown : absent],
          "preview link",
        ),
    );

    if (caps.replay) {
      await check(
        "replay: a stale write sent twice under one change id answers the same 409 twice",
        async () => {
          const body = {
            source: "# Conformance probe\n",
            expectedVersion: STALE_VERSION,
            changeId: probe(),
          };
          const [first, second] = [
            await send("PUT", `/content/${PROBE_ID}/draft`, body),
            await send("PUT", `/content/${PROBE_ID}/draft`, body),
          ];
          expectStatus(first, 409, "first");
          expectStatus(second, 409, "retry");
          const [a, b] = [await first.text(), await second.text()];
          if (a !== b) throw new Error("the retry answered a different body");
          if (second.headers.get("idempotent-replayed") !== "true")
            throw new Error("the retry does not say Idempotent-Replayed: true");
          return "409 twice, the second replayed";
        },
      );
    }
  }

  await check("content list filters: each one the site does not offer answers 501", async () => {
    const offered = capabilities?.contentFilters ?? [];
    const probes: Record<string, string> = {
      kind: "kind=carrel-conformance-probe",
      tag: "tag=carrel-conformance-probe",
      author: "author=Carrel%20Conformance",
      published: "publishedAfter=2000-01-01T00:00:00Z",
      trashed: "trashed=true",
    };
    const missing = Object.keys(probes).filter((f) => !(offered as string[]).includes(f));
    for (const filter of missing)
      expectStatus(
        await doFetch(`${origin}${PREFIX}/content?${probes[filter]}&limit=1`, { headers: auth }),
        501,
        `filter ${filter}`,
      );
    return missing.length > 0 ? `501 for ${missing.join(", ")}` : "the site offers every filter";
  });

  async function expectUnknownField(response: Response, field: string): Promise<string> {
    expectStatus(response, 400, "unknown field");
    const body = ErrorBody.parse(await response.json());
    if (body.error !== "unknown-field")
      throw new Error(`error code ${body.error}, expected unknown-field`);
    if (body.field !== field)
      throw new Error(`field ${body.field ?? "missing"}, expected ${field}`);
    return `400 unknown-field ${field}`;
  }

  await check("unknown query key: refused with unknown-field", async () =>
    expectUnknownField(
      await doFetch(`${origin}${PREFIX}/content?carrelConformanceProbe=1&limit=1`, {
        headers: auth,
      }),
      "carrelConformanceProbe",
    ),
  );

  if (config.probeWrites !== false) {
    await check(
      "unknown body field: refused with unknown-field before anything is written",
      async () => {
        const response = await doFetch(`${origin}${PREFIX}/content/${PROBE_ID}/draft`, {
          method: "PUT",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({
            source: "# Conformance probe\n",
            expectedVersion: STALE_VERSION,
            changeId: probe(),
            carrelConformanceProbe: true,
          }),
        });
        return expectUnknownField(response, "carrelConformanceProbe");
      },
    );
  } else
    skip(
      "unknown body field: refused with unknown-field before anything is written",
      "probeWrites is off",
    );

  await check(
    "backlinks of an unknown id: refused, or not implemented where the site has none",
    async () => {
      const response = await doFetch(`${origin}${PREFIX}/content/${PROBE_ID}/backlinks`, {
        headers: auth,
      });
      const offered = capabilities?.backlinks === true;
      expectStatus(response, offered ? 404 : 501, "backlinks");
      const code = await errorCode(response);
      if (code !== (offered ? "not-found" : "not-implemented"))
        throw new Error(`error code ${code ?? "missing"}`);
      return offered ? "404 not-found" : "501 not-implemented";
    },
  );
}
