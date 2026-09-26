// The conformance suite: what Carrel's health check runs against a live site. Each check names what
// it proves. The one write it sends must be refused, so a conforming site is never changed by it.

import { ContentList, ErrorBody, Meta, PREFIX, schemaHash } from "./contract.js";

export interface ConformanceConfig {
  baseUrl: string;
  key: string;
  fetch?: typeof fetch;
  /** Sends the stale-version write. On by default; a conforming site refuses it and changes nothing. */
  probeWrites?: boolean;
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

  await check("meta: answers with this contract's schema hash", async () => {
    const response = await doFetch(`${origin}${PREFIX}/meta`, { headers: auth });
    expectStatus(response, 200, "meta");
    const meta = Meta.parse(await response.json());
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

  return { ok: checks.every((c) => c.ok), checks };
}
