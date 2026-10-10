// The media group (v0.2.0): the round trip through the client, and the plants. Each plant is a
// request that must be refused; where the package refuses it, the test also checks that the
// adapter never ran, so a refusal cannot come from the site's own code by accident.

import { describe, expect, it, vi } from "vitest";
import { createSiteClient, SiteApiError } from "../src/client.js";
import { memoryAdapter } from "../src/testing.js";
import { KEY, ORIGIN, req, site } from "./helpers.js";

const PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);

function spied(options: Parameters<typeof memoryAdapter>[0] = {}) {
  const adapter = memoryAdapter(options);
  const calls = vi.fn();
  const media = adapter.media!;
  for (const name of ["list", "get", "upload", "delete"] as const) {
    const fn = media[name] as (...a: unknown[]) => unknown;
    (media as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      calls(name);
      return fn(...args);
    };
  }
  return { adapter, calls };
}

function client(adapter = memoryAdapter()) {
  const s = site(adapter);
  return { ...s, client: createSiteClient({ baseUrl: ORIGIN, key: KEY, fetch: s.fetch }) };
}

function upload(bytes: Uint8Array, type: string, filename = "photo.png", headers: Record<string, string> = {}) {
  return req(`/api/carrel/v1/media?filename=${encodeURIComponent(filename)}&changeId=c1`, {
    method: "POST",
    body: new Blob([bytes as Uint8Array<ArrayBuffer>]),
    headers: { "content-type": type, ...headers },
  });
}

describe("media round trip", () => {
  it("uploads, lists, searches, reads and deletes a file through the client", async () => {
    const { client: c, adapter } = client();
    const item = await c.media.upload({ bytes: PNG, contentType: "image/png", filename: "Paluxy River.png", alt: "The river", changeId: "c1" });
    expect(item).toMatchObject({ url: `/media/${item.id}`, filename: "Paluxy River.png", contentType: "image/png", bytes: PNG.byteLength, alt: "The river", deletable: true });
    expect(adapter.mediaStore.get(item.id)?.bytes).toEqual(PNG);

    await c.media.upload({ bytes: JPEG, contentType: "image/jpeg", filename: "tracks.jpg", changeId: "c2" });
    expect((await c.media.list()).items.map((i) => i.filename)).toEqual(["tracks.jpg", "Paluxy River.png"]);
    expect((await c.media.list({ q: "river" })).items.map((i) => i.id)).toEqual([item.id]);
    expect(await c.media.list({ limit: 1 })).toMatchObject({ items: [{ filename: "tracks.jpg" }], nextCursor: "1" });

    expect(await c.media.get(item.id)).toMatchObject({ id: item.id, usedBy: [] });
    expect(await c.media.delete(item.id, "c3")).toEqual({ id: item.id, deleted: true, changeId: "c3" });
    expect(adapter.deleted).toEqual([item.id]);
    await expect(c.media.get(item.id)).rejects.toMatchObject({ status: 404 });
  });

  it("strips a type's parameters and accepts the site's type in any case", async () => {
    const { api } = site();
    const response = await api.handle(upload(PNG, "Image/PNG; charset=binary"));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ contentType: "image/png" });
  });
});

describe("PLANT: deleting a file a post uses", () => {
  it("is refused with the post named, and deletes once the post stops using it", async () => {
    const { client: c, adapter } = client();
    const item = await c.media.upload({ bytes: PNG, contentType: "image/png", filename: "cover.png", changeId: "c1" });
    const saved = await adapter.content.saveDraft("river-post", {
      source: `---\ntitle: The river\n---\nIntro.\n\n![The river](${item.url})\n`,
      expectedVersion: null,
      changeId: "c2",
    });

    expect(await c.media.get(item.id)).toMatchObject({ usedBy: [{ type: "post", id: "river-post", title: "The river", detail: "line 6" }] });
    const refused = await c.media.delete(item.id, "c3").catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(SiteApiError);
    const error = refused as SiteApiError;
    expect(error.status).toBe(422);
    expect(error.body).toMatchObject({ error: "refused", usedBy: [{ id: "river-post", title: "The river" }] });
    expect(error.body!.message).toContain("The river (line 6)");
    expect(adapter.mediaStore.has(item.id)).toBe(true);
    expect(adapter.deleted).toEqual([]);

    await adapter.content.saveDraft("river-post", { source: "---\ntitle: The river\n---\nIntro.\n", expectedVersion: saved.version, changeId: "c4" });
    expect(await c.media.delete(item.id, { changeId: "c5" })).toMatchObject({ deleted: true, changeId: "c5" });
  });

  it("names every post that uses it", async () => {
    const { client: c, adapter } = client();
    const item = await c.media.upload({ bytes: PNG, contentType: "image/png", filename: "shared.png", changeId: "c1" });
    for (const id of ["one", "two"]) await adapter.content.saveDraft(id, { source: `# Post ${id}\n\n![](${item.url})\n`, expectedVersion: null, changeId: `s-${id}` });
    const error = (await c.media.delete(item.id, "c2").catch((e: unknown) => e)) as SiteApiError;
    expect(error.body?.usedBy?.map((u) => u.id)).toEqual(["one", "two"]);
  });
});

describe("PLANT: an upload the site does not accept", () => {
  it("refuses a file over the site's limit, and never hands it to the site", async () => {
    const { adapter, calls } = spied({ media: { maxBytes: 100, types: ["image/png"] } });
    const { api } = site(adapter);
    const big = new Uint8Array(101);
    big.set(PNG.subarray(0, 8));
    const response = await api.handle(upload(big, "image/png"));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "too-large" });
    expect(calls).not.toHaveBeenCalled();
    expect(adapter.mediaStore.size).toBe(0);
  });

  it("refuses a file that declares a length over the limit, before reading it", async () => {
    const { adapter, calls } = spied({ media: { maxBytes: 100, types: ["image/png"] } });
    const { api } = site(adapter);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(PNG);
        controller.close();
      },
      // No read-ahead: a pull happens only when someone reads.
    }, { highWaterMark: 0 });
    const request = new Request(`${ORIGIN}/api/carrel/v1/media?filename=a.png&changeId=c1`, {
      method: "POST",
      body,
      headers: { authorization: `Bearer ${KEY}`, "content-type": "image/png", "content-length": "1000000" },
      duplex: "half",
    } as RequestInit);
    const response = await api.handle(request);
    expect(response.status).toBe(413);
    expect(pulled).toBe(0);
    expect(calls).not.toHaveBeenCalled();
  });

  it("refuses a type the site did not declare, and never hands it to the site", async () => {
    const { adapter, calls } = spied({ media: { maxBytes: 1000, types: ["image/png"] } });
    const { api } = site(adapter);
    for (const [type, bytes] of [
      ["text/html", new TextEncoder().encode("<script>alert(1)</script>")],
      ["image/svg+xml", new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>")],
      ["image/jpeg", JPEG],
      ["", PNG],
    ] as const) {
      const response = await api.handle(upload(bytes, type));
      expect(response.status, type).toBe(400);
      expect(await response.json(), type).toMatchObject({ error: "invalid" });
    }
    expect(calls).not.toHaveBeenCalled();
  });

  it("refuses bytes that are not the type they were sent as", async () => {
    const { adapter, calls } = spied();
    const { api } = site(adapter);
    for (const [type, bytes] of [
      ["image/png", JPEG],
      ["image/jpeg", PNG],
      ["image/png", new TextEncoder().encode("<html>not an image</html>")],
      ["image/svg+xml", new TextEncoder().encode("plain text, no svg element")],
      ["image/gif", PNG],
      ["image/webp", PNG],
    ] as const) {
      const response = await api.handle(upload(bytes, type));
      expect(response.status, `${type} carrying other bytes`).toBe(400);
      expect((await response.json()).message).toContain("do not match");
    }
    expect(calls).not.toHaveBeenCalled();
  });

  it("refuses an empty file, and a file name carrying a path", async () => {
    const { adapter, calls } = spied();
    const { api } = site(adapter);
    expect((await api.handle(upload(new Uint8Array(0), "image/png"))).status).toBe(400);
    for (const name of ["../evil.png", "dir/evil.png", "dir\\evil.png"]) {
      expect((await api.handle(upload(PNG, "image/png", name))).status, name).toBe(400);
    }
    expect(calls).not.toHaveBeenCalled();
  });
});

describe("PLANT: a media id that climbs out", () => {
  for (const id of ["../secret", "a/../../b", "/etc/passwd", "a//b", ".hidden", "%00"]) {
    it(`refuses ${JSON.stringify(id)} for get and delete, before the site sees it`, async () => {
      const { adapter, calls } = spied();
      const { api } = site(adapter);
      const path = `/api/carrel/v1/media/${encodeURIComponent(id)}`;
      expect((await api.handle(req(path))).status).toBe(400);
      expect((await api.handle(req(`${path}?changeId=c1`, { method: "DELETE" }))).status).toBe(400);
      expect(calls).not.toHaveBeenCalled();
    });
  }

  it("refuses a delete with no changeId", async () => {
    const { adapter, calls } = spied();
    const { api } = site(adapter);
    expect((await api.handle(req("/api/carrel/v1/media/uploads%2F1-a.png", { method: "DELETE" }))).status).toBe(400);
    expect(calls).not.toHaveBeenCalled();
  });
});

describe("PLANT: a site answering outside the media contract", () => {
  it("is reported as a site failure, and its answer is never passed on", async () => {
    const adapter = memoryAdapter();
    adapter.media!.list = async () => ({ items: [{ id: "../x", url: "javascript:alert(1)" }], nextCursor: null }) as never;
    const { api, logs } = site(adapter);
    const response = await api.handle(req("/api/carrel/v1/media"));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal", message: "The site answered outside the contract." });
    expect(logs).toContainEqual(expect.objectContaining({ siteApi: "contract-breach" }));
  });
});
