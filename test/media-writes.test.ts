// Media writes (v0.4.0): alt, tags, trash, restore, empty trash and the bulk route. Each write is
// versioned; each refusal is checked together with the fact that nothing changed.

import { describe, expect, it } from "vitest";
import { createSiteClient, SiteApiError } from "../src/client.js";
import { memoryAdapter } from "../src/testing.js";
import { KEY, ORIGIN, body, req, site } from "./helpers.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function setup(options: Parameters<typeof memoryAdapter>[0] = {}) {
  const s = site(memoryAdapter(options));
  const client = createSiteClient({ baseUrl: ORIGIN, key: KEY, fetch: s.fetch });
  const add = (filename: string) => client.media.upload({ bytes: PNG, contentType: "image/png", filename, alt: "first", changeId: `up-${filename.replace(/[^A-Za-z0-9]/g, "")}` });
  return { ...s, client, add };
}

async function refused(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SiteApiError);
  return error as SiteApiError;
}

describe("alt text", () => {
  it("changes the alt, moves the version, and refuses the old version after", async () => {
    const { client, add, adapter } = setup();
    const file = await add("a.png");
    expect(file.version).toBeTruthy();
    const done = await client.media.setAlt(file.id, { alt: "A river at dusk", expectedVersion: file.version!, changeId: "c1" });
    expect(done).toEqual({ id: file.id, version: expect.any(String), changeId: "c1" });
    expect(done.version).not.toBe(file.version);
    expect(adapter.mediaStore.get(file.id)?.item.alt).toBe("A river at dusk");
    expect((await client.media.get(file.id)).version).toBe(done.version);

    const stale = await refused(client.media.setAlt(file.id, { alt: "Lost update", expectedVersion: file.version!, changeId: "c2" }));
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: "version-conflict", currentVersion: done.version });
    expect(adapter.mediaStore.get(file.id)?.item.alt).toBe("A river at dusk");
  });

  it("answers 404 for a missing file and 400 for a malformed body", async () => {
    const { client, fetch } = setup();
    expect((await refused(client.media.setAlt("nope.png", { alt: "x", expectedVersion: "m1", changeId: "c" }))).status).toBe(404);
    const bad = await fetch(req("/api/carrel/v1/media/nope.png/alt", { method: "PUT", ...body({ alt: 7, expectedVersion: "m1", changeId: "c" }) }));
    expect(bad.status).toBe(400);
  });
});

describe("tags", () => {
  it("stores the set sorted and without duplicates, and filters the list by tag", async () => {
    const { client, add } = setup();
    const a = await add("a.png");
    const b = await add("b.png");
    const done = await client.media.setTags(a.id, { tags: ["river", "dusk", "river"], expectedVersion: a.version!, changeId: "c1" });
    expect((await client.media.get(a.id)).tags).toEqual(["dusk", "river"]);
    expect((await client.media.list({ tag: "dusk" })).items.map((i) => i.id)).toEqual([a.id]);
    expect((await client.media.list({ tag: "nothing" })).items).toEqual([]);
    expect(done.version).not.toBe(a.version);
    expect((await client.media.get(b.id)).tags).toEqual([]);
  });

  it("refuses a stale version, a badly spelled tag and more than 12 tags, changing nothing", async () => {
    const { client, add, adapter, fetch } = setup();
    const a = await add("a.png");
    await client.media.setTags(a.id, { tags: ["one"], expectedVersion: a.version!, changeId: "c1" });
    expect((await refused(client.media.setTags(a.id, { tags: ["two"], expectedVersion: a.version!, changeId: "c2" }))).status).toBe(409);
    expect(adapter.mediaStore.get(a.id)?.item.tags).toEqual(["one"]);
    const current = adapter.mediaStore.get(a.id)!.item.version!;
    for (const tags of [["Upper Case"], Array.from({ length: 13 }, (_, i) => `t${i}`)]) {
      const response = await fetch(req(`/api/carrel/v1/media/${encodeURIComponent(a.id)}/tags`, { method: "PUT", ...body({ tags, expectedVersion: current, changeId: "c3" }) }));
      expect(response.status).toBe(400);
    }
    expect(adapter.mediaStore.get(a.id)?.item.tags).toEqual(["one"]);
  });
});

describe("trash, restore and empty", () => {
  it("hides a trashed file from the list, shows it in the trash, and brings it back on restore", async () => {
    const { client, add, adapter } = setup();
    const a = await add("a.png");
    const trashed = await client.media.trash(a.id, { expectedVersion: a.version!, changeId: "c1" });
    expect((await client.media.list()).items).toEqual([]);
    const inTrash = (await client.media.list({ trashed: "only" })).items;
    expect(inTrash.map((i) => i.id)).toEqual([a.id]);
    expect(inTrash[0]?.trashedAt).toEqual(expect.any(String));
    expect(adapter.mediaStore.has(a.id)).toBe(true);
    expect(adapter.deleted).toEqual([]);

    expect((await refused(client.media.restore(a.id, { expectedVersion: a.version!, changeId: "c2" }))).status).toBe(409);
    const restored = await client.media.restore(a.id, { expectedVersion: trashed.version, changeId: "c3" });
    expect(restored.version).not.toBe(trashed.version);
    expect((await client.media.list()).items.map((i) => i.id)).toEqual([a.id]);
    expect((await client.media.list({ trashed: "only" })).items).toEqual([]);
  });

  it("empties the trash for good and leaves the library alone", async () => {
    const { client, add, adapter } = setup();
    const keep = await add("keep.png");
    const a = await add("a.png");
    const b = await add("b.png");
    await client.media.trash(a.id, { expectedVersion: a.version!, changeId: "t1" });
    await client.media.trash(b.id, { expectedVersion: b.version!, changeId: "t2" });
    const result = await client.media.emptyTrash({ changeId: "empty1" });
    expect(result.changeId).toBe("empty1");
    expect([...result.deleted].sort()).toEqual([a.id, b.id].sort());
    expect(result).toMatchObject({ refused: [], more: false });
    expect([...adapter.mediaStore.keys()]).toEqual([keep.id]);
    expect([...adapter.deleted].sort()).toEqual([a.id, b.id].sort());
    expect((await client.media.emptyTrash({ changeId: "empty2" })).deleted).toEqual([]);
  });

  it("keeps a trashed file a post still uses, and names the post", async () => {
    const { client, add, adapter } = setup();
    const used = await add("used.png");
    const spare = await add("spare.png");
    await adapter.content.saveDraft("a-post", { source: `# T\n\n![x](${used.url})\n`, expectedVersion: null, changeId: "d1" });
    await client.media.trash(used.id, { expectedVersion: used.version!, changeId: "t1" });
    await client.media.trash(spare.id, { expectedVersion: spare.version!, changeId: "t2" });
    const result = await client.media.emptyTrash({ changeId: "e" });
    expect(result.deleted).toEqual([spare.id]);
    expect(result.refused).toHaveLength(1);
    expect(result.refused[0]).toMatchObject({ id: used.id, usedBy: [expect.objectContaining({ type: "post", id: "a-post" })] });
    expect(adapter.mediaStore.has(used.id)).toBe(true);
  });

  it("deletes at most 100 per request and says when more remain", async () => {
    const { client, adapter } = setup();
    for (let i = 0; i < 102; i++) {
      const f = await client.media.upload({ bytes: PNG, contentType: "image/png", filename: `f${i}.png`, changeId: `u${i}` });
      await client.media.trash(f.id, { expectedVersion: f.version!, changeId: `t${i}` });
    }
    const first = await client.media.emptyTrash({ changeId: "e1" });
    expect(first.deleted).toHaveLength(100);
    expect(first.more).toBe(true);
    const second = await client.media.emptyTrash({ changeId: "e2" });
    expect(second.more).toBe(false);
    expect(second.deleted).toHaveLength(2);
    expect(adapter.mediaStore.size).toBe(0);
  });

  it("gives each deleted file its own change id, built from the request's", async () => {
    const { client, add, adapter } = setup();
    const seen: string[] = [];
    const del = adapter.media!.delete;
    adapter.media!.delete = (id, input) => {
      seen.push(input.changeId);
      return del(id, input);
    };
    for (const name of ["a.png", "b.png"]) {
      const f = await add(name);
      await client.media.trash(f.id, { expectedVersion: f.version!, changeId: `t-${name.slice(0, 1)}` });
    }
    await client.media.emptyTrash({ changeId: "base" });
    expect(seen).toEqual(["base-1", "base-2"]);
  });
});

describe("bulk", () => {
  it("applies the op to every file and reports each file on its own", async () => {
    const { client, add, adapter } = setup();
    const a = await add("a.png");
    const b = await add("b.png");
    const result = await client.media.bulk({
      op: "trash",
      items: [
        { id: a.id, expectedVersion: a.version!, changeId: "b1" },
        { id: b.id, expectedVersion: "stale", changeId: "b2" },
        { id: "ghost.png", expectedVersion: "m1", changeId: "b3" },
        { id: a.id, changeId: "b4" },
      ],
    });
    expect(result.op).toBe("trash");
    expect(result.results).toEqual([
      { ok: true, id: a.id, changeId: "b1", version: expect.any(String) },
      { ok: false, id: b.id, changeId: "b2", error: "version-conflict", message: expect.any(String), currentVersion: b.version },
      { ok: false, id: "ghost.png", changeId: "b3", error: "not-found", message: expect.any(String) },
      { ok: false, id: a.id, changeId: "b4", error: "invalid", message: expect.any(String) },
    ]);
    expect(adapter.mediaStore.get(a.id)?.item.trashedAt).toEqual(expect.any(String));
    expect(adapter.mediaStore.get(b.id)?.item.trashedAt).toBeNull();
  });

  it("adds and removes tags from each file's current set, and refuses past 12 for that file alone", async () => {
    const { client, add, adapter } = setup();
    const a = await add("a.png");
    const b = await add("b.png");
    const a2 = await client.media.setTags(a.id, { tags: ["keep", "old"], expectedVersion: a.version!, changeId: "s1" });
    const added = await client.media.bulk({
      op: "add-tags",
      tags: ["new"],
      items: [
        { id: a.id, expectedVersion: a2.version, changeId: "b1" },
        { id: b.id, expectedVersion: b.version!, changeId: "b2" },
      ],
    });
    expect(added.results.every((r) => r.ok)).toBe(true);
    expect(adapter.mediaStore.get(a.id)?.item.tags).toEqual(["keep", "new", "old"]);
    expect(adapter.mediaStore.get(b.id)?.item.tags).toEqual(["new"]);

    const va = adapter.mediaStore.get(a.id)!.item.version!;
    const removed = await client.media.bulk({ op: "remove-tags", tags: ["old", "absent"], items: [{ id: a.id, expectedVersion: va, changeId: "b3" }] });
    expect(removed.results[0]?.ok).toBe(true);
    expect(adapter.mediaStore.get(a.id)?.item.tags).toEqual(["keep", "new"]);

    const full = await client.media.setTags(b.id, {
      tags: Array.from({ length: 12 }, (_, i) => `t${i}`),
      expectedVersion: adapter.mediaStore.get(b.id)!.item.version!,
      changeId: "s2",
    });
    const over = await client.media.bulk({
      op: "add-tags",
      tags: ["extra"],
      items: [
        { id: b.id, expectedVersion: full.version, changeId: "b4" },
        { id: a.id, expectedVersion: adapter.mediaStore.get(a.id)!.item.version!, changeId: "b5" },
      ],
    });
    expect(over.results.map((r) => r.ok)).toEqual([false, true]);
    expect(over.results[0]).toMatchObject({ error: "refused" });
    expect(adapter.mediaStore.get(b.id)?.item.tags).toHaveLength(12);
  });

  it("deletes through the site's reference check without a version, and names a refusal", async () => {
    const { client, add, adapter } = setup();
    const a = await add("a.png");
    const used = await add("used.png");
    await adapter.content.saveDraft("a-post", { source: `![x](${used.url})\n`, expectedVersion: null, changeId: "d1" });
    const result = await client.media.bulk({
      op: "delete",
      items: [
        { id: a.id, changeId: "d1" },
        { id: used.id, changeId: "d2" },
        { id: "ghost.png", changeId: "d3" },
      ],
    });
    expect(result.results.map((r) => r.ok)).toEqual([true, false, false]);
    expect(result.results[1]).toMatchObject({ error: "refused", usedBy: [expect.objectContaining({ id: "a-post" })] });
    expect(result.results[2]).toMatchObject({ error: "not-found" });
    expect(adapter.deleted).toEqual([a.id]);
    expect(adapter.mediaStore.has(used.id)).toBe(true);
  });

  it("rejects a tag op with no tags, more than 100 files and an empty list as 400, running nothing", async () => {
    const { fetch, adapter } = setup();
    const item = { id: "a.png", expectedVersion: "m1", changeId: "c" };
    const many = Array.from({ length: 101 }, (_, i) => ({ ...item, changeId: `c${i}` }));
    const payloads = [
      { op: "add-tags", items: [item] },
      { op: "add-tags", tags: [], items: [item] },
      { op: "trash", items: many },
      { op: "trash", items: [] },
      { op: "explode", items: [item] },
    ];
    for (const payload of payloads) {
      expect((await fetch(req("/api/carrel/v1/media/bulk", { method: "POST", ...body(payload) }))).status).toBe(400);
    }
    expect(adapter.mediaStore.size).toBe(0);
  });
});

describe("a site without the writes", () => {
  it("answers 501 to each route whatever the body says, and declares none of the capabilities", async () => {
    const { client, fetch, adapter } = setup({ mediaWrites: false });
    const caps = (await client.meta()).capabilities;
    expect(caps.media).toBe(true);
    expect(caps.mediaAlt ?? false).toBe(false);
    expect(caps.mediaTags ?? false).toBe(false);
    expect(caps.mediaTrash ?? false).toBe(false);
    const stale = { expectedVersion: "m1", changeId: "c" };
    const calls: Array<[string, string, unknown]> = [
      ["PUT", "alt", { alt: "x", ...stale }],
      ["PUT", "tags", { tags: ["x"], ...stale }],
      ["POST", "trash", stale],
      ["POST", "restore", stale],
    ];
    for (const [method, route, payload] of calls) {
      const response = await fetch(req(`/api/carrel/v1/media/a.png/${route}`, { method, ...body(payload) }));
      expect(response.status, route).toBe(501);
    }
    const posts: Array<[string, unknown]> = [
      ["/media/trash/empty", { changeId: "c" }],
      ["/media/bulk", { op: "trash", items: [{ id: "a.png", ...stale }] }],
      ["/media/bulk", { op: "add-tags", tags: ["x"], items: [{ id: "a.png", ...stale }] }],
    ];
    for (const [path, payload] of posts) {
      expect((await fetch(req(`/api/carrel/v1${path}`, { method: "POST", ...body(payload) }))).status, path).toBe(501);
    }
    expect(adapter.mediaStore.size).toBe(0);
  });

  it("still allows a bulk delete, which needs only the delete every media site has", async () => {
    const { client, add, adapter } = setup({ mediaWrites: false });
    const a = await add("a.png");
    expect((await client.media.bulk({ op: "delete", items: [{ id: a.id, changeId: "d" }] })).results[0]?.ok).toBe(true);
    expect(adapter.deleted).toEqual([a.id]);
  });

  it("a site with trash but no tags refuses tag ops with 501 and allows trash ops", async () => {
    const { client, add, adapter } = setup();
    delete (adapter.media as { setTags?: unknown }).setTags;
    const caps = (await client.meta()).capabilities;
    expect(caps).toMatchObject({ mediaTrash: true, mediaAlt: true });
    expect(caps.mediaTags ?? false).toBe(false);
    const f = await add("a.png");
    const input = { id: f.id, expectedVersion: f.version!, changeId: "c" };
    expect((await refused(client.media.bulk({ op: "add-tags", tags: ["x"], items: [input] }))).status).toBe(501);
    expect((await client.media.bulk({ op: "trash", items: [input] })).results[0]?.ok).toBe(true);
  });
});
