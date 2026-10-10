// v0.6.0's list additions for media and mentions: media lenses, sort and total, and mention search
// and the one-post filter, each echoed so a caller can tell a site that did them from one that did not.

import { describe, expect, it, vi } from "vitest";
import { createSiteClient } from "../src/client.js";
import { memoryAdapter, type MemoryAdapterOptions } from "../src/testing.js";
import { KEY, ORIGIN, req, site } from "./helpers.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function client(options: MemoryAdapterOptions = {}) {
  const adapter = memoryAdapter(options);
  const s = site(adapter);
  return { adapter, api: s.api, client: createSiteClient({ baseUrl: ORIGIN, key: KEY, fetch: s.fetch }) };
}

describe("media lenses and sort (v0.6.0)", () => {
  it("answers each lens with the files it names, the total across pages, and the order it applied", async () => {
    const { adapter, client: c } = client();
    const used = await c.media.upload({ bytes: PNG, contentType: "image/png", filename: "used.png", alt: "In a post", changeId: "u1" });
    const bare = await c.media.upload({ bytes: PNG, contentType: "image/png", filename: "bare.png", changeId: "u2" });
    await c.saveDraft("p", { source: `# P\n![x](/media/${used.id})\n`, expectedVersion: null, changeId: "c1" });
    adapter.mediaStore.get(used.id)!.item.bytes = 2 * 1024 * 1024;
    expect((await c.media.list({ lens: "unattached" })).items.map((i) => i.id)).toEqual([bare.id]);
    expect((await c.media.list({ lens: "no-alt" })).items.map((i) => i.id)).toEqual([bare.id]);
    expect((await c.media.list({ lens: "large" })).items.map((i) => i.id)).toEqual([used.id]);
    const bySize = await c.media.list({ sort: "size", limit: 1 });
    expect(bySize).toMatchObject({ items: [{ id: used.id }], total: 2, sorted: { sort: "size", dir: "desc" } });
    expect((await c.media.list({ sort: "name", dir: "desc" })).items.map((i) => i.filename)).toEqual(["used.png", "bare.png"]);
    expect((await c.meta()).capabilities.mediaLenses).toEqual(["unattached", "no-alt", "large"]);
  });

  it("PLANT: answers a lens the site does not name with 501, and an unknown lens or sort with 400, before the adapter", async () => {
    const { adapter, api } = client({ mediaLenses: false });
    const spy = vi.spyOn(adapter.media!, "list");
    expect((await api.handle(req("/api/carrel/v1/media?lens=no-alt"))).status).toBe(501);
    for (const q of ["lens=pretty", "sort=colour", "dir=up"]) expect((await api.handle(req(`/api/carrel/v1/media?${q}`))).status, q).toBe(400);
    expect(spy).not.toHaveBeenCalled();
    expect((await api.handle(req("/api/carrel/v1/media"))).status).toBe(200);
  });
});

describe("mention search and the one-post filter (v0.6.0)", () => {
  it("filters by words and by post, keeps the whole queue's counts, and echoes what it applied", async () => {
    const { adapter, client: c } = client();
    adapter.receiveMention({ sourceUrl: "https://a.example/1", targetId: "post-a", authorName: "Ada" });
    adapter.receiveMention({ sourceUrl: "https://b.example/2", targetId: "post-b", excerpt: "ada wrote this" });
    adapter.receiveMention({ sourceUrl: "https://c.example/3", targetId: "post-a" });
    const byWord = await c.mentions.list({ q: "ADA" });
    expect(byWord.items.map((m) => m.sourceUrl)).toEqual(["https://b.example/2", "https://a.example/1"]);
    expect(byWord.filtered).toEqual({ q: "ADA" });
    expect(byWord.counts.pending).toBe(3);
    const byPost = await c.mentions.list({ targetId: "post-a", q: "ada" });
    expect(byPost.items.map((m) => m.sourceUrl)).toEqual(["https://a.example/1"]);
    expect(byPost.filtered).toEqual({ q: "ada", targetId: "post-a" });
    expect((await c.mentions.list()).filtered).toBeUndefined();
  });

  it("PLANT: refuses a search too long or an empty post id before the adapter", async () => {
    const { adapter, api } = client();
    const spy = vi.spyOn(adapter.mentions!, "list");
    for (const q of [`q=${"x".repeat(201)}`, "targetId="]) expect((await api.handle(req(`/api/carrel/v1/mentions?${q}`))).status, q).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });
});
