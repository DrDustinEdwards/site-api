// The content kit (./admin) and localClient, against the in-memory reference site. A site's own
// admin drives the kit through localClient; Carrel drives it through createSiteClient, which one test
// below runs too, so both hosts meet the same code.

import { describe, expect, it, vi } from "vitest";
import {
  loadMedia,
  loadMediaChanges,
  loadMentions,
  liveSaveWarning,
  loadPosts,
  readPostQuery,
  loadScheduledUpdate,
  readMediaQuery,
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
import { KEY, ORIGIN, png, site } from "./helpers.js";

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
  return client.media.upload({ bytes: PNG, contentType: "image/png", filename: name, decorative: true, changeId: `u-${name.replace(/\W/g, "")}` });
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
    const { client, source } = setup({ contentExtras: false });
    await post(client, "a", "title: Zed", true);
    await post(client, "b", "title: Ant");
    const sorted = await loadPosts(source, { sort: "title" });
    expect(sorted.rows.map((r) => r.id)).toEqual(["b", "a"]);
    expect(sorted.page).toEqual({ nextCursor: null, total: 2 });
    expect(sorted.counts).toEqual({ all: 2, draft: 1, scheduled: 0, published: 1 });
    expect(sorted.rows[0]).toMatchObject({ version: (await client.get("b")).version, tags: [] });
    expect((await loadPosts(source, { sort: "title", dir: "desc" })).rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect((await loadPosts(source, { kind: "note" })).rows).toEqual([]);
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
    const { adapter, client, source } = setup({ contentExtras: false }, { taken: async (id) => id === "a-copy" });
    await post(client, "a", "title: Alpha\nslug: a", true);
    const copied = await runPostsIntent(source, { intent: "duplicate", ids: ["a"] });
    expect(copied.outcomes).toEqual([{ id: "a", ok: true, message: 'Copied as a draft with the id "a-copy-2".', copyId: "a-copy-2" }]);
    const copy = await client.get("a-copy-2");
    expect(copy.status).toBe("draft");
    expect(copy.source).toContain('title: "Alpha (copy 2)"\nslug: a-copy-2\ndraft: true');
    expect(copied.undo).toEqual({ intent: "delete", fields: { ids: ["a-copy-2"], versions: [copy.version], confirm: "1" } });
    expect((await runPostsIntent(source, { intent: copied.undo!.intent, ...copied.undo!.fields })).ok).toBe(true);
    expect(adapter.deletedContent).toEqual(["a-copy-2"]);
    expect(adapter.store.has("a")).toBe(true);
  });

  it("offers no Undo for a duplicate where the site has no delete, or the person may not delete, and says how to remove it", async () => {
    const plain = setup({ contentDelete: false, contentExtras: false });
    await post(plain.client, "a", "title: A");
    const noDelete = await runPostsIntent(plain.source, { intent: "duplicate", ids: ["a"] });
    expect(noDelete.undo).toBeUndefined();
    expect(noDelete.message).toContain("remove a copy you do not want in the site's own admin");
    const owned = setup({ contentExtras: false });
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

  it("shows a live post's scheduled update and its source; reschedule (with Undo) moves only its time, cancel keeps the post live, and a live save warns", async () => {
    const { client, source } = setup({}, { scheduleHref: (id) => `/edit/${id}/scheduled` });
    const live = await post(client, "a", "title: A", true);
    await client.schedule("a", { expectedVersion: live.version, changeId: "s1", source: "---\ntitle: A\n---\nNew body.\n", publishAt: "2030-01-01T09:00:00-06:00" });

    const data = await loadPosts(source);
    expect(data.offers.scheduledUpdates).toBe(true);
    expect(data.rows[0]).toMatchObject({ status: "published", scheduledUpdate: { publishAt: "2030-01-01T09:00:00-06:00", href: "/edit/a/scheduled" } });
    const view = await loadScheduledUpdate(source, "a");
    expect(view).toMatchObject({ when: "2030-01-01 15:00 UTC", source: "---\ntitle: A\n---\nNew body.\n", live: { href: "https://memory.example/blog/a" } });
    expect(view!.patch).toContain("+New body.");
    expect(liveSaveWarning(await client.get("a"))).toContain("2030-01-01 15:00 UTC");

    const tagged = await runPostsIntent(source, { intent: "tag-add", ids: ["a"], tag: "t" });
    expect(tagged.outcomes![0]!.message).toContain("scheduled update will still replace it");

    const moved = await runPostsIntent(source, { intent: "reschedule", ids: ["a"], publishAt: "2030-02-01T00:00:00Z" });
    expect(moved).toMatchObject({ ok: true, message: "Rescheduled 1 post." });
    expect(await client.scheduledUpdate("a")).toMatchObject({ publishAt: "2030-02-01T00:00:00Z", source: "---\ntitle: A\n---\nNew body.\n" });
    await runPostsIntent(source, { intent: moved.undo!.intent, ...moved.undo!.fields });
    expect((await client.scheduledUpdate("a")).publishAt).toBe("2030-01-01T09:00:00-06:00");
    expect((await runPostsIntent(source, { intent: "reschedule", ids: ["a"], publishAt: "soon" })).ok).toBe(false);

    const canceled = await runPostsIntent(source, { intent: "cancel-schedule", ids: ["a"] });
    expect(canceled.undo).toBeUndefined();
    expect(await client.get("a")).toMatchObject({ status: "published", scheduledUpdate: null, source: expect.stringContaining("Body of a.") });
    expect(await loadScheduledUpdate(source, "a")).toBeNull();
    expect(await runPostsIntent(setup({}, { can: EDITOR }).source, { intent: "cancel-schedule", ids: ["a"] })).toMatchObject({ ok: false });
  });

  it("deletes where the site offers it, and refuses on a site that does not, before asking", async () => {
    const { adapter, client, source } = setup({ contentExtras: false });
    await post(client, "a", "title: A");
    // Nothing goes before the person types the count.
    expect((await runPostsIntent(source, { intent: "delete", ids: ["a"] })).confirm).toMatchObject({ typeToConfirm: "1", items: ["a"] });
    expect(adapter.deletedContent).toEqual([]);
    expect(await runPostsIntent(source, { intent: "delete", ids: ["a"], confirm: "1" })).toMatchObject({ ok: true, message: "Deleted 1 post." });
    expect(adapter.deletedContent).toEqual(["a"]);
    const none = setup({ contentDelete: false });
    await post(none.client, "a", "title: A");
    expect(await runPostsIntent(none.source, { intent: "delete", ids: ["a"] })).toEqual({ ok: false, message: "This site does not delete posts through the site API." });
  });

  it("trashes and restores with Undo, deletes for good only from the Trash, lists and counts the Trash, and renames with Undo (v0.17.0)", async () => {
    const { adapter, client, source } = setup();
    await post(client, "a", "title: A", true);
    await post(client, "b", "title: B");
    const binned = await runPostsIntent(source, { intent: "trash", ids: ["a"] });
    expect(binned).toMatchObject({ ok: true, undo: { intent: "restore", fields: { ids: ["a"] } } });
    expect((await client.get("a")).status).toBe("draft");
    const trash = await loadPosts(source, readPostQuery(new URLSearchParams("trashed=1")));
    expect(trash.rows.map((r) => r.id)).toEqual(["a"]);
    expect(trash.counts?.trash).toBe(1);
    expect(trash.offers).toMatchObject({ trash: true, rename: true });
    expect((await runPostsIntent(source, { intent: "delete", ids: ["b"], confirm: "1" })).outcomes![0]).toMatchObject({ ok: false });
    expect(await runPostsIntent(source, { intent: binned.undo!.intent, ...binned.undo!.fields })).toMatchObject({ ok: true, undo: { intent: "trash" } });
    expect((await client.get("a")).trashedAt).toBeNull();

    const renamed = await runPostsIntent(source, { intent: "rename", ids: ["b"], newId: "b2" });
    expect(renamed).toMatchObject({ ok: true, undo: { intent: "rename", fields: { ids: ["b2"], newId: "b" } } });
    await runPostsIntent(source, { intent: renamed.undo!.intent, ...renamed.undo!.fields });
    expect((await client.get("b")).id).toBe("b");
    expect(adapter.deletedContent).toEqual([]);
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
    const { adapter, client, source } = setup();
    const small = await upload(client, "b.png");
    await client.media.setAlt(small.id, { alt: "Described", expectedVersion: small.version!, changeId: "s1" });
    // A file stored before v0.19.0, with no alt and no one's choice: the lens names it, and leaves the decorative b.png out.
    await adapter.media!.upload({ bytes: PNG, contentType: "image/png", filename: "a.png", alt: "", changeId: "u-a" });
    await client.media.setAlt(small.id, { alt: "", decorative: true, expectedVersion: adapter.mediaStore.get(small.id)!.item.version!, changeId: "s2" });
    const lensed = await loadMedia(source, { lens: "no-alt", sort: "name" });
    expect(lensed.rows.map((r) => r.filename)).toEqual(["a.png"]);
    expect(lensed.page).toEqual({ nextCursor: null, total: 1, changeCursor: expect.any(String) });
    expect(lensed.offers.lenses).toEqual(["unattached", "no-alt", "large", "license-expired", "oversized"]);
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
    // A form with no script posts each ticked box's version under its own id.
    const added = await runMediaIntent(source, { intent: "tag-add", ids: [a.id, b.id], [`version:${a.id}`]: a.version!, [`version:${b.id}`]: bTagged.version, "version:unticked.png": "m9", tags: "Blue" });
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
    // The outcome carries the version the write made, so the inspector's next field saves on it.
    expect(set.outcomes![0]!.version).toBe(adapter.mediaStore.get(a.id)!.item.version);
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
    const refusedDelete = await runMediaIntent(source, { intent: "delete", ids: [a.id], versions: [t.version], confirm: "1" });
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
    expect((await runMediaIntent(source, { intent: "empty-trash" })).confirm).toMatchObject({ typeToConfirm: "2" });
    expect(adapter.deleted).toEqual([]);
    const emptied = await runMediaIntent(source, { intent: "empty-trash", confirm: "2" });
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

  it("replaces a file as the Owner only, and sets and clears its focal point (v0.10.0)", async () => {
    const { adapter, client, source, records } = setup();
    const a = await upload(client, "a.png");
    const focused = await runMediaIntent(source, { intent: "focus", ids: [a.id], versions: [a.version!], focus: "0.3x0.6" });
    expect(focused).toMatchObject({ ok: true, message: "Focal point saved." });
    // A form with no script posts the point as two percents.
    const fromForm = await runMediaIntent(source, { intent: "focus", ids: [a.id], versions: [adapter.mediaStore.get(a.id)!.item.version!], x: "25.5", y: "100" });
    expect(fromForm).toMatchObject({ ok: true });
    expect(adapter.mediaStore.get(a.id)!.item.focus).toBe("0.255x1");
    expect(await runMediaIntent(source, { intent: "focus", ids: [a.id], versions: [adapter.mediaStore.get(a.id)!.item.version!], x: "120", y: "5" })).toEqual({ ok: false, message: "That is not a point on the picture." });
    const v = adapter.mediaStore.get(a.id)!.item.version!;
    const file = new File([PNG, new Uint8Array([7])], "a2.png", { type: "image/png" });
    expect(await runMediaIntent({ ...source, can: EDITOR }, { intent: "replace", ids: [a.id], versions: [v], file })).toEqual({ ok: false, message: "Replacing a file is the Owner's step." });
    const replaced = await runMediaIntent(source, { intent: "replace", ids: [a.id], versions: [v], file });
    expect(replaced).toMatchObject({ ok: true, message: expect.stringMatching(/^Replaced\. Every page/) });
    expect(adapter.mediaStore.get(a.id)!.item).toMatchObject({ focus: null, filename: "a2.png" });
    expect(records.map((r) => r.kind)).toEqual(["media-focus", "media-focus", "media-replace"]);
    // A site whose replace must keep the picture's size says so (v0.11.0), and the library's offers carry it.
    expect((await loadMedia(source)).offers.replaceKeepsSize).toBe(false);
    expect((await loadMedia(setup({ mediaReplaceKeepsSize: true }).source)).offers.replaceKeepsSize).toBe(true);
  });

  it("imports from the web, says when an upload was already in the library, and saves credit and license (v0.13.0)", async () => {
    const remote = (async () => new Response(png(30, 20) as Uint8Array<ArrayBuffer>, { headers: { "content-type": "image/png" } })) as typeof fetch;
    const { adapter, source, records } = setup({ mediaDuplicates: true, mediaImportFetch: remote });
    expect((await loadMedia(source)).offers).toMatchObject({ import: true, credit: true, duplicates: true, transform: true, history: true, live: true, resize: { maxEdge: 2048 }, resizePass: true });
    const file = () => new File([png(10, 10) as Uint8Array<ArrayBuffer>], "a.png", { type: "image/png" });
    expect(await runMediaIntent(source, { intent: "upload", alt: "A test picture", file: file() })).toMatchObject({ ok: true, message: "Uploaded a.png." });
    expect(await runMediaIntent(source, { intent: "upload", alt: "A test picture", file: file() })).toMatchObject({ ok: true, message: "a.png is already in the library as a.png, so no second copy was stored.", outcomes: [{ duplicate: true }] });
    expect(await runMediaIntent(source, { intent: "import", url: "http://photos.example.com/b.png" })).toEqual({ ok: false, message: "Give the file's https address." });
    expect(await runMediaIntent(source, { intent: "import", url: "https://photos.example.com/b.png", alt: "A test picture" })).toMatchObject({ ok: true, message: "Imported b.png." });
    expect(records.map((r) => r.kind)).toEqual(["media-upload", "media-import"]);

    const [id] = [...adapter.mediaStore.keys()];
    const version = adapter.mediaStore.get(id!)!.item.version!;
    expect(await runMediaIntent(source, { intent: "credit", ids: [id!], versions: [version], licenseExpires: "soon" })).toEqual({ ok: false, message: "The license end is not a date." });
    const credited = await runMediaIntent(source, { intent: "credit", ids: [id!], versions: [version], credit: "Ada Example", license: "CC BY 4.0", sourceUrl: "https://example.com/a", licenseExpires: "2030-01-01" });
    expect(credited).toMatchObject({ ok: true, message: "Credit saved." });
    expect(adapter.mediaStore.get(id!)!.item).toMatchObject({ credit: "Ada Example", license: "CC BY 4.0", sourceUrl: "https://example.com/a", licenseExpires: "2030-01-01" });
  });

  it("turns a picture as the Owner, and Undo puts its old bytes back; shrinks stored pictures after asking (v0.13.0)", async () => {
    const { adapter, source } = setup();
    const form = { intent: "upload", resize: "no", alt: "A test picture", file: new File([png(4000, 3000) as Uint8Array<ArrayBuffer>], "big.png", { type: "image/png" }) };
    await runMediaIntent(source, form);
    const [id] = [...adapter.mediaStore.keys()];
    const at = () => adapter.mediaStore.get(id!)!.item;
    expect(at()).toMatchObject({ width: 4000, height: 3000 });
    expect(await runMediaIntent({ ...source, can: EDITOR }, { intent: "transform", ids: [id!], versions: [at().version!], op: "rotate-90" })).toEqual({ ok: false, message: "Changing a file's picture is the Owner's step." });
    const turned = await runMediaIntent(source, { intent: "transform", ids: [id!], versions: [at().version!], op: "rotate-90" });
    expect(turned).toMatchObject({ ok: true, undo: { intent: "revert" } });
    expect(at()).toMatchObject({ width: 3000, height: 4000 });
    expect(await runMediaIntent(source, { intent: turned.undo!.intent, ...turned.undo!.fields })).toMatchObject({ ok: true, undo: { intent: "revert" } });
    expect(at()).toMatchObject({ width: 4000, height: 3000 });
    expect((await loadMedia(source, { inspect: id! })).detail?.history?.map((r) => r.reason)).toEqual(["revert", "transform", "upload"]);

    const ask = await runMediaIntent(source, { intent: "resize", ids: [id!], versions: [at().version!] });
    expect(ask.confirm).toMatchObject({ typeToConfirm: "1", items: [id] });
    expect(at().width).toBe(4000);
    expect(await runMediaIntent(source, { ...ask.confirm!.fields, intent: "resize", confirm: "1" })).toMatchObject({ ok: true, outcomes: [{ ok: true, message: "Shrunk to 2048x1536." }] });
  });

  it("shows the model's suggestions only when asked, less what the file has, and polls for what others changed (v0.13.0)", async () => {
    const { adapter, client, source } = setup();
    const a = await client.media.upload({ bytes: png(10, 10), contentType: "image/png", filename: "river-dusk.png", alt: "A test picture", changeId: "u1" });
    await client.media.setTags(a.id, { tags: ["river"], expectedVersion: a.version!, changeId: "t1" });
    expect(readMediaQuery(new URLSearchParams(`inspect=${a.id}&suggest=1&orientation=square&kind=image`))).toEqual({ inspect: a.id, suggest: true, orientation: "square", kind: "image" });
    const plain = await loadMedia(source, { inspect: a.id });
    expect(plain.detail?.suggestions).toBeUndefined();
    // Rows and the inspected file say which way the picture lies, by the package's orientationOf (v0.13.1).
    expect([plain.rows[0]?.orientation, plain.detail?.orientation]).toEqual(["square", "square"]);
    expect((await loadMedia(source, { inspect: a.id, suggest: true })).detail?.suggestions).toEqual({ tags: ["dusk"], alt: "A picture of river dusk.", model: "memory-suggester" });

    // Someone else, in another admin, changes the file after this page loaded.
    const other = localClient(adapter, { log: () => {} });
    await other.media.setAlt(a.id, { alt: "The river at dusk", expectedVersion: adapter.mediaStore.get(a.id)!.item.version!, changeId: "o1" });
    const changes = await loadMediaChanges(source, plain.page.changeCursor!);
    expect(changes).toMatchObject({ rows: [{ id: a.id, alt: "The river at dusk", src: `https://memory.example/media/${a.id}` }], removed: [], more: false });
    expect(await loadMediaChanges(source, "999")).toEqual({ reload: true });
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
    // A file stored before v0.19.0 with no alt counts; a decorative one does not.
    await adapter.media!.upload({ bytes: PNG, contentType: "image/png", filename: "a.png", alt: "", changeId: "u-a" });
    await upload(client, "b.png");
    expect(await summary(source)).toEqual({ site: { id: "memory", name: "Memory site" }, mentionsWaiting: 1, postsWaiting: 3, mediaWithoutAlt: 1, mediaLicenseExpired: 0 });
    expect(await summary(setup({ mentions: false, mediaLenses: false }).source)).toMatchObject({ mentionsWaiting: null, postsWaiting: null, mediaWithoutAlt: null, mediaLicenseExpired: null });
  });
});
