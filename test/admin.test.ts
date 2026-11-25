// The content kit (./admin) and localClient, against the in-memory reference site. A site's own
// admin drives the kit through localClient; Carrel drives it through createSiteClient, which one test
// below runs too, so both hosts meet the same code.

import { describe, expect, it } from "vitest";
import { loadMentions, runMentionsIntent, summary } from "../src/admin.js";
import { createSiteClient, localClient, SiteApiError } from "../src/client.js";
import { memoryAdapter } from "../src/testing.js";
import { KEY, ORIGIN, site } from "./helpers.js";
import { EDITOR, PNG, post, setup, upload } from "./admin-helpers.js";

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

describe("mentions", () => {
  it("opens on pending, or on all when nothing waits, with the counts of the whole queue and each post's editor link", async () => {
    const { adapter, source } = setup();
    adapter.receiveMention({
      sourceUrl: "https://a.example/1",
      targetId: "post-a",
      status: "approved",
    });
    const all = await loadMentions(source);
    expect(all.filter).toBe("all");
    expect(all.rows).toEqual([
      expect.objectContaining({ targetId: "post-a", postHref: "/edit/post-a" }),
    ]);
    adapter.receiveMention({ sourceUrl: "https://a.example/2", targetId: "post-a" });
    const pending = await loadMentions(source);
    expect(pending.filter).toBe("pending");
    expect(pending.counts).toMatchObject({ pending: 1, approved: 1 });
    expect(pending.offers).toEqual({ mentions: true, reset: true });
    expect((await loadMentions(setup({ mentionReset: false }).source)).offers.reset).toBe(false);
    expect((await loadMentions(setup({ mentions: false }).source)).offers.mentions).toBe(false);
  });

  it("Undo is the opposite decision between approved and rejected; on a site without reset a decision on a waiting mention has none", async () => {
    const { adapter, source } = setup({ mentionReset: false });
    const done = adapter.receiveMention({
      sourceUrl: "https://a.example/1",
      targetId: "p",
      status: "approved",
    });
    const waiting = adapter.receiveMention({ sourceUrl: "https://a.example/2", targetId: "p" });
    const v = (id: string) => adapter.mentionStore.get(id)!.version;
    const rejected = await runMentionsIntent(source, {
      intent: "reject",
      ids: [done, waiting],
      versions: [v(done), v(waiting)],
      statuses: ["approved", "pending"],
    });
    expect(rejected.outcomes!.every((o) => o.ok)).toBe(true);
    expect(rejected.undo).toEqual({
      intent: "approve",
      fields: { ids: [done], versions: [v(done)], statuses: ["rejected"] },
    });
    expect(rejected.message).toContain("A decision on a waiting mention has no Undo");
    await runMentionsIntent(source, { intent: rejected.undo!.intent, ...rejected.undo!.fields });
    expect(adapter.mentionStore.get(done)!.status).toBe("approved");
    expect(adapter.mentionStore.get(waiting)!.status).toBe("rejected");
    expect(
      await runMentionsIntent(source, { intent: "reset", ids: [waiting], versions: [v(waiting)] }),
    ).toEqual({ ok: false, message: "This site does not take a mention decision back." });
  });

  it("searches and narrows to one post through the site, and filters the page itself where the site did not", async () => {
    for (const [options, onPage] of [
      [{}, undefined],
      [{ mentionFilters: false }, true],
    ] as const) {
      const { adapter, source } = setup(options);
      adapter.receiveMention({
        sourceUrl: "https://a.example/kind-words",
        targetId: "post-a",
        excerpt: "Kind words",
      });
      adapter.receiveMention({
        sourceUrl: "https://b.example/other",
        targetId: "post-b",
        excerpt: "Kind too",
      });
      adapter.receiveMention({
        sourceUrl: "https://c.example/third",
        targetId: "post-a",
        excerpt: "Unrelated",
      });
      const data = await loadMentions(source, { status: "all", q: "kind", targetId: "post-a" });
      expect(
        data.rows.map((r) => r.sourceUrl),
        JSON.stringify(options),
      ).toEqual(["https://a.example/kind-words"]);
      expect(data.page.filteredOnPage).toBe(onPage);
    }
  });

  it("with reset, Undo takes a decision on a waiting mention back to waiting, and Undo of that decides again", async () => {
    const { adapter, source } = setup();
    const waiting = adapter.receiveMention({ sourceUrl: "https://a.example/1", targetId: "p" });
    const v = (id: string) => adapter.mentionStore.get(id)!.version;
    const approved = await runMentionsIntent(source, {
      intent: "approve",
      ids: [waiting],
      versions: [v(waiting)],
      statuses: ["pending"],
    });
    expect(approved.undo).toEqual({
      intent: "reset",
      fields: { ids: [waiting], versions: [v(waiting)], statuses: ["approved"] },
    });
    const back = await runMentionsIntent(source, {
      intent: approved.undo!.intent,
      ...approved.undo!.fields,
    });
    expect(back).toMatchObject({ ok: true, message: "Took back the decision on 1 mention." });
    expect(adapter.mentionStore.get(waiting)).toMatchObject({ status: "pending", decidedAt: null });
    expect(back.undo).toEqual({
      intent: "approve",
      fields: { ids: [waiting], versions: [v(waiting)], statuses: ["pending"] },
    });

    const other = adapter.receiveMention({
      sourceUrl: "https://a.example/2",
      targetId: "p",
      status: "approved",
    });
    const mixed = await runMentionsIntent(source, {
      intent: "reject",
      ids: [waiting, other],
      versions: [v(waiting), v(other)],
      statuses: ["pending", "approved"],
    });
    expect(mixed.undo).toBeUndefined();
    expect(mixed.message).toContain("no single Undo");
  });

  it("refuses a stale version as a conflict, and an unverified mention with the site's own words", async () => {
    const { adapter, source } = setup();
    const a = adapter.receiveMention({ sourceUrl: "https://a.example/1", targetId: "p" });
    const u = adapter.receiveMention({
      sourceUrl: "https://a.example/2",
      targetId: "p",
      status: "unverified",
    });
    const run = await runMentionsIntent(source, {
      intent: "approve",
      ids: [a, u],
      versions: ["m0", adapter.mentionStore.get(u)!.version],
    });
    expect(run.conflict).toEqual({ id: a, currentVersion: adapter.mentionStore.get(a)!.version });
    expect(run.outcomes![1]).toMatchObject({
      ok: false,
      message: expect.stringContaining("cannot be decided"),
    });
    expect(adapter.mentionStore.get(a)!.status).toBe("pending");
  });

  it("asks before a delete or a sweep and removes nothing until told, for someone who may decide; refuses someone who may not", async () => {
    const { adapter, source } = setup();
    const a = adapter.receiveMention({
      sourceUrl: "https://a.example/1",
      targetId: "p",
      authorName: "Ana",
    });
    expect(
      await runMentionsIntent(
        { ...source, can: EDITOR },
        { intent: "delete", ids: [a], confirm: "1" },
      ),
    ).toMatchObject({ ok: false });
    // The bulk form posts no versions: the kit reads the site's, and names each mention in the confirm.
    const ask = await runMentionsIntent(source, { intent: "delete", ids: [a] });
    expect(ask.confirm).toMatchObject({
      intent: "delete",
      typeToConfirm: "1",
      items: ["Ana on p"],
      fields: { ids: [a], versions: [adapter.mentionStore.get(a)!.version] },
    });
    expect(adapter.mentionStore.has(a)).toBe(true);
    expect(
      await runMentionsIntent(source, { ...ask.confirm!.fields, intent: "delete", confirm: "1" }),
    ).toMatchObject({ ok: true, message: "Deleted 1 mention." });
    expect(adapter.mentionStore.has(a)).toBe(false);
    adapter.receiveMention({
      sourceUrl: "https://a.example/old",
      targetId: "p",
      status: "failed",
      receivedAt: new Date(Date.now() - 40 * 86_400_000),
    });
    const sweep = await runMentionsIntent(source, { intent: "sweep" });
    expect(sweep.confirm).toMatchObject({
      intent: "sweep",
      items: ["1 failed", "0 rejected"],
      fields: { confirm: "sweep" },
    });
    expect(adapter.mentionStore.size).toBe(1);
    expect(await runMentionsIntent(source, { intent: "sweep", confirm: "sweep" })).toEqual({
      ok: true,
      message: "Removed 1 failed and 0 rejected mention past their retention window.",
    });
  });
});

describe("summary", () => {
  it("counts what waits on one site, and null for what it cannot say", async () => {
    const { adapter, client, source } = setup({}, { waiting: async () => 3 });
    adapter.receiveMention({ sourceUrl: "https://a.example/1", targetId: "p" });
    // A file stored with no alt and no decorative choice counts; a decorative one does not.
    await adapter.media!.upload({
      bytes: PNG,
      contentType: "image/png",
      filename: "a.png",
      alt: "",
      changeId: "u-a",
    });
    await upload(client, "b.png");
    expect(await summary(source)).toEqual({
      site: { id: "memory", name: "Memory site" },
      mentionsWaiting: 1,
      postsWaiting: 3,
      mediaWithoutAlt: 1,
      mediaLicenseExpired: 0,
    });
    expect(await summary(setup({ mentions: false, mediaLenses: false }).source)).toMatchObject({
      mentionsWaiting: null,
      postsWaiting: null,
      mediaWithoutAlt: null,
      mediaLicenseExpired: null,
    });
  });
});
