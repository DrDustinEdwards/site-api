// The conformance suite: what Carrel's health check runs against a live site. Each check names what
// it proves. Every write it sends by default must be refused, so a conforming site is never changed
// by it. The one exception is opt-in (probeMediaUpload): it uploads a file of its own, then deletes
// that file and no other.

import {
  ContentDoc,
  ContentList,
  ErrorBody,
  RevisionList,
  RevisionSource,
  Meta,
  PREFIX,
  schemaHash,
  type Meta as MetaType,
} from "./contract.js";
import { PROBE_ID, STALE_VERSION, type ConformanceContext } from "./conformance/context.js";
import { mediaChecks } from "./conformance/media.js";
import { mentionChecks } from "./conformance/mentions.js";
import { probePost } from "./conformance/probe-post.js";
import { routeChecks } from "./conformance/routes.js";

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
  /**
   * v0.22.0 (M1): makes a probe post of its own under a unique id, takes it through its life, and deletes it, even when a
   * step fails. Beside `probeWrites`, and off by default, since the post is published for a moment: its hooks run, and a
   * feed or a search engine may see it (its `noindex` is set where the site renders one). A site that cannot delete
   * content skips it, since the probe could not clean up after itself.
   */
  probePosts?: boolean;
  /**
   * The source a new post starts from on this site, for its id (what Carrel's New post sends). The probe keeps its front
   * matter, sets its own title and adds its fields, so a site that requires more than a title to create a post is probed
   * with a post it accepts. Absent: a title alone.
   */
  newSource?: (id: string) => string;
  /** True for a site that checks the share image as a whole address (foxing.app); a site-absolute path otherwise (dustinedwards.info refuses a full URL). */
  imageAsUrl?: boolean;
  /** The author the probe post credits, for a site that credits only the names it knows (foxing.app: "Foxing"). "Conformance Probe" by default. */
  author?: string;
  /** How long the probe waits for a hook to record its run, or a purged page to change its answer, in milliseconds. 5000 by default. */
  hookWaitMs?: number;
}

interface ConformanceCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** One probe the run made or passed over (v0.22.0, M2): every check is one, and `skipped` ones say why in `detail`. */
interface ConformanceProbe {
  name: string;
  ok: boolean;
  skipped?: boolean;
  detail?: string;
}

export interface ConformanceReport {
  ok: boolean;
  checks: ConformanceCheck[];
  /** v0.22.0: every probe in the order it ran, and every one passed over, with why. */
  probes: ConformanceProbe[];
}

export async function runConformance(config: ConformanceConfig): Promise<ConformanceReport> {
  const doFetch = config.fetch ?? fetch;
  const origin = config.baseUrl.replace(/\/+$/, "");
  const auth = { authorization: `Bearer ${config.key}` };
  const checks: ConformanceCheck[] = [];
  const probes: ConformanceProbe[] = [];
  const skip = (name: string, why: string) =>
    void probes.push({ name, ok: true, skipped: true, detail: why });
  // v0.17.0: a fresh change id for every probe write, since a site with `replay` keeps a refused write's answer under its
  // change id and would refuse the same id on another probe as a different request.
  const run = crypto.randomUUID().slice(0, 8);
  let sent = 0;
  const probe = () => `conformance-probe-${run}-${++sent}`;

  async function check(name: string, run: () => Promise<string>): Promise<boolean> {
    let result: ConformanceCheck;
    try {
      result = { name, ok: true, detail: await run() };
    } catch (error) {
      result = { name, ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
    checks.push(result);
    probes.push({ ...result });
    return result.ok;
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
    if (response.status !== status)
      throw new Error(`${what}: expected ${status}, got ${response.status}`);
  }

  let meta: MetaType | null = null;

  await check("meta: answers with this contract's schema hash", async () => {
    const response = await doFetch(`${origin}${PREFIX}/meta`, { headers: auth });
    expectStatus(response, 200, "meta");
    meta = Meta.parse(await response.json());
    const ours = await schemaHash();
    if (meta.schemaHash !== ours) {
      throw new Error(
        `schema hash ${meta.schemaHash.slice(0, 12)} is not ${ours.slice(0, 12)} (site on package ${meta.packageVersion})`,
      );
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
    if (code !== "not-found")
      throw new Error(`error code ${code ?? "missing"}, expected not-found`);
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
      if (code !== "version-conflict")
        throw new Error(`error code ${code ?? "missing"}, expected version-conflict`);
      return "409 version-conflict";
    });
  }

  // ---------- v0.3.0: the source at a revision, and the optional content delete

  await check("revision source of an unknown id: not found", async () => {
    const response = await doFetch(
      `${origin}${PREFIX}/content/${PROBE_ID}/revisions/${STALE_VERSION}`,
      { headers: auth },
    );
    expectStatus(response, 404, "unknown revision");
    const code = await errorCode(response);
    if (code !== "not-found")
      throw new Error(`error code ${code ?? "missing"}, expected not-found`);
    return "404 not-found";
  });

  await check("revision source: the newest revision of the first item opens", async () => {
    const list = ContentList.parse(
      await (await doFetch(`${origin}${PREFIX}/content?limit=1`, { headers: auth })).json(),
    );
    const first = list.items[0];
    if (!first) return "no items to read a revision of";
    const revisions = RevisionList.parse(
      await (
        await doFetch(`${origin}${PREFIX}/content/${encodeURIComponent(first.id)}/revisions`, {
          headers: auth,
        })
      ).json(),
    );
    const newest = revisions.items[0];
    if (!newest) return `${first.id} has no revisions`;
    const response = await doFetch(
      `${origin}${PREFIX}/content/${encodeURIComponent(first.id)}/revisions/${encodeURIComponent(newest.version)}`,
      { headers: auth },
    );
    expectStatus(response, 200, "revision source");
    const opened = RevisionSource.parse(await response.json());
    if (opened.version !== newest.version)
      throw new Error(`asked for ${newest.version}, got ${opened.version}`);
    return `${first.id} at ${newest.version}`;
  });

  // The newest revision is the item as it stands: a site that lists only the states before each edit leaves the live
  // version out of Carrel's history (and the name of the client that published it) until the next edit.
  await check("revisions: the newest is the item's current version", async () => {
    const list = ContentList.parse(
      await (await doFetch(`${origin}${PREFIX}/content?limit=1`, { headers: auth })).json(),
    );
    const first = list.items[0];
    if (!first) return "no items to read a revision of";
    const id = encodeURIComponent(first.id);
    const doc = ContentDoc.parse(
      await (await doFetch(`${origin}${PREFIX}/content/${id}`, { headers: auth })).json(),
    );
    const revisions = RevisionList.parse(
      await (await doFetch(`${origin}${PREFIX}/content/${id}/revisions`, { headers: auth })).json(),
    );
    const newest = revisions.items[0]?.version;
    if (newest !== doc.version)
      throw new Error(
        `the newest revision is ${newest ?? "missing"}, the item's version is ${doc.version}`,
      );
    return `${first.id} at ${newest}`;
  });

  if (config.probeWrites !== false) {
    // Only ever the probe id: a site that wrongly accepts one of these deletes nothing real.
    const deleteUrl = `${origin}${PREFIX}/content/${PROBE_ID}?expectedVersion=${STALE_VERSION}&changeId=${probe()}`;
    await check("content delete without a key: refused", async () => {
      expectStatus(await doFetch(deleteUrl, { method: "DELETE" }), 401, "delete without a key");
      expectStatus(
        await doFetch(deleteUrl, {
          method: "DELETE",
          headers: { authorization: `Bearer ${config.key}x` },
        }),
        401,
        "delete with a wrong key",
      );
      return "401";
    });
    await check(
      "content delete of an unknown id: refused, or not implemented where the site has no delete",
      async () => {
        const response = await doFetch(deleteUrl, { method: "DELETE", headers: auth });
        const offered = (meta as MetaType | null)?.capabilities.contentDelete === true;
        expectStatus(
          response,
          offered ? 404 : 501,
          offered ? "unknown content delete" : "content delete on a site without it",
        );
        const code = await errorCode(response);
        const expected = offered ? "not-found" : "not-implemented";
        if (code !== expected)
          throw new Error(`error code ${code ?? "missing"}, expected ${expected}`);
        return offered ? "404 not-found" : "501 not-implemented";
      },
    );
    await check(
      "content tags of an unknown id: refused, or not implemented where the site keeps no tags",
      async () => {
        const response = await doFetch(`${origin}${PREFIX}/content/${PROBE_ID}/tags`, {
          method: "PUT",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({
            tags: ["conformance-probe"],
            expectedVersion: STALE_VERSION,
            changeId: probe(),
          }),
        });
        const offered = (meta as MetaType | null)?.capabilities.contentTags === true;
        expectStatus(
          response,
          offered ? 404 : 501,
          offered ? "unknown content tags" : "content tags on a site without them",
        );
        const code = await errorCode(response);
        const expected = offered ? "not-found" : "not-implemented";
        if (code !== expected)
          throw new Error(`error code ${code ?? "missing"}, expected ${expected}`);
        return offered ? "404 not-found" : "501 not-implemented";
      },
    );
    await check(
      "content transcript of an unknown id: refused, or not implemented where transcripts are read only",
      async () => {
        const response = await doFetch(`${origin}${PREFIX}/content/${PROBE_ID}/transcript`, {
          method: "PUT",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({
            transcript: "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nConformance probe.\n",
            expectedTranscriptVersion: STALE_VERSION,
            changeId: probe(),
          }),
        });
        const offered = (meta as MetaType | null)?.capabilities.contentTranscript === true;
        expectStatus(
          response,
          offered ? 404 : 501,
          offered ? "unknown content transcript" : "content transcript on a site without it",
        );
        const code = await errorCode(response);
        const expected = offered ? "not-found" : "not-implemented";
        if (code !== expected)
          throw new Error(`error code ${code ?? "missing"}, expected ${expected}`);
        return offered ? "404 not-found" : "501 not-implemented";
      },
    );
    await check(
      "schedule read and cancel of an unknown id: refused, or not implemented where the site has no scheduled updates",
      async () => {
        const path = `${origin}${PREFIX}/content/${PROBE_ID}/schedule`;
        const offered = (meta as MetaType | null)?.capabilities.scheduledUpdates === true;
        const expected = offered ? "not-found" : "not-implemented";
        for (const response of [
          await doFetch(path, { headers: auth }),
          await doFetch(`${path}?expectedVersion=${STALE_VERSION}&changeId=${probe()}`, {
            method: "DELETE",
            headers: auth,
          }),
        ]) {
          expectStatus(
            response,
            offered ? 404 : 501,
            offered ? "unknown schedule" : "schedule on a site without scheduled updates",
          );
          const code = await errorCode(response);
          if (code !== expected)
            throw new Error(`error code ${code ?? "missing"}, expected ${expected}`);
        }
        return offered ? "404 not-found" : "501 not-implemented";
      },
    );
  }

  const capabilities = (meta as MetaType | null)?.capabilities;
  const ctx: ConformanceContext = {
    run,
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
  };
  await mediaChecks(ctx);
  await mentionChecks(ctx);
  await routeChecks(ctx);
  await probePost(ctx);

  return { ok: checks.every((c) => c.ok), checks, probes };
}
