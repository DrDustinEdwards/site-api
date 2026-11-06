// v0.3.0: the source at a revision, and the optional content delete. Each plant is a request that
// must be refused; where the package refuses it, the test also checks that the adapter never ran.

import { describe, expect, it, vi } from "vitest";
import { RefusedError } from "../src/adapter.js";
import { createSiteClient, SiteApiError } from "../src/client.js";
import { memoryAdapter } from "../src/testing.js";
import { KEY, ORIGIN, req, site } from "./helpers.js";

function client(adapter = memoryAdapter()) {
  const s = site(adapter);
  return { ...s, client: createSiteClient({ baseUrl: ORIGIN, key: KEY, fetch: s.fetch }) };
}

async function seeded(adapter = memoryAdapter()) {
  const c = client(adapter);
  const first = await c.client.saveDraft("first-post", { source: "# First\n", expectedVersion: null, changeId: "c1" });
  const second = await c.client.saveDraft("first-post", { source: "# First, edited\n", expectedVersion: first.version, changeId: "c2" });
  return { ...c, first, second };
}

describe("the source at a revision", () => {
  it("opens each revision in the list with the source it had", async () => {
    const { client: c, first, second } = await seeded();
    const list = await c.revisions("first-post");
    expect(list.items.map((r) => r.version)).toEqual([second.version, first.version]);
    expect(await c.revision("first-post", first.version)).toEqual({ id: "first-post", version: first.version, source: "# First\n" });
    expect((await c.revision("first-post", second.version)).source).toBe("# First, edited\n");
  });

  it("answers 404 for a version or an item the site does not hold", async () => {
    const { client: c } = await seeded();
    await expect(c.revision("first-post", "no-such-version")).rejects.toMatchObject({ status: 404 });
    await expect(c.revision("no-such-post", "v1")).rejects.toMatchObject({ status: 404 });
  });

  it("refuses an id or a version that could not be one, before the site sees it", async () => {
    const adapter = memoryAdapter();
    const spy = vi.spyOn(adapter.content, "revisionSource");
    const { api } = site(adapter);
    expect((await api.handle(req("/api/carrel/v1/content/..%2Fx/revisions/v1"))).status).toBe(400);
    expect((await api.handle(req(`/api/carrel/v1/content/a/revisions/${"v".repeat(201)}`))).status).toBe(400);
    expect((await api.handle(req("/api/carrel/v1/content/a/revisions/%E0%A4%A"))).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("is refused without the key", async () => {
    const { api } = site();
    expect((await api.handle(req("/api/carrel/v1/content/a/revisions/v1", { key: null }))).status).toBe(401);
  });
});

describe("content delete", () => {
  it("deletes an item at the version the caller saw, and reports the change id", async () => {
    const { client: c, adapter, second } = await seeded();
    expect(await c.delete("first-post", { expectedVersion: second.version, changeId: "c3" })).toEqual({ id: "first-post", deleted: true, changeId: "c3" });
    expect(adapter.deletedContent).toEqual(["first-post"]);
    await expect(c.get("first-post")).rejects.toMatchObject({ status: 404 });
  });

  it("advertises the delete in meta, and not on a site without one", async () => {
    expect((await client().client.meta()).capabilities.contentDelete).toBe(true);
    expect((await client(memoryAdapter({ contentDelete: false })).client.meta()).capabilities.contentDelete).toBeUndefined();
  });

  it("PLANT: refuses a stale version with 409 and the current version, and deletes nothing", async () => {
    const { client: c, adapter, first, second } = await seeded();
    const error = await c.delete("first-post", { expectedVersion: first.version, changeId: "c3" }).catch((e) => e);
    expect(error).toBeInstanceOf(SiteApiError);
    expect(error.status).toBe(409);
    expect(error.body).toMatchObject({ error: "version-conflict", currentVersion: second.version });
    expect(adapter.store.has("first-post")).toBe(true);
    expect(adapter.deletedContent).toEqual([]);
  });

  it("PLANT: answers 404 for an item the site does not hold", async () => {
    const { client: c, adapter } = client();
    const error = await c.delete("no-such-post", { expectedVersion: "v1", changeId: "c3" }).catch((e) => e);
    expect(error.status).toBe(404);
    expect(error.body.error).toBe("not-found");
    expect(adapter.deletedContent).toEqual([]);
  });

  it("PLANT: answers 501 on a site whose adapter has no delete, and the item stays", async () => {
    const { client: c, adapter, second } = await seeded(memoryAdapter({ contentDelete: false }));
    const error = await c.delete("first-post", { expectedVersion: second.version, changeId: "c3" }).catch((e) => e);
    expect(error.status).toBe(501);
    expect(error.body.error).toBe("not-implemented");
    expect(adapter.store.has("first-post")).toBe(true);
  });

  it("PLANT: the site's own refusal comes back as 422 refused with its words, and the item stays", async () => {
    const adapter = memoryAdapter();
    const { client: c, second } = await seeded(adapter);
    adapter.content.delete = async () => {
      throw new RefusedError("The site keeps this page.");
    };
    const error = await c.delete("first-post", { expectedVersion: second.version, changeId: "c3" }).catch((e) => e);
    expect(error.status).toBe(422);
    expect(error.body).toMatchObject({ error: "refused", message: "The site keeps this page." });
    expect(adapter.store.has("first-post")).toBe(true);
  });

  it("PLANT: refused without the key or with a wrong one, before the adapter runs", async () => {
    const adapter = memoryAdapter();
    const spy = vi.fn(adapter.content.delete!);
    adapter.content.delete = spy;
    const { api } = site(adapter);
    const path = "/api/carrel/v1/content/first-post?expectedVersion=v1&changeId=c1";
    for (const key of [null, `${KEY}x`]) {
      expect((await api.handle(req(path, { method: "DELETE", key }))).status).toBe(401);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("PLANT: refuses a delete with no expectedVersion or change id, or a bad id, before the adapter runs", async () => {
    const adapter = memoryAdapter();
    const spy = vi.fn(adapter.content.delete!);
    adapter.content.delete = spy;
    const { api } = site(adapter);
    for (const path of [
      "/api/carrel/v1/content/first-post",
      "/api/carrel/v1/content/first-post?expectedVersion=v1",
      "/api/carrel/v1/content/first-post?changeId=c1",
      "/api/carrel/v1/content/first-post?expectedVersion=v1&changeId=has%20spaces",
      "/api/carrel/v1/content/..%2Fsecrets?expectedVersion=v1&changeId=c1",
    ]) {
      expect((await api.handle(req(path, { method: "DELETE" }))).status, path).toBe(400);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});
