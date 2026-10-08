// The conformance suite: what Carrel's health check runs against a live site. Each check names what
// it proves. Every write it sends by default must be refused, so a conforming site is never changed
// by it. The one exception is opt-in (probeMediaUpload): it uploads a file of its own, then deletes
// that file and no other.

import { MediaBulkResult, ContentList, ErrorBody, RevisionList, RevisionSource, MediaDeleteResult, MediaDetail, MediaItem, MediaList, MentionList, Meta, PREFIX, schemaHash, type Meta as MetaType } from "./contract.js";

export interface ConformanceConfig {
  baseUrl: string;
  key: string;
  fetch?: typeof fetch;
  /** Sends the stale-version write and the refused media writes. On by default; a conforming site refuses them and changes nothing. */
  probeWrites?: boolean;
  /**
   * Uploads a 1x1 PNG of its own, reads it back and deletes it (v0.2.0). Off by default: it is a
   * real write to the site's storage, though it deletes only the file it uploaded.
   */
  probeMediaUpload?: boolean;
}

export interface ConformanceCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ConformanceReport {
  ok: boolean;
  checks: ConformanceCheck[];
}

/** An id no site should hold, so the refused write names nothing real. */
export const PROBE_ID = "carrel-conformance-probe";
/** A media id no site should hold: the refused delete names nothing real. */
export const MEDIA_PROBE_ID = "carrel-conformance-probe/no-such-file.png";
/** A type no site accepts, for the refused upload. */
const PROBE_TYPE = "application/x-carrel-conformance-probe";
/** The smallest valid PNG: one transparent pixel. */
const PROBE_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);
const STALE_VERSION = "carrel-conformance-stale-version";
/** A mention id no site should hold: the refused mention writes name nothing real. */
export const MENTION_PROBE_ID = "carrel-conformance-probe";

export async function runConformance(config: ConformanceConfig): Promise<ConformanceReport> {
  const doFetch = config.fetch ?? fetch;
  const origin = config.baseUrl.replace(/\/+$/, "");
  const auth = { authorization: `Bearer ${config.key}` };
  const checks: ConformanceCheck[] = [];

  async function check(name: string, run: () => Promise<string>) {
    try {
      checks.push({ name, ok: true, detail: await run() });
    } catch (error) {
      checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }

  async function errorCode(response: Response): Promise<string | null> {
    try {
      const parsed = ErrorBody.safeParse(await response.json());
      return parsed.success ? parsed.data.error : null;
    } catch {
      return null;
    }
  }

  function expectStatus(response: Response, status: number, what: string) {
    if (response.status !== status) throw new Error(`${what}: expected ${status}, got ${response.status}`);
  }

  let meta: MetaType | null = null;

  await check("meta: answers with this contract's schema hash", async () => {
    const response = await doFetch(`${origin}${PREFIX}/meta`, { headers: auth });
    expectStatus(response, 200, "meta");
    meta = Meta.parse(await response.json());
    const ours = await schemaHash();
    if (meta.schemaHash !== ours) {
      throw new Error(`schema hash ${meta.schemaHash.slice(0, 12)} is not ${ours.slice(0, 12)} (site on package ${meta.packageVersion})`);
    }
    return `package ${meta.packageVersion}, hash ${ours.slice(0, 12)}`;
  });

  await check("no key: refused", async () => {
    const response = await doFetch(`${origin}${PREFIX}/meta`);
    expectStatus(response, 401, "no key");
    return "401";
  });

  await check("wrong key: refused", async () => {
    const response = await doFetch(`${origin}${PREFIX}/meta`, {
      headers: { authorization: `Bearer ${config.key}x` },
    });
    expectStatus(response, 401, "wrong key");
    return "401";
  });

  await check("key off-prefix: not served", async () => {
    const paths = ["/api/carrel/v2/meta", `${PREFIX}x/meta`, "/api/carrel/meta"];
    for (const path of paths) {
      const response = await doFetch(`${origin}${path}`, { headers: auth });
      if (response.ok) throw new Error(`${path} answered ${response.status} to the Carrel key`);
    }
    return paths.join(", ");
  });

  await check("unknown route: refused", async () => {
    const response = await doFetch(`${origin}${PREFIX}/no-such-route`, { headers: auth });
    expectStatus(response, 404, "unknown route");
    const code = await errorCode(response);
    if (code !== "not-found") throw new Error(`error code ${code ?? "missing"}, expected not-found`);
    return "404 not-found";
  });

  await check("content list: answers in the contract's shape", async () => {
    const response = await doFetch(`${origin}${PREFIX}/content?limit=1`, { headers: auth });
    expectStatus(response, 200, "content list");
    const list = ContentList.parse(await response.json());
    return `${list.items.length} item(s) on the first page`;
  });

  if (config.probeWrites !== false) {
    await check("stale expectedVersion: refused", async () => {
      const response = await doFetch(`${origin}${PREFIX}/content/${PROBE_ID}/draft`, {
        method: "PUT",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          source: "# Conformance probe\n\nA conforming site refuses this write.\n",
          expectedVersion: STALE_VERSION,
          changeId: "conformance-probe",
        }),
      });
      expectStatus(response, 409, "stale write");
      const code = await errorCode(response);
      if (code !== "version-conflict") throw new Error(`error code ${code ?? "missing"}, expected version-conflict`);
      return "409 version-conflict";
    });
  }

  // ---------- v0.3.0: the source at a revision, and the optional content delete

  await check("revision source of an unknown id: not found", async () => {
    const response = await doFetch(`${origin}${PREFIX}/content/${PROBE_ID}/revisions/${STALE_VERSION}`, { headers: auth });
    expectStatus(response, 404, "unknown revision");
    const code = await errorCode(response);
    if (code !== "not-found") throw new Error(`error code ${code ?? "missing"}, expected not-found`);
    return "404 not-found";
  });

  await check("revision source: the newest revision of the first item opens", async () => {
    const list = ContentList.parse(await (await doFetch(`${origin}${PREFIX}/content?limit=1`, { headers: auth })).json());
    const first = list.items[0];
    if (!first) return "no items to read a revision of";
    const revisions = RevisionList.parse(await (await doFetch(`${origin}${PREFIX}/content/${encodeURIComponent(first.id)}/revisions`, { headers: auth })).json());
    const newest = revisions.items[0];
    if (!newest) return `${first.id} has no revisions`;
    const response = await doFetch(`${origin}${PREFIX}/content/${encodeURIComponent(first.id)}/revisions/${encodeURIComponent(newest.version)}`, { headers: auth });
    expectStatus(response, 200, "revision source");
    const opened = RevisionSource.parse(await response.json());
    if (opened.version !== newest.version) throw new Error(`asked for ${newest.version}, got ${opened.version}`);
    return `${first.id} at ${newest.version}`;
  });

  if (config.probeWrites !== false) {
    // Only ever the probe id: a site that wrongly accepts one of these deletes nothing real.
    const deleteUrl = `${origin}${PREFIX}/content/${PROBE_ID}?expectedVersion=${STALE_VERSION}&changeId=conformance-probe`;
    await check("content delete without a key: refused", async () => {
      expectStatus(await doFetch(deleteUrl, { method: "DELETE" }), 401, "delete without a key");
      expectStatus(await doFetch(deleteUrl, { method: "DELETE", headers: { authorization: `Bearer ${config.key}x` } }), 401, "delete with a wrong key");
      return "401";
    });
    await check("content delete of an unknown id: refused, or not implemented where the site has no delete", async () => {
      const response = await doFetch(deleteUrl, { method: "DELETE", headers: auth });
      const offered = (meta as MetaType | null)?.capabilities.contentDelete === true;
      expectStatus(response, offered ? 404 : 501, offered ? "unknown content delete" : "content delete on a site without it");
      const code = await errorCode(response);
      const expected = offered ? "not-found" : "not-implemented";
      if (code !== expected) throw new Error(`error code ${code ?? "missing"}, expected ${expected}`);
      return offered ? "404 not-found" : "501 not-implemented";
    });
  }

  // ---------- media (v0.2.0), only for a site that offers it

  const capabilities = (meta as MetaType | null)?.capabilities;
  if (capabilities?.media) {
    await check("media: upload limits declared", async () => {
      const limits = capabilities.mediaUpload;
      if (!limits) throw new Error("capabilities.media is true but mediaUpload is missing");
      return `${limits.maxBytes} bytes, ${limits.types.join(", ")}`;
    });

    await check("media list: answers in the contract's shape", async () => {
      const response = await doFetch(`${origin}${PREFIX}/media?limit=1`, { headers: auth });
      expectStatus(response, 200, "media list");
      const list = MediaList.parse(await response.json());
      return `${list.items.length} file(s) on the first page`;
    });

    if (config.probeWrites !== false) {
      await check("media delete of an unknown id: refused", async () => {
        const response = await doFetch(`${origin}${PREFIX}/media/${encodeURIComponent(MEDIA_PROBE_ID)}?changeId=conformance-probe`, { method: "DELETE", headers: auth });
        expectStatus(response, 404, "unknown media delete");
        const code = await errorCode(response);
        if (code !== "not-found") throw new Error(`error code ${code ?? "missing"}, expected not-found`);
        return "404 not-found";
      });

      await check("media upload of a type the site does not accept: refused", async () => {
        const response = await doFetch(`${origin}${PREFIX}/media?filename=carrel-conformance-probe.bin&changeId=conformance-probe`, {
          method: "POST",
          headers: { ...auth, "content-type": PROBE_TYPE },
          body: "A conforming site refuses this upload.",
        });
        expectStatus(response, 400, "disallowed upload");
        const code = await errorCode(response);
        if (code !== "invalid") throw new Error(`error code ${code ?? "missing"}, expected invalid`);
        return "400 invalid";
      });

      // v0.4.0 writes. Each is optional: where the site declares the capability, the probe is refused as
      // a real error; where it does not, the same request must answer 501. Nothing here can change a file.
      const probeId = encodeURIComponent(MEDIA_PROBE_ID);
      const send = (method: string, path: string, body: unknown) =>
        doFetch(`${origin}${PREFIX}${path}`, { method, headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
      const stale = { expectedVersion: STALE_VERSION, changeId: "conformance-probe" };

      async function refusedOrAbsent(offered: boolean, response: Response, status: number, code: string, what: string) {
        if (!offered) {
          expectStatus(response, 501, `${what} without the capability`);
          const got = await errorCode(response);
          if (got !== "not-implemented") throw new Error(`error code ${got ?? "missing"}, expected not-implemented`);
          return "501 not-implemented";
        }
        expectStatus(response, status, what);
        const got = await errorCode(response);
        if (got !== code) throw new Error(`error code ${got ?? "missing"}, expected ${code}`);
        return `${status} ${code}`;
      }

      const writes: Array<[string, boolean | undefined, string, string, unknown]> = [
        ["alt", capabilities.mediaAlt, "PUT", "alt", { alt: "probe", ...stale }],
        ["tags", capabilities.mediaTags, "PUT", "tags", { tags: ["probe"], ...stale }],
        ["trash", capabilities.mediaTrash, "POST", "trash", stale],
        ["restore", capabilities.mediaTrash, "POST", "restore", stale],
      ];
      for (const [name, offered, method, route, body] of writes) {
        await check(`media ${name} of an unknown id: refused, or not implemented where the site lacks it`, async () =>
          refusedOrAbsent(Boolean(offered), await send(method, `/media/${probeId}/${route}`, body), 404, "not-found", `media ${name}`));
      }

      await check("media alt with a body outside the contract: refused, or not implemented where the site lacks it", async () =>
        refusedOrAbsent(Boolean(capabilities.mediaAlt), await send("PUT", `/media/${probeId}/alt`, { alt: 7 }), 400, "invalid", "malformed alt"));

      await check("media bulk: an unknown id is that file's own not-found, and the request answers 200", async () => {
        const response = await send("POST", "/media/bulk", { op: "trash", items: [{ id: MEDIA_PROBE_ID, ...stale }] });
        if (!capabilities.mediaTrash) return refusedOrAbsent(false, response, 200, "", "media bulk trash");
        expectStatus(response, 200, "media bulk");
        const result = MediaBulkResult.parse(await response.json());
        const only = result.results[0];
        if (result.results.length !== 1 || !only || only.ok || only.error !== "not-found") {
          throw new Error(`expected one failed not-found outcome, got ${JSON.stringify(result.results)}`);
        }
        return "200, not-found for the file";
      });

      await check("media bulk tag op with no tags: refused, or not implemented where the site lacks tags", async () =>
        refusedOrAbsent(
          Boolean(capabilities.mediaTags),
          await send("POST", "/media/bulk", { op: "add-tags", items: [{ id: MEDIA_PROBE_ID, ...stale }] }),
          400,
          "invalid",
          "bulk add-tags without tags",
        ));

      // Empty-trash deletes real files, so only its refusal of a malformed body is probed.
      await check("media empty trash with a body outside the contract: refused, or not implemented where the site has no trash", async () =>
        refusedOrAbsent(Boolean(capabilities.mediaTrash), await send("POST", "/media/trash/empty", {}), 400, "invalid", "malformed empty trash"));
    }

    if (config.probeMediaUpload && capabilities.mediaUpload?.types.includes("image/png")) {
      await check("media round trip: upload, read, delete its own file", async () => {
        const up = await doFetch(`${origin}${PREFIX}/media?filename=carrel-conformance-probe.png&alt=Conformance%20probe&changeId=conformance-probe`, {
          method: "POST",
          headers: { ...auth, "content-type": "image/png" },
          body: new Blob([PROBE_PNG]),
        });
        expectStatus(up, 201, "upload");
        const item = MediaItem.parse(await up.json());
        const path = `${origin}${PREFIX}/media/${encodeURIComponent(item.id)}`;
        const read = await doFetch(path, { headers: auth });
        expectStatus(read, 200, "read back");
        const detail = MediaDetail.parse(await read.json());
        if (detail.usedBy.length > 0) throw new Error(`its own new file is reported in use: ${JSON.stringify(detail.usedBy)}`);
        // Only the id the site just gave this upload: never any other file.
        const del = await doFetch(`${path}?changeId=conformance-probe`, { method: "DELETE", headers: auth });
        expectStatus(del, 200, "delete");
        MediaDeleteResult.parse(await del.json());
        expectStatus(await doFetch(path, { headers: auth }), 404, "after delete");
        return `uploaded and deleted ${item.id}`;
      });
    }
  }

  // ---------- mentions (v0.5.0): checked on every site, since a site without the group must say 501

  const hasMentions = capabilities?.mentions === true;
  const mentionPath = `${origin}${PREFIX}/mentions`;
  const post = (url: string, payload: unknown, headers: Record<string, string> = auth) =>
    doFetch(url, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(payload) });

  await check("mentions: advertised in capabilities, or answered 501", async () => {
    const response = await doFetch(`${mentionPath}?limit=1`, { headers: auth });
    if (hasMentions) {
      expectStatus(response, 200, "mentions list");
      const list = MentionList.parse(await response.json());
      return `${list.items.length} mention(s) on the first page`;
    }
    expectStatus(response, 501, "mentions list on a site without the group");
    const code = await errorCode(response);
    if (code !== "not-implemented") throw new Error(`error code ${code ?? "missing"}, expected not-implemented`);
    return "501 not-implemented";
  });

  if (config.probeWrites !== false) {
    // The writes below are all refused before any change: no key, an unknown id, a stale version, a body with no change id.
    await check("mentions writes without a key or with a wrong key: refused", async () => {
      const wrong = { authorization: `Bearer ${config.key}x` };
      const body = { decision: "approve", expectedVersion: STALE_VERSION, changeId: "conformance-probe" };
      for (const headers of [{}, wrong]) {
        expectStatus(await post(`${mentionPath}/${MENTION_PROBE_ID}/decide`, body, headers), 401, "decide without the key");
        expectStatus(await doFetch(`${mentionPath}/${MENTION_PROBE_ID}?expectedVersion=${STALE_VERSION}&changeId=conformance-probe`, { method: "DELETE", headers }), 401, "delete without the key");
        expectStatus(await post(`${mentionPath}/sweep`, { changeId: "conformance-probe" }, headers), 401, "sweep without the key");
      }
      return "401";
    });

    await check("mention decide of an unknown id: refused, or not implemented where the site has no mentions", async () => {
      const response = await post(`${mentionPath}/${MENTION_PROBE_ID}/decide`, { decision: "approve", expectedVersion: STALE_VERSION, changeId: "conformance-probe" });
      expectStatus(response, hasMentions ? 404 : 501, hasMentions ? "unknown mention decide" : "mention decide on a site without mentions");
      const expected = hasMentions ? "not-found" : "not-implemented";
      const code = await errorCode(response);
      if (code !== expected) throw new Error(`error code ${code ?? "missing"}, expected ${expected}`);
      return hasMentions ? "404 not-found" : "501 not-implemented";
    });

    await check("mention delete of an unknown id: refused, or not implemented where the site has no mentions", async () => {
      const response = await doFetch(`${mentionPath}/${MENTION_PROBE_ID}?expectedVersion=${STALE_VERSION}&changeId=conformance-probe`, { method: "DELETE", headers: auth });
      expectStatus(response, hasMentions ? 404 : 501, hasMentions ? "unknown mention delete" : "mention delete on a site without mentions");
      const expected = hasMentions ? "not-found" : "not-implemented";
      const code = await errorCode(response);
      if (code !== expected) throw new Error(`error code ${code ?? "missing"}, expected ${expected}`);
      return hasMentions ? "404 not-found" : "501 not-implemented";
    });

    if (hasMentions) {
      await check("mention decide on a stale version: refused, whatever mention is first", async () => {
        const list = MentionList.parse(await (await doFetch(`${mentionPath}?limit=1`, { headers: auth })).json());
        const first = list.items[0];
        if (!first) return "no mentions to write against";
        const response = await post(`${mentionPath}/${encodeURIComponent(first.id)}/decide`, { decision: "reject", expectedVersion: STALE_VERSION, changeId: "conformance-probe" });
        expectStatus(response, 409, "stale mention decision");
        const code = await errorCode(response);
        if (code !== "version-conflict") throw new Error(`error code ${code ?? "missing"}, expected version-conflict`);
        return `409 version-conflict on mention ${first.id}`;
      });

      await check("mention sweep with no change id: refused before anything is removed", async () => {
        const response = await post(`${mentionPath}/sweep`, {});
        expectStatus(response, 400, "sweep without a change id");
        return "400 invalid";
      });

      await check("mentions list with an unknown status: refused", async () => {
        const response = await doFetch(`${mentionPath}?status=carrel-conformance-probe`, { headers: auth });
        expectStatus(response, 400, "unknown status");
        return "400 invalid";
      });
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
}
