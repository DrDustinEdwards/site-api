// The suite passes on the reference adapter and fails, by name, on each planted defect.

import { describe, expect, it } from "vitest";
import { createSiteApi } from "../src/index.js";
import { runConformance } from "../src/conformance.js";
import { memoryAdapter } from "../src/testing.js";
import { KEY, ORIGIN, allow, site } from "./helpers.js";

function failing(report: Awaited<ReturnType<typeof runConformance>>) {
  return report.checks.filter((c) => !c.ok).map((c) => c.name);
}

describe("conformance", () => {
  it("passes a conforming site", async () => {
    const report = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: site().fetch });
    expect(failing(report)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks).toHaveLength(7);
  });

  it("changes nothing on a conforming site", async () => {
    const s = site();
    await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: s.fetch });
    expect(s.adapter.store.size).toBe(0);
  });

  it("PLANT: fails a site that ignores expectedVersion", async () => {
    const adapter = memoryAdapter();
    const save = adapter.content.saveDraft;
    adapter.content.saveDraft = (id, input) => save(id, { ...input, expectedVersion: null });
    const report = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: site(adapter).fetch });
    expect(failing(report)).toEqual(["stale expectedVersion: refused"]);
  });

  it("PLANT: fails a site that serves the key off its prefix", async () => {
    const api = createSiteApi({ adapter: memoryAdapter(), key: KEY, limiter: allow });
    const leaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.startsWith("/api/carrel/")) {
        // The defect: rewrites any version to v1, so the key reaches beyond the prefix.
        const url = new URL(request.url);
        url.pathname = url.pathname.replace(/^\/api\/carrel\/[^/]+/, "/api/carrel/v1");
        return api.handle(new Request(url, request));
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const report = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: leaky });
    expect(failing(report)).toEqual(["key off-prefix: not served"]);
  });

  it("PLANT: fails a site on a different contract", async () => {
    const s = site();
    const drifted = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await s.fetch(input, init);
      if (!new URL(new Request(input).url).pathname.endsWith("/meta") || !response.ok) return response;
      const meta = await response.json();
      return Response.json({ ...meta, schemaHash: "0".repeat(64), packageVersion: "0.0.9" });
    }) as typeof fetch;
    const report = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: drifted });
    expect(failing(report)).toEqual(["meta: answers with this contract's schema hash"]);
  });

  it("PLANT: fails a site with the wrong key configured", async () => {
    const report = await runConformance({ baseUrl: ORIGIN, key: `${KEY}-other`, fetch: site().fetch });
    expect(failing(report)).toContain("meta: answers with this contract's schema hash");
    expect(report.ok).toBe(false);
  });

  it("skips the write probe when told to", async () => {
    const report = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: site().fetch, probeWrites: false });
    expect(report.checks.map((c) => c.name)).not.toContain("stale expectedVersion: refused");
  });
});

describe("schema hash", () => {
  it("is stable across calls and is 64 hex characters", async () => {
    const { schemaHash } = await import("../src/contract.js");
    const [a, b] = await Promise.all([schemaHash(), schemaHash()]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
