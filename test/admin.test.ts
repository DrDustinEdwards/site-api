// The content kit (./admin) and localClient, against the in-memory reference site. A site's own
// admin drives the kit through localClient; Carrel drives it through createSiteClient, which one test
// below runs too, so both hosts meet the same code.

import { describe, expect, it, vi } from "vitest";
import {
  loadMedia,
  loadMentions,
  loadPosts,
  runMediaIntent,
  runMentionsIntent,
  runPostsIntent,
  summary,
  type ContentSource,
  type Permissions,
  type RowNote,
} from "../src/admin.js";
import { createSiteClient, localClient, SiteApiError, type SiteClient } from "../src/client.js";
import { memoryAdapter, type MemoryAdapterOptions } from "../src/testing.js";
import { KEY, ORIGIN, site } from "./helpers.js";

const OWNER: Permissions = { edit: true, publish: true, deleteContent: true, deleteMedia: true, decideMentions: true };
const EDITOR: Permissions = { edit: true, publish: false, deleteContent: false, deleteMedia: false, decideMentions: false };
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function setup(options: MemoryAdapterOptions = {}, extra: Partial<ContentSource> = {}) {
  const adapter = memoryAdapter(options);
  const client = localClient(adapter, { log: () => {} });
  const records: Array<{ kind: string; ids: string[]; changeId: string }> = [];
  const source: ContentSource = {
    site: adapter.site,
    client,
    can: OWNER,
    editorHref: (id) => `/edit/${id}`,
    record: async (change) => {
      records.push(change);
    },
    log: () => {},
    ...extra,
  };
  return { adapter, client, source, records };
}

async function post(client: SiteClient, id: string, front: string, publish = false) {
  const draft = await client.saveDraft(id, { source: `---\n${front}\n---\nBody of ${id}.\n`, expectedVersion: null, changeId: `c-${id}` });
  return publish ? client.publish(id, { expectedVersion: draft.version, changeId: `p-${id}` }) : draft;
}

async function upload(client: SiteClient, name: string) {
  return client.media.upload({ bytes: PNG, contentType: "image/png", filename: name, alt: "", changeId: `u-${name.replace(/\W/g, "")}` });
}

describe("localClient", () => {
  it("answers as the HTTP client does, through the same handler: meta, reads, and refusals as SiteApiError", async () => {
    const adapter = memoryAdapter();
    const local = localClient(adapter);
    const s = site(adapter);
    const remote = createSiteClient({ baseUrl: ORIGIN, key: KEY, fetch: s.fetch });
    await post(local, "one", "title: One");
    expect(await local.meta()).toEqual(await remote.meta());
    expect(await local.get("one")).toEqual(await remote.get("one"));
    const missing = await local.get("nope").catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(SiteApiError);
    expect(missing).toMatchObject({ status: 404, body: { error: "not-found" } });
    const stale = await local.saveDraft("one", { source: "x", expectedVersion: "v0", changeId: "c-x" }).catch((e: unknown) => e);
    expect(stale).toMatchObject({ status: 409, body: { error: "version-conflict", currentVersion: (await local.get("one")).version } });
  });

  it("runs the package's upload checks: bytes that are not their type are refused before the adapter", async () => {
    const { adapter, client } = setup();
    const error = await client.media
      .upload({ bytes: new TextEncoder().encode("not a png"), contentType: "image/png", filename: "a.png", changeId: "u1" })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 400, body: { error: "invalid" } });
    expect(adapter.mediaStore.size).toBe(0);
  });
});

describe("posts", () => {
  it("loads a page as rows: editor and live links, kinds, notes, and the site's delete offer", async () => {
    const { client, source } = setup({}, { notes: async (ids): Promise<Record<string, RowNote[]>> => (ids.includes("b") ? { b: [{ text: "2 AI drafts waiting" }] } : {}) });
    await post(client, "a", "title: Alpha", true);
    await post(client, "b", "title: Beta");
    const data = await loadPosts(source);
    expect(data.rows).toEqual([
      expect.objectContaining({ id: "a", title: "Alpha", status: "published", href: "/edit/a", liveHref: "https://memory.example/blog/a" }),
      expect.objectContaining({ id: "b", status: "draft", liveHref: null, notes: [{ text: "2 AI drafts waiting" }] }),
    ]);
    expect(data.rows[0]).not.toHaveProperty("notes");
    expect(data.kinds).toEqual(["post"]);
    expect(data.offers.delete).toBe(true);
    expect((await loadPosts(setup({ contentDelete: false }).source)).offers.delete).toBe(false);
  });

  it("asks the site to sort and count (v0.6.0), and counts each status tab for the same search", async () => {
    const { client, source } = setup();
    await post(client, "a", "title: Zed", true);
    await post(client, "b", "title: Ant");
    const sorted = await loadPosts(source, { sort: "title" });
    expect(sorted.rows.map((r) => r.id)).toEqual(["b", "a"]);
    expect(sorted.page).toEqual({ nextCursor: null, total: 2 });
    expect(sorted.counts).toEqual({ all: 2, draft: 1, scheduled: 0, published: 1 });
    expect(sorted.rows[0]).toMatchObject({ version: (await client.get("b")).version, tags: [] });
    expect((await loadPosts(source, { sort: "title", dir: "desc" })).rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect((await loadPosts(source, { kind: "episode" })).rows).toEqual([]);
  });

  it("sorts the page itself, and says so, when the list it reads did not sort; and reads a host index in place of the site's list", async () => {
    const { source } = setup();
    const asked: unknown[] = [];
    const row = (id: string, title: string) => ({ id, kind: "post", title, status: "draft" as const, path: null, publishAt: null, publishedAt: null, updatedAt: null });
    const indexed = await loadPosts({
      ...source,
      postIndex: {
        list: async (q) => {
          asked.push(q);
          return { items: [row("z", "Zed"), row("a", "Ant")], nextCursor: null };
        },
      },
    }, { q: "an", sort: "title" });
    expect(indexed.rows.map((r) => r.id)).toEqual(["a", "z"]);
    expect(indexed.page.sortedOnPage).toBe(true);
    expect(indexed.counts).toBeUndefined();
    expect(asked).toEqual([{ limit: 50, q: "an", sort: "title" }]);
  });

  it("adds a tag to each post that lacks it, leaves the rest, and Undo removes it from those only", async () => {
    const { client, source, records } = setup();
    await post(client, "a", "title: A\ntags: [x]");
    await post(client, "b", "title: B\ntags: [x, keep]");
    const added = await runPostsIntent(source, { intent: "tag-add", ids: ["a", "b"], tag: "keep" });
    expect(added.outcomes).toEqual([
      { id: "a", ok: true, message: 'Added the tag "keep".' },
      { id: "b", ok: true, message: 'Already tagged "keep". Not changed.' },
    ]);
    expect((await client.get("a")).source).toContain("tags: [x, keep]");
    expect(records.map((r) => r.ids)).toEqual([["a"]]);
    expect(added.undo).toEqual({ intent: "tag-remove", fields: { ids: ["a"], versions: [(await client.get("a")).version], tag: "keep" } });

    const undone = await runPostsIntent(source, { intent: added.undo!.intent, ...added.undo!.fields });
    expect(undone.ok).toBe(true);
    expect((await client.get("a")).source).toContain("tags: [x]\n");
    expect((await client.get("b")).source).toContain("tags: [x, keep]");
  });

  it("writes tags through the site's tags route where it offers one (v0.6.0), and through the frontmatter where it does not", async () => {
    const routed = setup();
    await post(routed.client, "a", "title: A\ntags: []");
    const viaRoute = vi.spyOn(routed.adapter.content, "setTags");
    const viaSave = vi.spyOn(routed.adapter.content, "saveDraft");
    expect((await runPostsIntent(routed.source, { intent: "tag-add", ids: ["a"], tag: "t" })).ok).toBe(true);
    expect(viaRoute).toHaveBeenCalledTimes(1);
    expect(viaSave).not.toHaveBeenCalled();
    expect((await routed.client.get("a")).tags).toEqual(["t"]);

    const plain = setup({ contentTags: false });
    await post(plain.client, "a", "title: A\ntags: []");
    const saved = vi.spyOn(plain.adapter.content, "saveDraft");
    expect((await runPostsIntent(plain.source, { intent: "tag-add", ids: ["a"], tag: "t" })).ok).toBe(true);
    expect(saved).toHaveBeenCalledTimes(1);
    expect((await plain.client.get("a")).source).toContain("tags: [t]");
  });

  it("refuses an Undo when the post changed since, and names the conflict", async () => {
    const { client, source } = setup();
    await post(client, "a", "title: A\ntags: []");
    const added = await runPostsIntent(source, { intent: "tag-add", ids: ["a"], tag: "t" });
    const now = await client.get("a");
    await client.saveDraft("a", { source: now.source + "More.\n", expectedVersion: now.version, changeId: "elsewhere" });
    const undone = await runPostsIntent(source, { intent: added.undo!.intent, ...added.undo!.fields });
    expect(undone.ok).toBe(false);
    expect(undone.conflict).toEqual({ id: "a", currentVersion: (await client.get("a")).version });
    expect((await client.get("a")).source).toContain("tags: [t]");
  });

  it("refuses a live post to someone who may not publish, alone, and refuses outright what they may not run", async () => {
    const { adapter, client, source } = setup();
    await post(client, "live", "title: Live\ntags: []", true);
    await post(client, "draft", "title: Draft\ntags: []");
    const editor = { ...source, can: EDITOR };
    const tagged = await runPostsIntent(editor, { intent: "tag-add", ids: ["live", "draft"], tag: "t" });
    expect(tagged.outcomes!.map((o) => [o.id, o.ok])).toEqual([["live", false], ["draft", true]]);
    expect((await client.get("live")).source).not.toContain("[t]");

    const before = adapter.store.get("live")!.doc.version;
    expect(await runPostsIntent(editor, { intent: "unpublish", ids: ["live"] })).toEqual({ ok: false, message: "Changing what the public sees is not yours to do on this site." });
    expect(await runPostsIntent(editor, { intent: "delete", ids: ["live"] })).toMatchObject({ ok: false });
    expect(adapter.store.get("live")!.doc.version).toBe(before);
  });

  it("reports an id the site could not hold, a host's hold, and more than 100 posts, without sending them", async () => {
    const { client, source } = setup({}, { hold: async (_intent, id) => (id === "held" ? "You have a working draft of this post." : null) });
    await post(client, "held", "title: H\ntags: []");
    const run = await runPostsIntent(source, { intent: "tag-add", ids: ["../etc", "held"], tag: "t" });
    expect(run.outcomes).toEqual([
      { id: "../etc", ok: false, message: "That is not a post id, so it was not sent to the site." },
      { id: "held", ok: false, message: "You have a working draft of this post." },
    ]);
    expect(run.message).toBe("Nothing was changed: 2 posts left as they were.");
    const many = Array.from({ length: 101 }, (_, i) => `p${i}`);
    expect(await runPostsIntent(source, { intent: "tag-add", ids: many, tag: "t" })).toEqual({ ok: false, message: "At most 100 posts at a time." });
  });

  it("duplicates as a draft with a free id, and Undo deletes the copy at the version the duplicate made", async () => {
    const { adapter, client, source } = setup({}, { taken: async (id) => id === "a-copy" });
    await post(client, "a", "title: Alpha\nslug: a", true);
    const copied = await runPostsIntent(source, { intent: "duplicate", ids: ["a"] });
    expect(copied.outcomes).toEqual([{ id: "a", ok: true, message: 'Copied as a draft with the id "a-copy-2".', copyId: "a-copy-2" }]);
    const copy = await client.get("a-copy-2");
    expect(copy.status).toBe("draft");
    expect(copy.source).toContain('title: "Alpha (copy 2)"\nslug: a-copy-2\ndraft: true');
    expect(copied.undo).toEqual({ intent: "delete", fields: { ids: ["a-copy-2"], versions: [copy.version] } });
    expect((await runPostsIntent(source, { intent: copied.undo!.intent, ...copied.undo!.fields })).ok).toBe(true);
    expect(adapter.deletedContent).toEqual(["a-copy-2"]);
    expect(adapter.store.has("a")).toBe(true);
  });

  it("offers no Undo for a duplicate where the site has no delete, or the person may not delete, and says how to remove it", async () => {
    const plain = setup({ contentDelete: false });
    await post(plain.client, "a", "title: A");
    const noDelete = await runPostsIntent(plain.source, { intent: "duplicate", ids: ["a"] });
    expect(noDelete.undo).toBeUndefined();
    expect(noDelete.message).toContain("remove a copy you do not want in the site's own admin");
    const owned = setup();
    await post(owned.client, "a", "title: A");
    const editor = await runPostsIntent({ ...owned.source, can: EDITOR }, { intent: "duplicate", ids: ["a"] });
    expect(editor.undo).toBeUndefined();
    expect(editor.message).toContain("ask the Owner");
  });

  it("unpublishes, and Undo republishes; a post never published is never published by Undo", async () => {
    const { client, source } = setup();
    await post(client, "live", "title: Live", true);
    const off = await runPostsIntent(source, { intent: "unpublish", ids: ["live"] });
    expect((await client.get("live")).status).toBe("draft");
    expect(off.undo).toEqual({ intent: "republish", fields: { ids: ["live"], versions: [(await client.get("live")).version] } });
    expect((await runPostsIntent(source, { intent: off.undo!.intent, ...off.undo!.fields })).ok).toBe(true);
    expect((await client.get("live")).status).toBe("published");

    await post(client, "fresh", "title: Fresh");
    const first = await runPostsIntent(source, { intent: "republish", ids: ["fresh"] });
    expect(first.outcomes![0]).toMatchObject({ ok: false, message: expect.stringContaining("never been published") });
    expect((await client.get("fresh")).status).toBe("draft");

    const draft = await client.get("fresh");
    await client.schedule("fresh", { expectedVersion: draft.version, changeId: "s1", publishAt: "2030-01-01T09:00:00Z" });
    const unscheduled = await runPostsIntent(source, { intent: "unpublish", ids: ["fresh"] });
    expect(unscheduled.undo).toBeUndefined();
    expect(unscheduled.message).toContain("only scheduled has no Undo");
  });

  it("deletes where the site offers it, and refuses on a site that does not, before asking", async () => {
    const { adapter, client, source } = setup();
    await post(client, "a", "title: A");
    expect(await runPostsIntent(source, { intent: "delete", ids: ["a"] })).toMatchObject({ ok: true, message: "Deleted 1 post." });
    expect(adapter.deletedContent).toEqual(["a"]);
    const none = setup({ contentDelete: false });
    await post(none.client, "a", "title: A");
    expect(await runPostsIntent(none.source, { intent: "delete", ids: ["a"] })).toEqual({ ok: false, message: "This site does not delete posts through the site API." });
  });

  it("says when the record of a done write could not be saved", async () => {
    const { client, source } = setup({}, { record: async () => Promise.reject(new Error("db down")) });
    await post(client, "a", "title: A\ntags: []");
    const run = await runPostsIntent(source, { intent: "tag-add", ids: ["a"], tag: "t" });
    expect(run.outcomes![0]).toEqual({ id: "a", ok: true, message: 'Added the tag "t". The record of it could not be saved.' });
  });

  it("runs the same over the HTTP client, as Carrel drives it", async () => {
    const adapter = memoryAdapter();
    const s = site(adapter);
    const client = createSiteClient({ baseUrl: ORIGIN, key: KEY, fetch: s.fetch });
    await post(client, "a", "title: A\ntags: []");
    const source: ContentSource = { site: adapter.site, client, can: OWNER, editorHref: (id) => `/p/${id}` };
    expect(await runPostsIntent(source, { intent: "tag-add", ids: ["a"], tag: "t" })).toMatchObject({ ok: true, undo: { intent: "tag-remove" } });
  });
});

describe("media", () => {
  it("loads the library and the trash with absolute addresses, the inspector's uses, and the site's offers", async () => {
    const { client, source } = setup();
    const a = await upload(client, "a.png");
    const b = await upload(client, "b.png");
    await client.media.trash(b.id, { expectedVersion: b.version!, changeId: "t1" });
    await post(client, "uses", `title: U\n---\n![x](/media/${a.id})`);
    const library = await loadMedia(source, { inspect: a.id });
    expect(library.rows.map((r) => [r.id, r.src])).toEqual([[a.id, `https://memory.example/media/${a.id}`]]);
    expect(library.detail?.usedBy).toEqual([expect.objectContaining({ id: "uses" })]);
    expect(library.offers).toMatchObject({ media: true, alt: true, tags: true, trash: true });
    expect((await loadMedia(source, { view: "trash" })).rows.map((r) => r.id)).toEqual([b.id]);
    expect(await loadMedia(setup({ media: false }).source)).toMatchObject({ rows: [], offers: { media: false, upload: null } });
  });

  it("sends a lens and a sort the site answers (v0.6.0), drops a lens it does not, and sorts the page itself where the site did not", async () => {
    const { client, source } = setup();
    const small = await upload(client, "b.png");
    await client.media.setAlt(small.id, { alt: "Described", expectedVersion: small.version!, changeId: "s1" });
    await upload(client, "a.png");
    const lensed = await loadMedia(source, { lens: "no-alt", sort: "name" });
    expect(lensed.rows.map((r) => r.filename)).toEqual(["a.png"]);
    expect(lensed.page).toEqual({ nextCursor: null, total: 1 });
    expect(lensed.offers.lenses).toEqual(["unattached", "no-alt", "large"]);
    expect((await loadMedia(source, { sort: "name" })).rows.map((r) => r.filename)).toEqual(["a.png", "b.png"]);

    const old = setup({ mediaLenses: false });
    await upload(old.client, "b.png");
    await upload(old.client, "a.png");
    const fallback = await loadMedia(old.source, { lens: "no-alt", sort: "name", dir: "desc" });
    expect(fallback.offers.lenses).toEqual([]);
    expect(fallback.rows.map((r) => r.filename)).toEqual(["b.png", "a.png"]);
    expect(fallback.page.sortedOnPage).toBe(true);
  });

  it("trashes in one bulk request, and Undo restores at the versions the trash made", async () => {
    const { adapter, client, source } = setup();
    const a = await upload(client, "a.png");
    const trashed = await runMediaIntent(source, { intent: "trash", ids: [a.id], versions: [a.version!] });
    expect(trashed).toMatchObject({ ok: true, message: "Moved to the trash 1 file.", undo: { intent: "restore" } });
    expect(adapter.mediaStore.get(a.id)!.item.trashedAt).not.toBeNull();
    expect((await runMediaIntent(source, { intent: trashed.undo!.intent, ...trashed.undo!.fields })).ok).toBe(true);
    expect(adapter.mediaStore.get(a.id)!.item.trashedAt).toBeNull();
  });

  it("refuses a write with no version the person saw, and names a stale one as a conflict", async () => {
    const { client, source } = setup();
    const a = await upload(client, "a.png");
    expect((await runMediaIntent(source, { intent: "trash", ids: [a.id] })).outcomes![0]).toMatchObject({ ok: false, message: expect.stringContaining("did not say which version") });
    const stale = await runMediaIntent(source, { intent: "trash", ids: [a.id], versions: ["m0"] });
    expect(stale).toMatchObject({ ok: false, conflict: { id: a.id, currentVersion: a.version } });
    const staleTag = await runMediaIntent(source, { intent: "tag-add", ids: [a.id], versions: ["m0"], tags: "x" });
    expect(staleTag).toMatchObject({ ok: false, conflict: { id: a.id, currentVersion: a.version } });
  });

  it("adds a tag only to the files that lack it, and Undo removes it from those only", async () => {
    const { adapter, client, source } = setup();
    const a = await upload(client, "a.png");
    const b = await upload(client, "b.png");
    const bTagged = await client.media.setTags(b.id, { tags: ["blue"], expectedVersion: b.version!, changeId: "s1" });
    const added = await runMediaIntent(source, { intent: "tag-add", ids: [a.id, b.id], versions: [a.version!, bTagged.version], tags: "Blue" });
    expect(added.outcomes).toEqual([
      { id: b.id, ok: true, message: "Already had those tags. Not changed." },
      { id: a.id, ok: true, message: "Tags added." },
    ]);
    expect(adapter.mediaStore.get(b.id)!.item.version).toBe(bTagged.version);
    expect(added.undo).toEqual({ intent: "tag-remove", fields: { ids: [a.id], versions: [adapter.mediaStore.get(a.id)!.item.version], tags: ["blue"] } });
    await runMediaIntent(source, { intent: added.undo!.intent, ...added.undo!.fields });
    expect(adapter.mediaStore.get(a.id)!.item.tags).toEqual([]);
    expect(adapter.mediaStore.get(b.id)!.item.tags).toEqual(["blue"]);
  });

  it("sets a file's whole tag set, and Undo puts back the set it held", async () => {
    const { adapter, client, source } = setup();
    const a = await upload(client, "a.png");
    const first = await client.media.setTags(a.id, { tags: ["old"], expectedVersion: a.version!, changeId: "s1" });
    const set = await runMediaIntent(source, { intent: "tags", ids: [a.id], versions: [first.version], tags: "new, other" });
    expect(adapter.mediaStore.get(a.id)!.item.tags).toEqual(["new", "other"]);
    await runMediaIntent(source, { intent: set.undo!.intent, ...set.undo!.fields });
    expect(adapter.mediaStore.get(a.id)!.item.tags).toEqual(["old"]);
  });

  it("deletes for good only from the trash, and a file in use is refused with its uses named", async () => {
    const { adapter, client, source } = setup();
    const a = await upload(client, "a.png");
    expect((await runMediaIntent(source, { intent: "delete", ids: [a.id] })).outcomes![0]).toMatchObject({ ok: false, message: expect.stringContaining("trash first") });
    const t = await client.media.trash(a.id, { expectedVersion: a.version!, changeId: "t1" });
    await post(client, "uses", `title: U\n---\n![x](/media/${a.id})`);
    const refusedDelete = await runMediaIntent(source, { intent: "delete", ids: [a.id], versions: [t.version] });
    expect(refusedDelete.outcomes![0]).toMatchObject({ ok: false, usedBy: [expect.objectContaining({ id: "uses" })] });
    expect(adapter.deleted).toEqual([]);
    expect(await runMediaIntent({ ...source, can: EDITOR }, { intent: "delete", ids: [a.id] })).toEqual({ ok: false, message: "Deleting a file for good is the Owner's step." });
  });

  it("empties the trash: deletes what nothing uses, keeps what a post uses, says which, and records each under the site's change id", async () => {
    const { adapter, client, source, records } = setup();
    for (const name of ["a.png", "b.png"]) {
      const item = await upload(client, name);
      await client.media.trash(item.id, { expectedVersion: item.version!, changeId: `t-${name.slice(0, 1)}` });
    }
    const [first, second] = [...adapter.mediaStore.keys()];
    await post(client, "uses", `title: U\n---\n![x](/media/${second})`);
    const emptied = await runMediaIntent(source, { intent: "empty-trash" });
    const trashOrder = [second, first];
    expect(records.filter((r) => r.kind === "media-delete").map((r) => r.changeId)).toEqual([expect.stringMatching(new RegExp(`-${trashOrder.indexOf(first!) + 1}$`))]);
    expect(emptied.message).toBe("Deleted 1 file from the trash for good. 1 file is still used and stayed in the trash.");
    expect(adapter.deleted).toEqual([first]);
    expect(emptied.outcomes!.find((o) => !o.ok)).toMatchObject({ id: second, usedBy: [expect.objectContaining({ id: "uses" })] });
  });

  it("checks an upload against the site's limits before sending a byte, then uploads with its alt text", async () => {
    const { adapter, source, records } = setup({ media: { maxBytes: 64, types: ["image/png"] } });
    const big = await runMediaIntent(source, { intent: "upload", file: new File([new Uint8Array(65)], "big.png", { type: "image/png" }) });
    expect(big).toEqual({ ok: false, message: "big.png is 1 KB; this site accepts files up to 1 KB." });
    const wrong = await runMediaIntent(source, { intent: "upload", file: new File(["x"], "a.gif", { type: "image/gif" }) });
    expect(wrong.message).toBe("a.gif is image/gif; this site accepts png.");
    expect(adapter.mediaStore.size).toBe(0);
    const form = new FormData();
    form.set("intent", "upload");
    form.set("alt", "A square");
    form.set("file", new File([PNG], "sq.png", { type: "image/png" }));
    expect(await runMediaIntent(source, form)).toMatchObject({ ok: true, message: "Uploaded sq.png." });
    expect([...adapter.mediaStore.values()][0]!.item.alt).toBe("A square");
    expect(records).toEqual([expect.objectContaining({ kind: "media-upload" })]);
  });

  it("refuses what the site does not offer, before asking it", async () => {
    const { client, source } = setup({ mediaWrites: false });
    const a = await upload(client, "a.png");
    expect(await runMediaIntent(source, { intent: "trash", ids: [a.id], versions: ["x"] })).toEqual({ ok: false, message: "This site does not offer that." });
  });
});

describe("mentions", () => {
  it("opens on pending, or on all when nothing waits, with the counts of the whole queue and each post's editor link", async () => {
    const { adapter, source } = setup();
    adapter.receiveMention({ sourceUrl: "https://a.example/1", targetId: "post-a", status: "approved" });
    const all = await loadMentions(source);
    expect(all.filter).toBe("all");
    expect(all.rows).toEqual([expect.objectContaining({ targetId: "post-a", postHref: "/edit/post-a" })]);
    adapter.receiveMention({ sourceUrl: "https://a.example/2", targetId: "post-a" });
    const pending = await loadMentions(source);
    expect(pending.filter).toBe("pending");
    expect(pending.counts).toMatchObject({ pending: 1, approved: 1 });
    expect(pending.offers).toEqual({ mentions: true, reset: true });
    expect((await loadMentions(setup({ mentionReset: false }).source)).offers.reset).toBe(false);
    expect((await loadMentions(setup({ mentions: false }).source)).offers.mentions).toBe(false);
  });

  it("Undo is the opposite decision between approved and rejected; on a v0.5.0 site a decision on a waiting mention has none", async () => {
    const { adapter, source } = setup({ mentionReset: false });
    const done = adapter.receiveMention({ sourceUrl: "https://a.example/1", targetId: "p", status: "approved" });
    const waiting = adapter.receiveMention({ sourceUrl: "https://a.example/2", targetId: "p" });
    const v = (id: string) => adapter.mentionStore.get(id)!.version;
    const rejected = await runMentionsIntent(source, { intent: "reject", ids: [done, waiting], versions: [v(done), v(waiting)], statuses: ["approved", "pending"] });
    expect(rejected.outcomes!.every((o) => o.ok)).toBe(true);
    expect(rejected.undo).toEqual({ intent: "approve", fields: { ids: [done], versions: [v(done)], statuses: ["rejected"] } });
    expect(rejected.message).toContain("A decision on a waiting mention has no Undo");
    await runMentionsIntent(source, { intent: rejected.undo!.intent, ...rejected.undo!.fields });
    expect(adapter.mentionStore.get(done)!.status).toBe("approved");
    expect(adapter.mentionStore.get(waiting)!.status).toBe("rejected");
    expect(await runMentionsIntent(source, { intent: "reset", ids: [waiting], versions: [v(waiting)] })).toEqual({ ok: false, message: "This site does not take a mention decision back." });
  });

  it("searches and narrows to one post through the site (v0.6.0), and filters the page itself where the site did not", async () => {
    for (const [options, onPage] of [[{}, undefined], [{ mentionFilters: false }, true]] as const) {
      const { adapter, source } = setup(options);
      adapter.receiveMention({ sourceUrl: "https://a.example/kind-words", targetId: "post-a", excerpt: "Kind words" });
      adapter.receiveMention({ sourceUrl: "https://b.example/other", targetId: "post-b", excerpt: "Kind too" });
      adapter.receiveMention({ sourceUrl: "https://c.example/third", targetId: "post-a", excerpt: "Unrelated" });
      const data = await loadMentions(source, { status: "all", q: "kind", targetId: "post-a" });
      expect(data.rows.map((r) => r.sourceUrl), JSON.stringify(options)).toEqual(["https://a.example/kind-words"]);
      expect(data.page.filteredOnPage).toBe(onPage);
    }
  });

  it("with reset (v0.6.0), Undo takes a decision on a waiting mention back to waiting, and Undo of that decides again", async () => {
    const { adapter, source } = setup();
    const waiting = adapter.receiveMention({ sourceUrl: "https://a.example/1", targetId: "p" });
    const v = (id: string) => adapter.mentionStore.get(id)!.version;
    const approved = await runMentionsIntent(source, { intent: "approve", ids: [waiting], versions: [v(waiting)], statuses: ["pending"] });
    expect(approved.undo).toEqual({ intent: "reset", fields: { ids: [waiting], versions: [v(waiting)], statuses: ["approved"] } });
    const back = await runMentionsIntent(source, { intent: approved.undo!.intent, ...approved.undo!.fields });
    expect(back).toMatchObject({ ok: true, message: "Took back the decision on 1 mention." });
    expect(adapter.mentionStore.get(waiting)).toMatchObject({ status: "pending", decidedAt: null });
    expect(back.undo).toEqual({ intent: "approve", fields: { ids: [waiting], versions: [v(waiting)], statuses: ["pending"] } });

    const other = adapter.receiveMention({ sourceUrl: "https://a.example/2", targetId: "p", status: "approved" });
    const mixed = await runMentionsIntent(source, { intent: "reject", ids: [waiting, other], versions: [v(waiting), v(other)], statuses: ["pending", "approved"] });
    expect(mixed.undo).toBeUndefined();
    expect(mixed.message).toContain("no single Undo");
  });

  it("refuses a stale version as a conflict, and an unverified mention with the site's own words", async () => {
    const { adapter, source } = setup();
    const a = adapter.receiveMention({ sourceUrl: "https://a.example/1", targetId: "p" });
    const u = adapter.receiveMention({ sourceUrl: "https://a.example/2", targetId: "p", status: "unverified" });
    const run = await runMentionsIntent(source, { intent: "approve", ids: [a, u], versions: ["m0", adapter.mentionStore.get(u)!.version] });
    expect(run.conflict).toEqual({ id: a, currentVersion: adapter.mentionStore.get(a)!.version });
    expect(run.outcomes![1]).toMatchObject({ ok: false, message: expect.stringContaining("cannot be decided") });
    expect(adapter.mentionStore.get(a)!.status).toBe("pending");
  });

  it("deletes and sweeps for someone who may decide, and refuses both to someone who may not", async () => {
    const { adapter, source } = setup();
    const a = adapter.receiveMention({ sourceUrl: "https://a.example/1", targetId: "p" });
    expect(await runMentionsIntent({ ...source, can: EDITOR }, { intent: "delete", ids: [a], versions: [adapter.mentionStore.get(a)!.version] })).toMatchObject({ ok: false });
    expect(await runMentionsIntent(source, { intent: "delete", ids: [a], versions: [adapter.mentionStore.get(a)!.version] })).toMatchObject({ ok: true, message: "Deleted 1 mention." });
    expect(adapter.mentionStore.has(a)).toBe(false);
    adapter.receiveMention({ sourceUrl: "https://a.example/old", targetId: "p", status: "failed", receivedAt: new Date(Date.now() - 40 * 86_400_000) });
    expect(await runMentionsIntent(source, { intent: "sweep" })).toEqual({ ok: true, message: "Removed 1 failed and 0 rejected mention past their retention window." });
  });
});

describe("summary", () => {
  it("counts what waits on one site, and null for what it cannot say", async () => {
    const { adapter, client, source } = setup({}, { waiting: async () => 3 });
    adapter.receiveMention({ sourceUrl: "https://a.example/1", targetId: "p" });
    await upload(client, "a.png");
    expect(await summary(source)).toEqual({ site: { id: "memory", name: "Memory site" }, mentionsWaiting: 1, postsWaiting: 3, mediaWithoutAlt: 1 });
    expect(await summary(setup({ mentions: false, mediaLenses: false }).source)).toMatchObject({ mentionsWaiting: null, postsWaiting: null, mediaWithoutAlt: null });
  });
});
