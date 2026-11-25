// The content kit's posts half, and localClient, against the in-memory reference site.

import { describe, expect, it, vi } from "vitest";
import {
  liveSaveWarning,
  loadPosts,
  readPostQuery,
  loadScheduledUpdate,
  runPostsIntent,
  type RowNote,
} from "../src/admin.js";
import { createSiteClient, localClient, SiteApiError } from "../src/client.js";
import { memoryAdapter } from "../src/testing.js";
import { KEY, ORIGIN, site } from "./helpers.js";
import { EDITOR, setup, post } from "./admin-setup.js";

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
    const stale = await local
      .saveDraft("one", { source: "x", expectedVersion: "v0", changeId: "c-x" })
      .catch((e: unknown) => e);
    expect(stale).toMatchObject({
      status: 409,
      body: { error: "version-conflict", currentVersion: (await local.get("one")).version },
    });
  });

  it("runs the package's upload checks: bytes that are not their type are refused before the adapter", async () => {
    const { adapter, client } = setup();
    const error = await client.media
      .upload({
        bytes: new TextEncoder().encode("not a png"),
        contentType: "image/png",
        filename: "a.png",
        changeId: "u1",
      })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 400, body: { error: "invalid" } });
    expect(adapter.mediaStore.size).toBe(0);
  });
});

describe("posts", () => {
  it("loads a page as rows: editor and live links, kinds, notes, and the site's delete offer", async () => {
    const { client, source } = setup(
      {},
      {
        notes: async (ids): Promise<Record<string, RowNote[]>> =>
          ids.includes("b") ? { b: [{ text: "2 AI drafts waiting" }] } : {},
      },
    );
    await post(client, "a", "title: Alpha", true);
    await post(client, "b", "title: Beta");
    const data = await loadPosts(source);
    expect(data.rows).toEqual([
      expect.objectContaining({
        id: "a",
        title: "Alpha",
        status: "published",
        href: "/edit/a",
        liveHref: "https://memory.example/blog/a",
      }),
      expect.objectContaining({
        id: "b",
        status: "draft",
        liveHref: null,
        notes: [{ text: "2 AI drafts waiting" }],
      }),
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
    expect((await loadPosts(source, { sort: "title", dir: "desc" })).rows.map((r) => r.id)).toEqual(
      ["a", "b"],
    );
    expect((await loadPosts(source, { kind: "note" })).rows).toEqual([]);
  });

  it("sorts the page itself, and says so, when the list it reads did not sort; and reads a host index in place of the site's list", async () => {
    const { source } = setup();
    const asked: unknown[] = [];
    const row = (id: string, title: string) => ({
      id,
      kind: "post",
      title,
      status: "draft" as const,
      path: null,
      publishAt: null,
      publishedAt: null,
      updatedAt: null,
    });
    const indexed = await loadPosts(
      {
        ...source,
        postIndex: {
          list: async (q) => {
            asked.push(q);
            return { items: [row("z", "Zed"), row("a", "Ant")], nextCursor: null };
          },
        },
      },
      { q: "an", sort: "title" },
    );
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
    expect(added.undo).toEqual({
      intent: "tag-remove",
      fields: { ids: ["a"], versions: [(await client.get("a")).version], tag: "keep" },
    });

    const undone = await runPostsIntent(source, {
      intent: added.undo!.intent,
      ...added.undo!.fields,
    });
    expect(undone.ok).toBe(true);
    expect((await client.get("a")).source).toContain("tags: [x]\n");
    expect((await client.get("b")).source).toContain("tags: [x, keep]");
  });

  it("writes tags through the site's tags route where it offers one (v0.6.0), and through the frontmatter where it does not", async () => {
    const routed = setup();
    await post(routed.client, "a", "title: A\ntags: []");
    const viaRoute = vi.spyOn(routed.adapter.content, "setTags");
    const viaSave = vi.spyOn(routed.adapter.content, "saveDraft");
    expect(
      (await runPostsIntent(routed.source, { intent: "tag-add", ids: ["a"], tag: "t" })).ok,
    ).toBe(true);
    expect(viaRoute).toHaveBeenCalledTimes(1);
    expect(viaSave).not.toHaveBeenCalled();
    expect((await routed.client.get("a")).tags).toEqual(["t"]);

    const plain = setup({ contentTags: false });
    await post(plain.client, "a", "title: A\ntags: []");
    const saved = vi.spyOn(plain.adapter.content, "saveDraft");
    expect(
      (await runPostsIntent(plain.source, { intent: "tag-add", ids: ["a"], tag: "t" })).ok,
    ).toBe(true);
    expect(saved).toHaveBeenCalledTimes(1);
    expect((await plain.client.get("a")).source).toContain("tags: [t]");
  });

  it("refuses an Undo when the post changed since, and names the conflict", async () => {
    const { client, source } = setup();
    await post(client, "a", "title: A\ntags: []");
    const added = await runPostsIntent(source, { intent: "tag-add", ids: ["a"], tag: "t" });
    const now = await client.get("a");
    await client.saveDraft("a", {
      source: now.source + "More.\n",
      expectedVersion: now.version,
      changeId: "elsewhere",
    });
    const undone = await runPostsIntent(source, {
      intent: added.undo!.intent,
      ...added.undo!.fields,
    });
    expect(undone.ok).toBe(false);
    expect(undone.conflict).toEqual({ id: "a", currentVersion: (await client.get("a")).version });
    expect((await client.get("a")).source).toContain("tags: [t]");
  });

  it("refuses a live post to someone who may not publish, alone, and refuses outright what they may not run", async () => {
    const { adapter, client, source } = setup();
    await post(client, "live", "title: Live\ntags: []", true);
    await post(client, "draft", "title: Draft\ntags: []");
    const editor = { ...source, can: EDITOR };
    const tagged = await runPostsIntent(editor, {
      intent: "tag-add",
      ids: ["live", "draft"],
      tag: "t",
    });
    expect(tagged.outcomes!.map((o) => [o.id, o.ok])).toEqual([
      ["live", false],
      ["draft", true],
    ]);
    expect((await client.get("live")).source).not.toContain("[t]");

    const before = adapter.store.get("live")!.doc.version;
    expect(await runPostsIntent(editor, { intent: "unpublish", ids: ["live"] })).toEqual({
      ok: false,
      message: "Changing what the public sees is not yours to do on this site.",
    });
    expect(await runPostsIntent(editor, { intent: "delete", ids: ["live"] })).toMatchObject({
      ok: false,
    });
    expect(adapter.store.get("live")!.doc.version).toBe(before);
  });

  it("reports an id the site could not hold, a host's hold, and more than 100 posts, without sending them", async () => {
    const { client, source } = setup(
      {},
      {
        hold: async (_intent, id) =>
          id === "held" ? "You have a working draft of this post." : null,
      },
    );
    await post(client, "held", "title: H\ntags: []");
    const run = await runPostsIntent(source, {
      intent: "tag-add",
      ids: ["../etc", "held"],
      tag: "t",
    });
    expect(run.outcomes).toEqual([
      {
        id: "../etc",
        ok: false,
        message: "That is not a post id, so it was not sent to the site.",
      },
      { id: "held", ok: false, message: "You have a working draft of this post." },
    ]);
    expect(run.message).toBe("Nothing was changed: 2 posts left as they were.");
    const many = Array.from({ length: 101 }, (_, i) => `p${i}`);
    expect(await runPostsIntent(source, { intent: "tag-add", ids: many, tag: "t" })).toEqual({
      ok: false,
      message: "At most 100 posts at a time.",
    });
  });

  it("duplicates as a draft with a free id, and Undo deletes the copy at the version the duplicate made", async () => {
    const { adapter, client, source } = setup(
      { contentExtras: false },
      { taken: async (id) => id === "a-copy" },
    );
    await post(client, "a", "title: Alpha\nslug: a", true);
    const copied = await runPostsIntent(source, { intent: "duplicate", ids: ["a"] });
    expect(copied.outcomes).toEqual([
      {
        id: "a",
        ok: true,
        message: 'Copied as a draft with the id "a-copy-2".',
        copyId: "a-copy-2",
      },
    ]);
    const copy = await client.get("a-copy-2");
    expect(copy.status).toBe("draft");
    expect(copy.source).toContain('title: "Alpha (copy 2)"\nslug: a-copy-2\ndraft: true');
    expect(copied.undo).toEqual({
      intent: "delete",
      fields: { ids: ["a-copy-2"], versions: [copy.version], confirm: "1" },
    });
    expect(
      (await runPostsIntent(source, { intent: copied.undo!.intent, ...copied.undo!.fields })).ok,
    ).toBe(true);
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
    const editor = await runPostsIntent(
      { ...owned.source, can: EDITOR },
      { intent: "duplicate", ids: ["a"] },
    );
    expect(editor.undo).toBeUndefined();
    expect(editor.message).toContain("ask the Owner");
  });

  it("unpublishes, and Undo republishes; a post never published is never published by Undo", async () => {
    const { client, source } = setup();
    await post(client, "live", "title: Live", true);
    const off = await runPostsIntent(source, { intent: "unpublish", ids: ["live"] });
    expect((await client.get("live")).status).toBe("draft");
    expect(off.undo).toEqual({
      intent: "republish",
      fields: { ids: ["live"], versions: [(await client.get("live")).version] },
    });
    expect(
      (await runPostsIntent(source, { intent: off.undo!.intent, ...off.undo!.fields })).ok,
    ).toBe(true);
    expect((await client.get("live")).status).toBe("published");

    await post(client, "fresh", "title: Fresh");
    const first = await runPostsIntent(source, { intent: "republish", ids: ["fresh"] });
    expect(first.outcomes![0]).toMatchObject({
      ok: false,
      message: expect.stringContaining("never been published"),
    });
    expect((await client.get("fresh")).status).toBe("draft");

    const draft = await client.get("fresh");
    await client.schedule("fresh", {
      expectedVersion: draft.version,
      changeId: "s1",
      publishAt: "2030-01-01T09:00:00Z",
    });
    const unscheduled = await runPostsIntent(source, { intent: "unpublish", ids: ["fresh"] });
    expect(unscheduled.undo).toBeUndefined();
    expect(unscheduled.message).toContain("only scheduled has no Undo");
  });

  it("shows a live post's scheduled update and its source; reschedule (with Undo) moves only its time, cancel keeps the post live, and a live save warns", async () => {
    const { client, source } = setup({}, { scheduleHref: (id) => `/edit/${id}/scheduled` });
    const live = await post(client, "a", "title: A", true);
    await client.schedule("a", {
      expectedVersion: live.version,
      changeId: "s1",
      source: "---\ntitle: A\n---\nNew body.\n",
      publishAt: "2030-01-01T09:00:00-06:00",
    });

    const data = await loadPosts(source);
    expect(data.offers.scheduledUpdates).toBe(true);
    expect(data.rows[0]).toMatchObject({
      status: "published",
      scheduledUpdate: { publishAt: "2030-01-01T09:00:00-06:00", href: "/edit/a/scheduled" },
    });
    const view = await loadScheduledUpdate(source, "a");
    expect(view).toMatchObject({
      when: "2030-01-01 15:00 UTC",
      source: "---\ntitle: A\n---\nNew body.\n",
      live: { href: "https://memory.example/blog/a" },
    });
    expect(view!.patch).toContain("+New body.");
    expect(liveSaveWarning(await client.get("a"))).toContain("2030-01-01 15:00 UTC");

    const tagged = await runPostsIntent(source, { intent: "tag-add", ids: ["a"], tag: "t" });
    expect(tagged.outcomes![0]!.message).toContain("scheduled update will still replace it");

    const moved = await runPostsIntent(source, {
      intent: "reschedule",
      ids: ["a"],
      publishAt: "2030-02-01T00:00:00Z",
    });
    expect(moved).toMatchObject({ ok: true, message: "Rescheduled 1 post." });
    expect(await client.scheduledUpdate("a")).toMatchObject({
      publishAt: "2030-02-01T00:00:00Z",
      source: "---\ntitle: A\n---\nNew body.\n",
    });
    await runPostsIntent(source, { intent: moved.undo!.intent, ...moved.undo!.fields });
    expect((await client.scheduledUpdate("a")).publishAt).toBe("2030-01-01T09:00:00-06:00");
    expect(
      (await runPostsIntent(source, { intent: "reschedule", ids: ["a"], publishAt: "soon" })).ok,
    ).toBe(false);

    const canceled = await runPostsIntent(source, { intent: "cancel-schedule", ids: ["a"] });
    expect(canceled.undo).toBeUndefined();
    expect(await client.get("a")).toMatchObject({
      status: "published",
      scheduledUpdate: null,
      source: expect.stringContaining("Body of a."),
    });
    expect(await loadScheduledUpdate(source, "a")).toBeNull();
    expect(
      await runPostsIntent(setup({}, { can: EDITOR }).source, {
        intent: "cancel-schedule",
        ids: ["a"],
      }),
    ).toMatchObject({ ok: false });
  });

  it("deletes where the site offers it, and refuses on a site that does not, before asking", async () => {
    const { adapter, client, source } = setup({ contentExtras: false });
    await post(client, "a", "title: A");
    // Nothing goes before the person types the count.
    expect((await runPostsIntent(source, { intent: "delete", ids: ["a"] })).confirm).toMatchObject({
      typeToConfirm: "1",
      items: ["a"],
    });
    expect(adapter.deletedContent).toEqual([]);
    expect(
      await runPostsIntent(source, { intent: "delete", ids: ["a"], confirm: "1" }),
    ).toMatchObject({ ok: true, message: "Deleted 1 post." });
    expect(adapter.deletedContent).toEqual(["a"]);
    const none = setup({ contentDelete: false });
    await post(none.client, "a", "title: A");
    expect(await runPostsIntent(none.source, { intent: "delete", ids: ["a"] })).toEqual({
      ok: false,
      message: "This site does not delete posts through the site API.",
    });
  });

  it("warns with the posts that link to one before a trash or a delete, and names the acting person on the write (v0.22.0)", async () => {
    const { client, source } = setup({}, { actor: { name: "Ada Example" } });
    await post(client, "a", "title: A");
    await client.saveDraft("b", {
      source: "---\ntitle: B\n---\nSee [A](/blog/a).\n",
      expectedVersion: null,
      changeId: "c-b",
    });
    const asked = await runPostsIntent(source, { intent: "trash", ids: ["a"] });
    expect(asked.confirm).toMatchObject({
      items: ["a"],
      backlinks: [{ id: "a", linkedFrom: [{ id: "b", title: "B", path: null }] }],
    });
    expect(asked.confirm!.lead).toContain("1 link from other posts will break");
    expect(
      await runPostsIntent(source, { intent: "trash", ids: ["a"], confirm: "1" }),
    ).toMatchObject({ ok: true });
    expect((await client.revisions("a")).items[0]!.author).toBe("Ada Example");
    // Nothing links to b, so its trash goes at once.
    expect(await runPostsIntent(source, { intent: "trash", ids: ["b"] })).toMatchObject({
      ok: true,
    });
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
    expect(
      (await runPostsIntent(source, { intent: "delete", ids: ["b"], confirm: "1" })).outcomes![0],
    ).toMatchObject({ ok: false });
    expect(
      await runPostsIntent(source, { intent: binned.undo!.intent, ...binned.undo!.fields }),
    ).toMatchObject({ ok: true, undo: { intent: "trash" } });
    expect((await client.get("a")).trashedAt).toBeNull();

    const renamed = await runPostsIntent(source, { intent: "rename", ids: ["b"], newId: "b2" });
    expect(renamed).toMatchObject({
      ok: true,
      undo: { intent: "rename", fields: { ids: ["b2"], newId: "b" } },
    });
    await runPostsIntent(source, { intent: renamed.undo!.intent, ...renamed.undo!.fields });
    expect((await client.get("b")).id).toBe("b");
    expect(adapter.deletedContent).toEqual([]);
  });

  it("says when the record of a done write could not be saved", async () => {
    const { client, source } = setup(
      {},
      { record: async () => Promise.reject(new Error("db down")) },
    );
    await post(client, "a", "title: A\ntags: []");
    const run = await runPostsIntent(source, { intent: "tag-add", ids: ["a"], tag: "t" });
    expect(run.outcomes![0]).toEqual({
      id: "a",
      ok: true,
      message: 'Added the tag "t". The record of it could not be saved.',
    });
  });
});
