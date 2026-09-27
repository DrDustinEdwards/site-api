// The conformance suite: what Carrel's health check runs against a live site. Each check names what
// it proves. Every write it sends by default must be refused, so a conforming site is never changed
// by it. The one exception is opt-in (probeMediaUpload): it uploads a file of its own, then deletes
// that file and no other.

import { ContentList, ErrorBody, MediaDeleteResult, MediaDetail, MediaItem, MediaList, Meta, PREFIX, schemaHash, type Meta as MetaType } from "./contract.js";

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

  return { ok: checks.every((c) => c.ok), checks };
}
