// Shareable preview links, made under the key and opened by anyone with the address, on a site with a store.

import { describe, expect, it } from "vitest";
import { runPostsIntent, type ContentSource } from "../src/admin.js";
import { createSiteClient } from "../src/client.js";
import { createSiteApi } from "../src/index.js";
import { MEDIA_LIBRARY_SQL } from "../src/media-store.js";
import { d1SiteApiStore, SITE_API_STORE_SQL } from "../src/store.js";
import { memoryAdapter } from "../src/testing.js";
import { d1 } from "./d1.js";
import { KEY, ORIGIN, allow, mountedFetch } from "./helpers.js";

function mounted(withStore = true) {
  const adapter = memoryAdapter({ site: { id: "memory", name: "Memory site", origin: ORIGIN } });
  const api = createSiteApi({
    adapter,
    key: KEY,
    limiter: allow,
    log: () => {},
    ...(withStore ? { store: d1SiteApiStore(d1(SITE_API_STORE_SQL)) } : {}),
  });
  const fetch = mountedFetch(api);
  return { fetch, c: createSiteClient({ baseUrl: ORIGIN, key: KEY, fetch }) };
}

describe("preview links", () => {
  it("serves the current source to anyone with the link, never indexed, until it is revoked; unknown and revoked links say so", async () => {
    const { fetch, c } = mounted();
    expect((await c.meta()).capabilities.previewLinks).toBe(true);
    await c.saveDraft("a", { source: "# First\n", expectedVersion: null, changeId: "c1" });
    await expect(c.previewLinks.create({ id: "missing", changeId: "c2" })).rejects.toMatchObject({
      status: 404,
    });

    const link = await c.previewLinks.create({ id: "a", expiresInHours: 720, changeId: "c3" });
    // Up to 30 days, said in the answer; more is refused.
    expect(Date.parse(link.expiresAt) - Date.now()).toBeGreaterThan(719 * 3600_000);
    await expect(
      c.previewLinks.create({ id: "a", expiresInHours: 721, changeId: "c3b" }),
    ).rejects.toMatchObject({ status: 400 });
    expect(link.url).toBe(`${ORIGIN}/preview/${link.token}`);
    const doc = await c.get("a");
    await c.saveDraft("a", { source: "# Second\n", expectedVersion: doc.version, changeId: "c4" });

    const open = await fetch(link.url);
    expect(open.status).toBe(200);
    expect(await open.text()).toContain("Second");
    expect(open.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(open.headers.get("cache-control")).toBe("private, no-store");
    expect(open.headers.get("referrer-policy")).toBe("no-referrer");
    expect(open.headers.get("content-security-policy")).toContain("script-src 'none'");
    // A HEAD meets the same answer, noindex included, with no body.
    const head = await fetch(link.url, { method: "HEAD" });
    expect([head.status, head.headers.get("x-robots-tag"), await head.text()]).toEqual([
      200,
      "noindex, nofollow",
      "",
    ]);

    const [listed] = (await c.previewLinks.list("a")).items;
    await c.previewLinks.revoke(listed!.id, { changeId: "c5" });
    // A revoked link is as if it never was.
    expect((await fetch(link.url)).status).toBe(404);
    expect((await c.previewLinks.list("a")).items).toEqual([]);
    const unknown = await fetch(`${ORIGIN}/preview/${"x".repeat(43)}`);
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("answers 501 under the key and 404 for every link on a site with no store", async () => {
    const { fetch, c } = mounted(false);
    await expect(c.previewLinks.create({ id: "a", changeId: "c1" })).rejects.toMatchObject({
      status: 501,
    });
    expect((await fetch(`${ORIGIN}/preview/${"x".repeat(43)}`)).status).toBe(404);
  });

  it("is a publish in the posts list: an Editor is refused, and the Owner's link is recorded", async () => {
    const { c } = mounted();
    const draft = await c.saveDraft("a", {
      source: "# Draft\n",
      expectedVersion: null,
      changeId: "c1",
    });
    const records: Array<{ kind: string; ids: string[] }> = [];
    const source = (publish: boolean): ContentSource => ({
      site: { id: "memory", name: "Memory site", origin: ORIGIN },
      client: c,
      can: { edit: true, publish, deleteContent: false, deleteMedia: false, decideMentions: false },
      editorHref: (id) => `/edit/${id}`,
      record: async ({ kind, ids }) => {
        records.push({ kind, ids });
      },
      log: () => {},
    });
    const ask = { intent: "preview-link", ids: "a", versions: draft.version };

    expect(await runPostsIntent(source(false), ask)).toMatchObject({ ok: false });
    expect((await c.previewLinks.list("a")).items).toEqual([]);

    const made = await runPostsIntent(source(true), ask);
    expect(made).toMatchObject({ ok: true, previewLink: { url: expect.any(String) } });
    expect(records).toEqual([{ kind: "post-preview-link", ids: ["a"] }]);
  });
});

describe("preview link pruning", () => {
  it("drops links that expired or were revoked before the cut, and keeps the rest", async () => {
    const db = d1(SITE_API_STORE_SQL);
    const store = d1SiteApiStore(db);
    const link = (hash: string, expiresAt: string, revokedAt: string | null) => ({
      tokenHash: hash,
      contentId: "a",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt,
      revokedAt,
      changeId: "c",
    });
    await store.putPreviewLink(link("old", "2026-02-01T00:00:00.000Z", null));
    await store.putPreviewLink(
      link("revoked", "2026-12-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"),
    );
    await store.putPreviewLink(link("live", "2026-12-01T00:00:00.000Z", null));
    await store.putPreviewLink(link("recent", "2026-04-20T00:00:00.000Z", null));
    await store.prunePreviewLinks!("2026-04-01T00:00:00.000Z");
    const left = await Promise.all(
      ["old", "revoked", "live", "recent"].map(async (h) => (await store.previewLink(h)) !== null),
    );
    expect(left).toEqual([false, false, true, true]);
  });

  it("compacts the media change log to each file's newest entry, and does nothing on a site without the tables", async () => {
    const db = d1(SITE_API_STORE_SQL + MEDIA_LIBRARY_SQL);
    const insert = (key: string) =>
      db.prepare("INSERT INTO media_changes (media_key) VALUES (?)").bind(key).run();
    for (const key of ["a", "b", "a", "a", "b"]) await insert(key);
    await d1SiteApiStore(db).compactMediaChanges!();
    const { results } = await db
      .prepare("SELECT seq, media_key FROM media_changes ORDER BY seq")
      .all<{ seq: number; media_key: string }>();
    expect(results).toEqual([
      { seq: 4, media_key: "a" },
      { seq: 5, media_key: "b" },
    ]);
    await expect(
      d1SiteApiStore(d1(SITE_API_STORE_SQL)).compactMediaChanges!(),
    ).resolves.toBeUndefined();
  });
});
