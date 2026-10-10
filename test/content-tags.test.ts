// v0.6.0's content additions: each list row carries its version and tags, the list sorts and counts,
// and a post's tags are written through their own optional route.

import { describe, expect, it, vi } from "vitest";
import { createSiteClient, SiteApiError } from "../src/client.js";
import { memoryAdapter } from "../src/testing.js";
import { KEY, ORIGIN, body, req, site } from "./helpers.js";

function client(adapter = memoryAdapter()) {
  const s = site(adapter);
  return { ...s, adapter, client: createSiteClient({ baseUrl: ORIGIN, key: KEY, fetch: s.fetch }) };
}

async function seed(c: ReturnType<typeof client>["client"]) {
  const a = await c.saveDraft("a", { source: "---\ntitle: Zebra\ntags: [one, two]\n---\nA\n", expectedVersion: null, changeId: "c1" });
  await c.saveDraft("b", { source: "---\ntitle: Apple\n---\nB\n", expectedVersion: null, changeId: "c2" });
  await c.saveDraft("c", { source: "# No frontmatter\n", expectedVersion: null, changeId: "c3" });
  return a;
}

describe("content list (v0.6.0)", () => {
  it("carries each row's version and tags, and the total across pages", async () => {
    const { client: c } = client();
    const a = await seed(c);
    const page = await c.list({ limit: 1 });
    expect(page.items[0]).toMatchObject({ id: "a", version: a.version, tags: ["one", "two"] });
    expect(page.total).toBe(3);
    expect((await c.list({ limit: 2, cursor: page.nextCursor! })).items.map((i) => [i.id, i.tags])).toEqual([["b", []], ["c", undefined]]);
  });

  it("sorts as asked and says so; without a sort it says nothing", async () => {
    const { client: c } = client();
    await seed(c);
    const byTitle = await c.list({ sort: "title" });
    expect(byTitle.items.map((i) => i.title)).toEqual(["Apple", "No frontmatter", "Zebra"]);
    expect(byTitle.sorted).toEqual({ sort: "title", dir: "asc" });
    expect((await c.list({ sort: "title", dir: "desc" })).items.map((i) => i.id)).toEqual(["a", "c", "b"]);
    expect((await c.list()).sorted).toBeUndefined();
  });

  it("refuses a sort or a direction the contract does not name, before the adapter", async () => {
    const adapter = memoryAdapter();
    const spy = vi.spyOn(adapter.content, "list");
    const { api } = site(adapter);
    for (const q of ["sort=size", "dir=up"]) expect((await api.handle(req(`/api/carrel/v1/content?${q}`))).status, q).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("content tags (v0.6.0)", () => {
  it("sets a post's whole tag set at the version the caller saw, one spelling per tag, and keeps it live", async () => {
    const { client: c } = client();
    const a = await seed(c);
    const live = await c.publish("a", { expectedVersion: a.version, changeId: "p1" });
    const written = await c.setTags("a", { tags: ["News", "news", "Field notes"], expectedVersion: live.version, changeId: "t1" });
    expect(written).toMatchObject({ id: "a", status: "published", changeId: "t1" });
    const doc = await c.get("a");
    expect(doc.tags).toEqual(["News", "Field notes"]);
    expect(doc.source).toContain("tags: [News, Field notes]\n");
    expect(doc.version).toBe(written.version);
    expect((await c.meta()).capabilities.contentTags).toBe(true);
  });

  it("PLANT: refuses a stale version with 409, a missing post with 404, and a post with no frontmatter with the site's words", async () => {
    const { adapter, client: c } = client();
    const a = await seed(c);
    const before = structuredClone([...adapter.store.entries()]);
    const stale = await c.setTags("a", { tags: ["x"], expectedVersion: "v0", changeId: "t1" }).catch((e: unknown) => e);
    expect(stale).toMatchObject({ status: 409, body: { error: "version-conflict", currentVersion: a.version } });
    expect(await c.setTags("nope", { tags: ["x"], expectedVersion: "v0", changeId: "t2" }).catch((e: unknown) => e)).toMatchObject({ status: 404 });
    const bare = await c.setTags("c", { tags: ["x"], expectedVersion: (await c.get("c")).version, changeId: "t3" }).catch((e: unknown) => e);
    expect(bare).toMatchObject({ status: 422, body: { error: "refused" } });
    expect([...adapter.store.entries()]).toEqual(before);
  });

  it("PLANT: refuses a tag that would break a frontmatter list, before the adapter", async () => {
    const adapter = memoryAdapter();
    const spy = vi.spyOn(adapter.content, "setTags");
    const { api } = site(adapter);
    for (const tag of ["a,b", " lead", "x]", "c:d", ""]) {
      const response = await api.handle(req("/api/carrel/v1/content/a/tags", { method: "PUT", ...body({ tags: [tag], expectedVersion: "v1", changeId: "t1" }) }));
      expect(response.status, JSON.stringify(tag)).toBe(400);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("PLANT: answers 501 on a site that keeps no tags through the API, whatever the body says", async () => {
    const { adapter, client: c } = client(memoryAdapter({ contentTags: false }));
    const a = await seed(c);
    const error = await c.setTags("a", { tags: ["x"], expectedVersion: a.version, changeId: "t1" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SiteApiError);
    expect(error).toMatchObject({ status: 501 });
    expect(adapter.store.get("a")!.doc.version).toBe(a.version);
    expect((await c.meta()).capabilities.contentTags).toBeUndefined();
  });
});
