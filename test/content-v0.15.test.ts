// v0.15.0: the content group's new writes and list options, each optional per site, against the reference adapter.

import { describe, expect, it } from "vitest";
import { createSiteClient } from "../src/client.js";
import { memoryAdapter } from "../src/testing.js";
import { createSiteApi } from "../src/index.js";
import { KEY, ORIGIN, allow, site } from "./helpers.js";

function client(adapter = memoryAdapter()) {
  const s = site(adapter);
  return { ...s, c: createSiteClient({ baseUrl: ORIGIN, key: KEY, fetch: s.fetch }) };
}

describe("a settable publish date (v0.15.0)", () => {
  it("publishes under a past date, re-dates a live post, refuses a future one, and answers 501 where the site cannot", async () => {
    const { c } = client();
    const draft = await c.saveDraft("a", { source: "# A\n", expectedVersion: null, changeId: "c1" });
    const live = await c.publish("a", { expectedVersion: draft.version, changeId: "c2", publishedAt: "2020-05-01T12:00:00Z" });
    expect((await c.get("a")).publishedAt).toBe("2020-05-01T12:00:00.000Z");
    await c.publish("a", { expectedVersion: live.version, changeId: "c3", publishedAt: "2021-01-01T00:00:00Z" });
    expect((await c.get("a")).publishedAt).toBe("2021-01-01T00:00:00.000Z");

    const now = (await c.get("a")).version;
    await expect(c.publish("a", { expectedVersion: now, changeId: "c4", publishedAt: "2999-01-01T00:00:00Z" })).rejects.toMatchObject({ status: 400 });

    const without = memoryAdapter();
    delete without.content.publishedAtSettable;
    const other = client(without).c;
    const d = await other.saveDraft("a", { source: "# A\n", expectedVersion: null, changeId: "c1" });
    await expect(other.publish("a", { expectedVersion: d.version, changeId: "c2", publishedAt: "2020-05-01T12:00:00Z" })).rejects.toMatchObject({ status: 501 });
    expect((await other.meta()).capabilities.contentPublishedAt).toBeUndefined();
  });
});

describe("rename (v0.15.0)", () => {
  it("moves a published post with its history and a redirect, refuses a taken id, and answers 501 where the site cannot", async () => {
    const { c, adapter } = client();
    const a = await c.saveDraft("a", { source: "# A\n", expectedVersion: null, changeId: "c1" });
    const live = await c.publish("a", { expectedVersion: a.version, changeId: "c2" });
    const b = await c.saveDraft("b", { source: "# B\n", expectedVersion: null, changeId: "c3" });
    await expect(c.rename("a", { newId: "b", expectedVersion: live.version, changeId: "c4" })).rejects.toMatchObject({ status: 422 });

    const moved = await c.rename("a", { newId: "a-new", expectedVersion: live.version, changeId: "c5" });
    expect(moved).toMatchObject({ id: "a-new", status: "published", previousPath: "/blog/a" });
    expect(adapter.redirects.get("/blog/a")).toBe("/blog/a-new");
    expect((await c.revisions("a-new")).items).toHaveLength(3);
    await expect(c.get("a")).rejects.toMatchObject({ status: 404 });
    expect((await c.rename("b", { newId: "b2", expectedVersion: b.version, changeId: "c6" })).previousPath).toBeNull();

    const other = client(memoryAdapter({ contentExtras: false })).c;
    await expect(other.rename("a", { newId: "b", expectedVersion: "v1", changeId: "c1" })).rejects.toMatchObject({ status: 501 });
  });
});

describe("the content trash (v0.15.0)", () => {
  it("takes a live post off the site, hides it from the list, restores a draft, and empties it after TRASH_DAYS", async () => {
    let time = new Date("2030-01-01T00:00:00Z");
    const adapter = memoryAdapter({ now: () => time });
    const { c } = client(adapter);
    const a = await c.saveDraft("a", { source: "# A\n", expectedVersion: null, changeId: "c1" });
    const live = await c.publish("a", { expectedVersion: a.version, changeId: "c2" });
    const trashed = await c.trash("a", { expectedVersion: live.version, changeId: "c3" });
    expect(trashed.status).toBe("draft");
    expect((await c.list()).items).toEqual([]);
    expect((await c.list({ trashed: true })).items.map((i) => i.id)).toEqual(["a"]);

    const back = await c.restore("a", { expectedVersion: trashed.version, changeId: "c4" });
    expect(back.status).toBe("draft");
    expect((await c.get("a")).trashedAt).toBeNull();
    await c.trash("a", { expectedVersion: back.version, changeId: "c5" });

    const api = createSiteApi({ adapter, key: KEY, limiter: allow, log: () => {} });
    time = new Date("2030-01-20T00:00:00Z");
    expect((await api.runSchedules({ now: time })).emptied).toBe(0);
    time = new Date("2030-02-01T00:00:01Z");
    expect((await api.runSchedules({ now: time })).emptied).toBe(1);
    expect(adapter.deletedContent).toEqual(["a"]);

    const other = client(memoryAdapter({ contentExtras: false })).c;
    await expect(other.list({ trashed: true })).rejects.toMatchObject({ status: 501 });
    await expect(other.trash("a", { expectedVersion: "v1", changeId: "c1" })).rejects.toMatchObject({ status: 501 });
  });

  // The two ways a deletion that cannot be undone could reach a post that is not old trash.
  it("never empties a trashed date it cannot read, and refuses a trash list from a site that ignored the filter", async () => {
    const adapter = memoryAdapter();
    const { c, fetch } = client(adapter);
    const a = await c.saveDraft("a", { source: "# A\n", expectedVersion: null, changeId: "c1" });
    await c.trash("a", { expectedVersion: a.version, changeId: "c2" });
    const list = adapter.content.list.bind(adapter.content);
    adapter.content.list = async (q) => {
      const page = await list(q);
      return { ...page, items: page.items.map((i) => ({ ...i, trashedAt: "1 Oct" })) };
    };
    const api = createSiteApi({ adapter, key: KEY, limiter: allow, log: () => {} });
    expect((await api.runSchedules({ now: new Date("2999-01-01T00:00:00Z") })).emptied).toBe(0);
    adapter.content.list = list;

    // A v0.14.0 site lists everything and names no filters.
    const old = async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = await (await fetch(input, init)).json();
      delete body.filtered;
      return Response.json(body);
    };
    const stale = createSiteClient({ baseUrl: ORIGIN, key: KEY, fetch: old as typeof globalThis.fetch });
    await expect(stale.list({ trashed: true })).rejects.toMatchObject({ status: 501 });
  });
});

describe("list filters (v0.15.0)", () => {
  it("filters by tag, author and published dates where the site offers them, and answers 501 for one it does not", async () => {
    const { c } = client();
    const a = await c.saveDraft("a", { source: '---\ntitle: A\ntags: [news]\nauthors: ["Ada", "Grace"]\n---\nA\n', expectedVersion: null, changeId: "c1" });
    await c.publish("a", { expectedVersion: a.version, changeId: "c2", publishedAt: "2020-01-01T00:00:00Z" });
    await c.saveDraft("b", { source: "---\ntitle: B\n---\nB\n", expectedVersion: null, changeId: "c3" });
    const ids = async (q: Parameters<typeof c.list>[0]) => (await c.list(q)).items.map((i) => i.id);
    expect(await ids({ tag: "news" })).toEqual(["a"]);
    expect(await ids({ author: "Grace" })).toEqual(["a"]);
    expect(await ids({ publishedAfter: "2019-01-01T00:00:00Z", publishedBefore: "2021-01-01T00:00:00Z" })).toEqual(["a"]);
    expect((await c.list({ author: "Ada" })).items[0]).toMatchObject({ authors: ["Ada", "Grace"] });

    const other = client(memoryAdapter({ contentExtras: false })).c;
    await expect(other.list({ tag: "news" })).rejects.toMatchObject({ status: 501 });
    expect((await other.list({ trashed: false })).items).toEqual([]);
  });
});
