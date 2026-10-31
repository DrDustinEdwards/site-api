// v0.17.0: shareable preview links, made under the key and opened by anyone with the address, on a site with a store.

import { describe, expect, it } from "vitest";
import { createSiteClient } from "../src/client.js";
import { createSiteApi } from "../src/index.js";
import { d1SiteApiStore, SITE_API_STORE_SQL } from "../src/store.js";
import { memoryAdapter } from "../src/testing.js";
import { d1 } from "./d1.js";
import { KEY, ORIGIN, allow } from "./helpers.js";

function mounted(withStore = true) {
  const adapter = memoryAdapter({ site: { id: "memory", name: "Memory site", origin: ORIGIN } });
  const api = createSiteApi({ adapter, key: KEY, limiter: allow, log: () => {}, ...(withStore ? { store: d1SiteApiStore(d1(SITE_API_STORE_SQL)) } : {}) });
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (api.matchesPreviewLink(request)) return api.servePreviewLink(request);
    return api.handle(request);
  }) as typeof globalThis.fetch;
  return { fetch, c: createSiteClient({ baseUrl: ORIGIN, key: KEY, fetch }) };
}

describe("preview links (v0.17.0)", () => {
  it("serves the current source to anyone with the link, never indexed, until it is revoked; unknown and revoked links say so", async () => {
    const { fetch, c } = mounted();
    expect((await c.meta()).capabilities.previewLinks).toBe(true);
    await c.saveDraft("a", { source: "# First\n", expectedVersion: null, changeId: "c1" });
    await expect(c.previewLinks.create({ id: "missing", changeId: "c2" })).rejects.toMatchObject({ status: 404 });

    const link = await c.previewLinks.create({ id: "a", expiresInHours: 720, changeId: "c3" });
    // v0.19.0: up to 30 days, said in the answer; more is refused.
    expect(Date.parse(link.expiresAt) - Date.now()).toBeGreaterThan(719 * 3600_000);
    await expect(c.previewLinks.create({ id: "a", expiresInHours: 721, changeId: "c3b" })).rejects.toMatchObject({ status: 400 });
    expect(link.url).toBe(`${ORIGIN}/preview/${link.token}`);
    const doc = await c.get("a");
    await c.saveDraft("a", { source: "# Second\n", expectedVersion: doc.version, changeId: "c4" });

    const open = await fetch(link.url);
    expect(open.status).toBe(200);
    expect(await open.text()).toContain("Second");
    expect(open.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(open.headers.get("cache-control")).toBe("private, no-store");
    expect(open.headers.get("referrer-policy")).toBe("no-referrer");
    // v0.19.0: a HEAD meets the same answer, noindex included, with no body.
    const head = await fetch(link.url, { method: "HEAD" });
    expect([head.status, head.headers.get("x-robots-tag"), await head.text()]).toEqual([200, "noindex, nofollow", ""]);

    const [listed] = (await c.previewLinks.list("a")).items;
    await c.previewLinks.revoke(listed!.id, { changeId: "c5" });
    // v0.19.0: a revoked link is as if it never was.
    expect((await fetch(link.url)).status).toBe(404);
    expect((await c.previewLinks.list("a")).items).toEqual([]);
    const unknown = await fetch(`${ORIGIN}/preview/${"x".repeat(43)}`);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("answers 501 under the key and 404 for every link on a site with no store", async () => {
    const { fetch, c } = mounted(false);
    await expect(c.previewLinks.create({ id: "a", changeId: "c1" })).rejects.toMatchObject({ status: 501 });
    expect((await fetch(`${ORIGIN}/preview/${"x".repeat(43)}`)).status).toBe(404);
  });
});
