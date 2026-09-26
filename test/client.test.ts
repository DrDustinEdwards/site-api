// The whole content round trip through the client, as Carrel will drive it.

import { describe, expect, it } from "vitest";
import { createSiteClient, SiteApiError } from "../src/client.js";
import { schemaHash } from "../src/contract.js";
import { KEY, ORIGIN, site } from "./helpers.js";

function client() {
  const s = site();
  return { ...s, client: createSiteClient({ baseUrl: ORIGIN, key: KEY, fetch: s.fetch }) };
}

describe("client round trip", () => {
  it("reads meta with this contract's hash and the stage 2 capabilities", async () => {
    const { client: c } = client();
    const meta = await c.meta();
    expect(meta.schemaHash).toBe(await schemaHash());
    expect(meta.capabilities).toEqual({
      content: true,
      preview: true,
      media: false,
      inbox: false,
      insight: false,
      publications: false,
    });
  });

  it("creates, edits, publishes, schedules, unpublishes, lists, and diffs", async () => {
    const { client: c } = client();
    const created = await c.saveDraft("series-part-1", {
      source: "---\ntitle: Part one\n---\nFirst words.\n",
      expectedVersion: null,
      changeId: "chg-1",
    });
    expect(created).toMatchObject({ id: "series-part-1", status: "draft", changeId: "chg-1" });

    const edited = await c.saveDraft("series-part-1", {
      source: "---\ntitle: Part one\n---\nFirst words, revised.\n",
      expectedVersion: created.version,
      changeId: "chg-2",
    });

    const published = await c.publish("series-part-1", { expectedVersion: edited.version, changeId: "chg-3" });
    expect(published.status).toBe("published");
    const doc = await c.get("series-part-1");
    expect(doc).toMatchObject({ title: "Part one", status: "published", path: "/blog/series-part-1" });
    expect(doc.publishedAt).not.toBeNull();

    const unpublished = await c.unpublish("series-part-1", { expectedVersion: published.version, changeId: "chg-4" });
    expect(unpublished.status).toBe("draft");

    const scheduled = await c.schedule("series-part-1", {
      expectedVersion: unpublished.version,
      changeId: "chg-5",
      publishAt: "2030-01-01T09:00:00-06:00",
    });
    expect(scheduled.status).toBe("scheduled");

    const list = await c.list({ status: "scheduled" });
    expect(list.items.map((i) => i.id)).toEqual(["series-part-1"]);
    expect(await c.list({ q: "revised" })).toMatchObject({ items: [{ id: "series-part-1" }] });

    const revisions = await c.revisions("series-part-1");
    expect(revisions.items).toHaveLength(5);
    expect(revisions.items[0]!.message).toContain("chg-5");

    const diff = await c.diff("series-part-1", created.version);
    expect(diff.to).toBe(scheduled.version);
    expect(diff.patch).toContain("-First words.");
    expect(diff.patch).toContain("+First words, revised.");
  });

  it("renders a preview as full page HTML", async () => {
    const { client: c } = client();
    const html = await c.preview({ source: "---\ntitle: <Draft>\n---\nBody\n" });
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("&#60;Draft&#62;");
  });

  it("pages the list with a cursor", async () => {
    const { client: c } = client();
    for (const id of ["a", "b", "c"]) {
      await c.saveDraft(id, { source: `# ${id}\n`, expectedVersion: null, changeId: `chg-${id}` });
    }
    const first = await c.list({ limit: 2 });
    expect(first.items.map((i) => i.id)).toEqual(["a", "b"]);
    const second = await c.list({ limit: 2, cursor: first.nextCursor! });
    expect(second).toEqual({ items: [expect.objectContaining({ id: "c" })], nextCursor: null });
  });

  it("raises the site's refusal with its error body", async () => {
    const { client: c } = client();
    const error = await c.get("missing").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SiteApiError);
    expect(error).toMatchObject({ status: 404, body: { error: "not-found" } });
  });
});
