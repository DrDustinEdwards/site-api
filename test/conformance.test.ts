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
  it("passes a conforming site, with the media checks when it offers media", async () => {
    const report = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: site().fetch });
    expect(failing(report)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name).slice(11)).toEqual([
      "media: upload limits declared",
      "media list: answers in the contract's shape",
      "media delete of an unknown id: refused",
      "media upload of a type the site does not accept: refused",
      "media alt of an unknown id: refused, or not implemented where the site lacks it",
      "media tags of an unknown id: refused, or not implemented where the site lacks it",
      "media trash of an unknown id: refused, or not implemented where the site lacks it",
      "media restore of an unknown id: refused, or not implemented where the site lacks it",
      "media alt with a body outside the contract: refused, or not implemented where the site lacks it",
      "media bulk: an unknown id is that file's own not-found, and the request answers 200",
      "media bulk tag op with no tags: refused, or not implemented where the site lacks tags",
      "media empty trash with a body outside the contract: refused, or not implemented where the site has no trash",
    ]);
  });

  it("runs only the content checks on a site with no media manager", async () => {
    const report = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: site(memoryAdapter({ media: false })).fetch });
    expect(failing(report)).toEqual([]);
    expect(report.checks).toHaveLength(11);
  });

  it("expects 501 on a site with no content delete, and 404 where it has one", async () => {
    const without = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: site(memoryAdapter({ contentDelete: false })).fetch });
    expect(failing(without)).toEqual([]);
    expect(without.checks.find((c) => c.name.startsWith("content delete of an unknown id"))?.detail).toBe("501 not-implemented");
    const withDelete = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: site().fetch });
    expect(withDelete.checks.find((c) => c.name.startsWith("content delete of an unknown id"))?.detail).toBe("404 not-found");
  });

  it("PLANT: fails a site that answers a delete of an item it does not hold as done", async () => {
    const adapter = memoryAdapter();
    adapter.content.delete = async () => {};
    const report = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: site(adapter).fetch });
    expect(failing(report)).toEqual(["content delete of an unknown id: refused, or not implemented where the site has no delete"]);
  });

  it("PLANT: fails a site that offers a delete but does not say so in its capabilities", async () => {
    const s = site();
    const silent = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await s.fetch(input, init);
      if (!new URL(new Request(input).url).pathname.endsWith("/meta") || !response.ok) return response;
      const meta = await response.json();
      const { contentDelete: _gone, ...capabilities } = meta.capabilities;
      return Response.json({ ...meta, capabilities });
    }) as typeof fetch;
    const report = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: silent });
    expect(failing(report)).toEqual(["content delete of an unknown id: refused, or not implemented where the site has no delete"]);
  });

  it("changes nothing on a conforming site: no content, no file stored, no file deleted", async () => {
    const s = site();
    await s.adapter.media!.upload({ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), contentType: "image/png", filename: "real.png", alt: "", changeId: "seed" });
    await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: s.fetch });
    expect(s.adapter.store.size).toBe(0);
    expect(s.adapter.deletedContent).toEqual([]);
    expect([...s.adapter.mediaStore.keys()]).toEqual(["uploads/1-real.png"]);
    expect(s.adapter.deleted).toEqual([]);
  });

  it("with probeMediaUpload, uploads a file of its own and deletes that file and no other", async () => {
    const s = site();
    await s.adapter.media!.upload({ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), contentType: "image/png", filename: "real.png", alt: "", changeId: "seed" });
    const report = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: s.fetch, probeMediaUpload: true });
    expect(failing(report)).toEqual([]);
    expect(report.checks.at(-1)).toMatchObject({ name: "media round trip: upload, read, delete its own file", ok: true });
    expect([...s.adapter.mediaStore.keys()]).toEqual(["uploads/1-real.png"]);
    expect(s.adapter.deleted).toEqual(["uploads/2-carrel-conformance-probe.png"]);
  });

  it("PLANT: fails a site that accepts a type it never declared", async () => {
    const s = site(memoryAdapter({ media: { maxBytes: 1000, types: ["image/png", "application/x-carrel-conformance-probe"] } }));
    const report = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: s.fetch });
    expect(failing(report)).toEqual(["media upload of a type the site does not accept: refused"]);
  });

  it("PLANT: fails a site that answers a delete of a file it does not hold as done", async () => {
    const adapter = memoryAdapter();
    adapter.media!.delete = async () => {};
    const report = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: site(adapter).fetch });
    expect(failing(report)).toEqual(["media delete of an unknown id: refused"]);
  });

  it("expects 501 from every media write on a v0.2.0 site, and passes it", async () => {
    const report = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: site(memoryAdapter({ mediaWrites: false })).fetch });
    expect(failing(report)).toEqual([]);
    const details = report.checks.filter((c) => /^media (alt|tags|trash|restore|bulk|empty)/.test(c.name)).map((c) => c.detail);
    expect(details).toHaveLength(8);
    expect(details.every((d) => d.startsWith("501"))).toBe(true);
  });

  it("PLANT: fails a site whose alt write accepts a stale version on a file it does not hold", async () => {
    const adapter = memoryAdapter();
    adapter.media!.setAlt = async () => ({ version: "x" });
    const report = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: site(adapter).fetch });
    expect(failing(report)).toEqual(["media alt of an unknown id: refused, or not implemented where the site lacks it"]);
  });

  it("PLANT: fails a site that offers a trash but does not say so in its capabilities", async () => {
    const s = site();
    const silent = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await s.fetch(input, init);
      if (!new URL(new Request(input).url).pathname.endsWith("/meta") || !response.ok) return response;
      const meta = await response.json();
      const { mediaTrash: _gone, ...capabilities } = meta.capabilities;
      return Response.json({ ...meta, capabilities });
    }) as typeof fetch;
    const report = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: silent });
    expect(failing(report)).toEqual([
      "media trash of an unknown id: refused, or not implemented where the site lacks it",
      "media restore of an unknown id: refused, or not implemented where the site lacks it",
      "media bulk: an unknown id is that file's own not-found, and the request answers 200",
      "media empty trash with a body outside the contract: refused, or not implemented where the site has no trash",
    ]);
  });

  it("changes no file on a conforming site when the write probes run", async () => {
    const s = site();
    const item = await s.adapter.media!.upload({ bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), contentType: "image/png", filename: "real.png", alt: "kept", changeId: "seed" });
    await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: s.fetch });
    expect(s.adapter.mediaStore.get(item.id)?.item).toEqual(item);
  });

  it("PLANT: fails a site that offers media without declaring its limits", async () => {
    const s = site();
    const unlimited = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await s.fetch(input, init);
      if (!new URL(new Request(input).url).pathname.endsWith("/meta") || !response.ok) return response;
      const meta = await response.json();
      const { mediaUpload: _gone, ...capabilities } = meta.capabilities;
      return Response.json({ ...meta, capabilities });
    }) as typeof fetch;
    const report = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: unlimited });
    expect(failing(report)).toEqual(["media: upload limits declared"]);
  });

  it("PLANT: fails a site that ignores expectedVersion", async () => {
    const adapter = memoryAdapter();
    const save = adapter.content.saveDraft;
    adapter.content.saveDraft = (id, input) => save(id, { ...input, expectedVersion: null });
    const report = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: site(adapter).fetch });
    expect(failing(report)).toContain("stale expectedVersion: refused");
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
