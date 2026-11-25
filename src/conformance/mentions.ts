import { MentionList, PREFIX } from "../contract.js";
import type { ConformanceContext } from "./context.js";
import { STALE_VERSION, MENTION_PROBE_ID } from "./context.js";

// The mentions group, checked on every site, since a site without it must say 501.
export async function mentionChecks(ctx: ConformanceContext): Promise<void> {
  const { config, doFetch, origin, auth, capabilities, check, probe, errorCode, expectStatus } =
    ctx;

  const hasMentions = capabilities?.mentions === true;
  const mentionPath = `${origin}${PREFIX}/mentions`;
  const post = (url: string, payload: unknown, headers: Record<string, string> = auth) =>
    doFetch(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

  await check("mentions: advertised in capabilities, or answered 501", async () => {
    const response = await doFetch(`${mentionPath}?limit=1`, { headers: auth });
    if (hasMentions) {
      expectStatus(response, 200, "mentions list");
      const list = MentionList.parse(await response.json());
      return `${list.items.length} mention(s) on the first page`;
    }
    expectStatus(response, 501, "mentions list on a site without the group");
    const code = await errorCode(response);
    if (code !== "not-implemented")
      throw new Error(`error code ${code ?? "missing"}, expected not-implemented`);
    return "501 not-implemented";
  });

  if (config.probeWrites !== false) {
    // The writes below are all refused before any change: no key, an unknown id, a stale version, a body with no change id.
    await check("mentions writes without a key or with a wrong key: refused", async () => {
      const wrong = { authorization: `Bearer ${config.key}x` };
      const body = { decision: "approve", expectedVersion: STALE_VERSION, changeId: probe() };
      for (const headers of [{}, wrong]) {
        expectStatus(
          await post(`${mentionPath}/${MENTION_PROBE_ID}/decide`, body, headers),
          401,
          "decide without the key",
        );
        expectStatus(
          await doFetch(
            `${mentionPath}/${MENTION_PROBE_ID}?expectedVersion=${STALE_VERSION}&changeId=${probe()}`,
            { method: "DELETE", headers },
          ),
          401,
          "delete without the key",
        );
        expectStatus(
          await post(`${mentionPath}/sweep`, { changeId: probe() }, headers),
          401,
          "sweep without the key",
        );
      }
      return "401";
    });

    await check(
      "mention decide of an unknown id: refused, or not implemented where the site has no mentions",
      async () => {
        const response = await post(`${mentionPath}/${MENTION_PROBE_ID}/decide`, {
          decision: "approve",
          expectedVersion: STALE_VERSION,
          changeId: probe(),
        });
        expectStatus(
          response,
          hasMentions ? 404 : 501,
          hasMentions ? "unknown mention decide" : "mention decide on a site without mentions",
        );
        const expected = hasMentions ? "not-found" : "not-implemented";
        const code = await errorCode(response);
        if (code !== expected)
          throw new Error(`error code ${code ?? "missing"}, expected ${expected}`);
        return hasMentions ? "404 not-found" : "501 not-implemented";
      },
    );

    await check(
      "mention delete of an unknown id: refused, or not implemented where the site has no mentions",
      async () => {
        const response = await doFetch(
          `${mentionPath}/${MENTION_PROBE_ID}?expectedVersion=${STALE_VERSION}&changeId=${probe()}`,
          { method: "DELETE", headers: auth },
        );
        expectStatus(
          response,
          hasMentions ? 404 : 501,
          hasMentions ? "unknown mention delete" : "mention delete on a site without mentions",
        );
        const expected = hasMentions ? "not-found" : "not-implemented";
        const code = await errorCode(response);
        if (code !== expected)
          throw new Error(`error code ${code ?? "missing"}, expected ${expected}`);
        return hasMentions ? "404 not-found" : "501 not-implemented";
      },
    );

    await check(
      "mention reset of an unknown id: refused, or not implemented where the site has no reset",
      async () => {
        const offered = hasMentions && capabilities?.mentionReset === true;
        const response = await post(`${mentionPath}/${MENTION_PROBE_ID}/decide`, {
          decision: "reset",
          expectedVersion: STALE_VERSION,
          changeId: probe(),
        });
        expectStatus(
          response,
          offered ? 404 : 501,
          offered ? "unknown mention reset" : "mention reset on a site without it",
        );
        const expected = offered ? "not-found" : "not-implemented";
        const code = await errorCode(response);
        if (code !== expected)
          throw new Error(`error code ${code ?? "missing"}, expected ${expected}`);
        return offered ? "404 not-found" : "501 not-implemented";
      },
    );

    if (hasMentions) {
      await check(
        "mention decide on a stale version: refused, whatever mention is first",
        async () => {
          const list = MentionList.parse(
            await (await doFetch(`${mentionPath}?limit=1`, { headers: auth })).json(),
          );
          const first = list.items[0];
          if (!first) return "no mentions to write against";
          const response = await post(`${mentionPath}/${encodeURIComponent(first.id)}/decide`, {
            decision: "reject",
            expectedVersion: STALE_VERSION,
            changeId: probe(),
          });
          expectStatus(response, 409, "stale mention decision");
          const code = await errorCode(response);
          if (code !== "version-conflict")
            throw new Error(`error code ${code ?? "missing"}, expected version-conflict`);
          // A 409 is only a refusal if nothing changed: read the mention again.
          const after = MentionList.parse(
            await (await doFetch(`${mentionPath}?limit=1`, { headers: auth })).json(),
          ).items.find((m) => m.id === first.id);
          if (!after || after.version !== first.version || after.status !== first.status) {
            throw new Error(
              `mention ${first.id} changed under a refused decision (version ${first.version} to ${after?.version ?? "gone"})`,
            );
          }
          return `409 version-conflict on mention ${first.id}, unchanged`;
        },
      );

      await check(
        "mention sweep with no change id: refused before anything is removed",
        async () => {
          const response = await post(`${mentionPath}/sweep`, {});
          expectStatus(response, 400, "sweep without a change id");
          return "400 invalid";
        },
      );

      await check("mentions list with an unknown status: refused", async () => {
        const response = await doFetch(`${mentionPath}?status=carrel-conformance-probe`, {
          headers: auth,
        });
        expectStatus(response, 400, "unknown status");
        return "400 invalid";
      });
    }
  }
}
