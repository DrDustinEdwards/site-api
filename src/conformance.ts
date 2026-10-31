// The conformance suite: what Carrel's health check runs against a live site. Each check names what
// it proves. Every write it sends by default must be refused, so a conforming site is never changed
// by it. The one exception is opt-in (probeMediaUpload): it uploads a file of its own, then deletes
// that file and no other.

import { MEDIA_LENSES, MediaBulkResult, ContentList, ErrorBody, RevisionList, RevisionSource, MediaDeleteResult, MediaDetail, MediaItem, MediaList, MentionList, Meta, NotFoundReport, PREFIX, schemaHash, type Meta as MetaType } from "./contract.js";

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
const PROBE_ID = "carrel-conformance-probe";
/** A media id no site should hold: the refused delete names nothing real. */
const MEDIA_PROBE_ID = "carrel-conformance-probe/no-such-file.png";
/** A type no site accepts, for the refused upload. */
const PROBE_TYPE = "application/x-carrel-conformance-probe";
/** The smallest valid PNG: one transparent pixel. */
const PROBE_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);
const STALE_VERSION = "carrel-conformance-stale-version";
/** A mention id no site should hold: the refused mention writes name nothing real. */
const MENTION_PROBE_ID = "carrel-conformance-probe";

export async function runConformance(config: ConformanceConfig): Promise<ConformanceReport> {
  const doFetch = config.fetch ?? fetch;
  const origin = config.baseUrl.replace(/\/+$/, "");
  const auth = { authorization: `Bearer ${config.key}` };
  const checks: ConformanceCheck[] = [];
  // v0.17.0: a fresh change id for every probe write, since a site with `replay` keeps a refused write's answer under its
  // change id and would refuse the same id on another probe as a different request.
  const run = crypto.randomUUID().slice(0, 8);
  let probes = 0;
  const probe = () => `conformance-probe-${run}-${++probes}`;

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
          changeId: probe(),
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
    const deleteUrl = `${origin}${PREFIX}/content/${PROBE_ID}?expectedVersion=${STALE_VERSION}&changeId=${probe()}`;
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
    await check("content tags of an unknown id: refused, or not implemented where the site keeps no tags", async () => {
      const response = await doFetch(`${origin}${PREFIX}/content/${PROBE_ID}/tags`, {
        method: "PUT",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ tags: ["conformance-probe"], expectedVersion: STALE_VERSION, changeId: probe() }),
      });
      const offered = (meta as MetaType | null)?.capabilities.contentTags === true;
      expectStatus(response, offered ? 404 : 501, offered ? "unknown content tags" : "content tags on a site without them");
      const code = await errorCode(response);
      const expected = offered ? "not-found" : "not-implemented";
      if (code !== expected) throw new Error(`error code ${code ?? "missing"}, expected ${expected}`);
      return offered ? "404 not-found" : "501 not-implemented";
    });
    await check("schedule read and cancel of an unknown id: refused, or not implemented where the site has no scheduled updates", async () => {
      const path = `${origin}${PREFIX}/content/${PROBE_ID}/schedule`;
      const offered = (meta as MetaType | null)?.capabilities.scheduledUpdates === true;
      const expected = offered ? "not-found" : "not-implemented";
      for (const response of [
        await doFetch(path, { headers: auth }),
        await doFetch(`${path}?expectedVersion=${STALE_VERSION}&changeId=${probe()}`, { method: "DELETE", headers: auth }),
      ]) {
        expectStatus(response, offered ? 404 : 501, offered ? "unknown schedule" : "schedule on a site without scheduled updates");
        const code = await errorCode(response);
        if (code !== expected) throw new Error(`error code ${code ?? "missing"}, expected ${expected}`);
      }
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

    // v0.6.0 lenses: every one the site names answers in shape; one it does not name answers 501.
    await check("media lenses: each one the site names answers, and one it does not is not implemented", async () => {
      const named = capabilities.mediaLenses ?? [];
      for (const lens of MEDIA_LENSES) {
        const response = await doFetch(`${origin}${PREFIX}/media?lens=${lens}&limit=1`, { headers: auth });
        if (named.includes(lens)) {
          expectStatus(response, 200, `media lens ${lens}`);
          MediaList.parse(await response.json());
        } else {
          expectStatus(response, 501, `media lens ${lens} on a site that does not name it`);
        }
      }
      return named.length > 0 ? `answers ${named.join(", ")}` : "501 for every lens";
    });

    if (config.probeWrites !== false) {
      await check("media delete of an unknown id: refused", async () => {
        const response = await doFetch(`${origin}${PREFIX}/media/${encodeURIComponent(MEDIA_PROBE_ID)}?changeId=${probe()}`, { method: "DELETE", headers: auth });
        expectStatus(response, 404, "unknown media delete");
        const code = await errorCode(response);
        if (code !== "not-found") throw new Error(`error code ${code ?? "missing"}, expected not-found`);
        return "404 not-found";
      });

      await check("media upload of a type the site does not accept: refused", async () => {
        const response = await doFetch(`${origin}${PREFIX}/media?filename=carrel-conformance-probe.bin&changeId=${probe()}`, {
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
      const stale = { expectedVersion: STALE_VERSION, changeId: probe() };

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
        ["focus", capabilities.mediaFocus, "PUT", "focus", { focus: "0.5x0.5", ...stale }],
        ["caption", capabilities.mediaCaption, "PUT", "caption", { caption: "probe", ...stale }],
        // v0.13.0
        ["credit", capabilities.mediaCredit, "PUT", "credit", { credit: "probe", license: "", sourceUrl: null, licenseExpires: null, ...stale }],
        ["transform", capabilities.mediaTransform, "POST", "transform", { op: "flip-h", ...stale }],
        ["revert", capabilities.mediaHistory, "POST", "revert", { to: "probe", ...stale }],
      ];
      for (const [name, offered, method, route, body] of writes) {
        await check(`media ${name} of an unknown id: refused, or not implemented where the site lacks it`, async () =>
          refusedOrAbsent(Boolean(offered), await send(method, `/media/${probeId}/${route}`, body), 404, "not-found", `media ${name}`));
      }

      // v0.13.0 reads of the probe id: a site answers 404 before it would ask its model anything.
      const reads: Array<[string, boolean | undefined, string]> = [
        ["history", capabilities.mediaHistory, "history"],
        ["suggestions", capabilities.mediaSuggestions, "suggestions"],
      ];
      for (const [name, offered, route] of reads) {
        await check(`media ${name} of an unknown id: refused, or not implemented where the site lacks it`, async () =>
          refusedOrAbsent(Boolean(offered), await doFetch(`${origin}${PREFIX}/media/${probeId}/${route}`, { headers: auth }), 404, "not-found", `media ${name}`));
      }

      // An import of an http address is refused before anything is fetched.
      await check("media import of an http address: refused, or not implemented where the site lacks it", async () =>
        refusedOrAbsent(Boolean(capabilities.mediaImport), await send("POST", "/media/import", { url: "http://example.com/a.png", changeId: probe() }), 400, "invalid", "media import over http"));

      await check("media alt with a body outside the contract: refused, or not implemented where the site lacks it", async () =>
        refusedOrAbsent(Boolean(capabilities.mediaAlt), await send("PUT", `/media/${probeId}/alt`, { alt: 7 }), 400, "invalid", "malformed alt"));

      await check("media focus outside 0 to 1: refused, or not implemented where the site lacks it", async () =>
        refusedOrAbsent(Boolean(capabilities.mediaFocus), await send("PUT", `/media/${probeId}/focus`, { focus: "2x2", ...stale }), 400, "invalid", "focus outside the picture"));

      // v0.10.0: a replace of the probe id, in a type the site accepts, is a 404 before any byte is read.
      await check("media replace of an unknown id: refused, or not implemented where the site lacks it", async () => {
        const type = capabilities.mediaUpload?.types[0] ?? "image/png";
        const response = await doFetch(`${origin}${PREFIX}/media/${probeId}/file?filename=probe&expectedVersion=${STALE_VERSION}&changeId=${probe()}`, {
          method: "PUT",
          headers: { ...auth, "content-type": type },
          body: new Uint8Array([0]),
        });
        return refusedOrAbsent(Boolean(capabilities.mediaReplace), response, 404, "not-found", "media replace");
      });

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
        const up = await doFetch(`${origin}${PREFIX}/media?filename=carrel-conformance-probe.png&alt=Conformance%20probe&changeId=${probe()}`, {
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
        const del = await doFetch(`${path}?changeId=${probe()}`, { method: "DELETE", headers: auth });
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
      const body = { decision: "approve", expectedVersion: STALE_VERSION, changeId: probe() };
      for (const headers of [{}, wrong]) {
        expectStatus(await post(`${mentionPath}/${MENTION_PROBE_ID}/decide`, body, headers), 401, "decide without the key");
        expectStatus(await doFetch(`${mentionPath}/${MENTION_PROBE_ID}?expectedVersion=${STALE_VERSION}&changeId=${probe()}`, { method: "DELETE", headers }), 401, "delete without the key");
        expectStatus(await post(`${mentionPath}/sweep`, { changeId: probe() }, headers), 401, "sweep without the key");
      }
      return "401";
    });

    await check("mention decide of an unknown id: refused, or not implemented where the site has no mentions", async () => {
      const response = await post(`${mentionPath}/${MENTION_PROBE_ID}/decide`, { decision: "approve", expectedVersion: STALE_VERSION, changeId: probe() });
      expectStatus(response, hasMentions ? 404 : 501, hasMentions ? "unknown mention decide" : "mention decide on a site without mentions");
      const expected = hasMentions ? "not-found" : "not-implemented";
      const code = await errorCode(response);
      if (code !== expected) throw new Error(`error code ${code ?? "missing"}, expected ${expected}`);
      return hasMentions ? "404 not-found" : "501 not-implemented";
    });

    await check("mention delete of an unknown id: refused, or not implemented where the site has no mentions", async () => {
      const response = await doFetch(`${mentionPath}/${MENTION_PROBE_ID}?expectedVersion=${STALE_VERSION}&changeId=${probe()}`, { method: "DELETE", headers: auth });
      expectStatus(response, hasMentions ? 404 : 501, hasMentions ? "unknown mention delete" : "mention delete on a site without mentions");
      const expected = hasMentions ? "not-found" : "not-implemented";
      const code = await errorCode(response);
      if (code !== expected) throw new Error(`error code ${code ?? "missing"}, expected ${expected}`);
      return hasMentions ? "404 not-found" : "501 not-implemented";
    });

    await check("mention reset of an unknown id: refused, or not implemented where the site has no reset", async () => {
      const offered = hasMentions && capabilities?.mentionReset === true;
      const response = await post(`${mentionPath}/${MENTION_PROBE_ID}/decide`, { decision: "reset", expectedVersion: STALE_VERSION, changeId: probe() });
      expectStatus(response, offered ? 404 : 501, offered ? "unknown mention reset" : "mention reset on a site without it");
      const expected = offered ? "not-found" : "not-implemented";
      const code = await errorCode(response);
      if (code !== expected) throw new Error(`error code ${code ?? "missing"}, expected ${expected}`);
      return offered ? "404 not-found" : "501 not-implemented";
    });

    if (hasMentions) {
      await check("mention decide on a stale version: refused, whatever mention is first", async () => {
        const list = MentionList.parse(await (await doFetch(`${mentionPath}?limit=1`, { headers: auth })).json());
        const first = list.items[0];
        if (!first) return "no mentions to write against";
        const response = await post(`${mentionPath}/${encodeURIComponent(first.id)}/decide`, { decision: "reject", expectedVersion: STALE_VERSION, changeId: probe() });
        expectStatus(response, 409, "stale mention decision");
        const code = await errorCode(response);
        if (code !== "version-conflict") throw new Error(`error code ${code ?? "missing"}, expected version-conflict`);
        // A 409 is only a refusal if nothing changed: read the mention again.
        const after = MentionList.parse(await (await doFetch(`${mentionPath}?limit=1`, { headers: auth })).json()).items.find((m) => m.id === first.id);
        if (!after || after.version !== first.version || after.status !== first.status) {
          throw new Error(`mention ${first.id} changed under a refused decision (version ${first.version} to ${after?.version ?? "gone"})`);
        }
        return `409 version-conflict on mention ${first.id}, unchanged`;
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

  // ---------- insight (v0.16.0): the 404 report, read only, so checked whatever probeWrites says

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
    if (code !== "not-implemented") throw new Error(`error code ${code ?? "missing"}, expected not-implemented`);
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
    if (!type.startsWith("application/problem+json")) throw new Error(`content-type ${type || "missing"}, expected application/problem+json`);
    const body = ErrorBody.parse(await response.json());
    if (!body.type || !body.title || body.status !== response.status) throw new Error(`type, title or status missing or wrong: ${JSON.stringify(body)}`);
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
    if (!type.startsWith("text/html")) throw new Error(`content-type ${type || "missing"}, expected text/html`);
    const html = await response.text();
    if (!/noindex/i.test(response.headers.get("x-robots-tag") ?? "") && !/<meta[^>]+noindex/i.test(html)) throw new Error("neither x-robots-tag nor a robots meta says noindex");
    return "200 text/html, noindex";
  });

  if (config.probeWrites !== false) {
    const caps = capabilities ?? ({} as Partial<MetaType["capabilities"]>);
    const send = (method: string, path: string, body: unknown) =>
      doFetch(`${origin}${PREFIX}${path}`, { method, headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });

    async function expectCode(response: Response, allowed: Array<[number, string]>, what: string): Promise<string> {
      const code = await errorCode(response);
      if (!allowed.some(([status, c]) => response.status === status && code === c)) {
        throw new Error(`${what}: ${response.status} ${code ?? "no error code"}, expected ${allowed.map((a) => a.join(" ")).join(" or ")}`);
      }
      return `${response.status} ${code}`;
    }
    const absent: [number, string] = [501, "not-implemented"];
    const unknown: [number, string] = [404, "not-found"];

    await check("publish of an unknown id: refused", async () =>
      expectCode(await send("POST", `/content/${PROBE_ID}/publish`, { expectedVersion: STALE_VERSION, changeId: probe() }), [unknown, [409, "version-conflict"]], "publish"));

    await check("publish with a future publishedAt: refused, or not implemented where the site cannot set the date", async () =>
      expectCode(
        await send("POST", `/content/${PROBE_ID}/publish`, { expectedVersion: STALE_VERSION, changeId: probe(), publishedAt: "2999-01-01T00:00:00Z" }),
        [caps.contentPublishedAt ? [400, "invalid"] : absent],
        "future publishedAt",
      ));

    const writes: Array<[string, boolean | undefined, unknown]> = [
      ["rename", caps.contentRename, { newId: `${PROBE_ID}-renamed`, expectedVersion: STALE_VERSION }],
      ["trash", caps.contentTrash, { expectedVersion: STALE_VERSION }],
      ["restore", caps.contentTrash, { expectedVersion: STALE_VERSION }],
    ];
    for (const [route, offered, body] of writes) {
      await check(`content ${route} of an unknown id: refused, or not implemented where the site lacks it`, async () =>
        expectCode(await send("POST", `/content/${PROBE_ID}/${route}`, { ...(body as object), changeId: probe() }), [offered ? unknown : absent], `content ${route}`));
    }

    await check("preview link for an unknown id: refused, or not implemented where the site has none", async () =>
      expectCode(await send("POST", "/preview-links", { id: PROBE_ID, changeId: probe() }), [caps.previewLinks ? unknown : absent], "preview link"));

    if (caps.replay) {
      await check("replay: a stale write sent twice under one change id answers the same 409 twice", async () => {
        const body = { source: "# Conformance probe\n", expectedVersion: STALE_VERSION, changeId: probe() };
        const [first, second] = [await send("PUT", `/content/${PROBE_ID}/draft`, body), await send("PUT", `/content/${PROBE_ID}/draft`, body)];
        expectStatus(first, 409, "first");
        expectStatus(second, 409, "retry");
        const [a, b] = [await first.text(), await second.text()];
        if (a !== b) throw new Error("the retry answered a different body");
        if (second.headers.get("idempotent-replayed") !== "true") throw new Error("the retry does not say Idempotent-Replayed: true");
        return "409 twice, the second replayed";
      });
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
    for (const filter of missing) expectStatus(await doFetch(`${origin}${PREFIX}/content?${probes[filter]}&limit=1`, { headers: auth }), 501, `filter ${filter}`);
    return missing.length > 0 ? `501 for ${missing.join(", ")}` : "the site offers every filter";
  });

  return { ok: checks.every((c) => c.ok), checks };
}
