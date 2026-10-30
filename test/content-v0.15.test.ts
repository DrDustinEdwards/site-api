// v0.15.0: the content group's new writes and list options, each optional per site, against the reference adapter.

import { describe, expect, it } from "vitest";
import { createSiteClient } from "../src/client.js";
import { memoryAdapter } from "../src/testing.js";
import { KEY, ORIGIN, site } from "./helpers.js";

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
