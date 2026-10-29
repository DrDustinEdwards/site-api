// A file's focal point, caption and replace (v0.10.0), through the client, and the R2 half a site's adapter uses.

import { FOCUS_METADATA, focusOf } from "@dustinedwards/site-runtime/image";
import { describe, expect, it } from "vitest";
import { createSiteClient, SiteApiError } from "../src/client.js";
import { replaceObject, writeFocus, type R2BucketLike, type R2ObjectLike } from "../src/r2.js";
import { memoryAdapter } from "../src/testing.js";
import { KEY, ORIGIN, body, req, site } from "./helpers.js";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const PNG2 = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2, 2]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);

function setup() {
  const s = site(memoryAdapter());
  const client = createSiteClient({ baseUrl: ORIGIN, key: KEY, fetch: s.fetch });
  return { ...s, client };
}

async function status(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(SiteApiError);
  return (error as SiteApiError).status;
}

describe("focal point and caption", () => {
  it("stores the point in focusOf's spelling, clears it, keeps a caption, and refuses a point off the picture", async () => {
    const { client, adapter, fetch } = setup();
    const file = await client.media.upload({ bytes: PNG, contentType: "image/png", filename: "a.png", changeId: "u" });
    expect(file).toMatchObject({ focus: null, caption: "" });

    const set = await client.media.setFocus(file.id, { focus: "0.250x0.4", expectedVersion: file.version!, changeId: "f1" });
    expect((await client.media.get(file.id)).focus).toBe("0.25x0.4");
    const captioned = await client.media.setCaption(file.id, { caption: "The Brazos at dusk.", expectedVersion: set.version, changeId: "c1" });
    expect((await client.media.get(file.id)).caption).toBe("The Brazos at dusk.");

    const off = await fetch(req(`/api/carrel/v1/media/${encodeURIComponent(file.id)}/focus`, { method: "PUT", ...body({ focus: "1.5x0", expectedVersion: captioned.version, changeId: "f2" }) }));
    expect(off.status).toBe(400);
    expect(await status(client.media.setFocus(file.id, { focus: null, expectedVersion: set.version, changeId: "f3" }))).toBe(409);
    await client.media.setFocus(file.id, { focus: null, expectedVersion: captioned.version, changeId: "f4" });
    expect(adapter.mediaStore.get(file.id)?.item).toMatchObject({ focus: null, caption: "The Brazos at dusk." });
  });
});

describe("replace", () => {
  it("keeps the id, the address, alt, caption and tags, clears the focal point, and refuses a stale version or another type", async () => {
    const { client, adapter } = setup();
    const file = await client.media.upload({ bytes: PNG, contentType: "image/png", filename: "a.png", alt: "A river", changeId: "u" });
    const tagged = await client.media.setTags(file.id, { tags: ["river"], expectedVersion: file.version!, changeId: "t" });
    const focused = await client.media.setFocus(file.id, { focus: "0.2x0.8", expectedVersion: tagged.version, changeId: "f" });

    const replaced = await client.media.replace(file.id, { bytes: PNG2, contentType: "image/png", filename: "a-v2.png", expectedVersion: focused.version, changeId: "r1" });
    expect(replaced).toMatchObject({ id: file.id, url: file.url, alt: "A river", tags: ["river"], focus: null, bytes: 10, filename: "a-v2.png", changeId: "r1", sizesNeedPurge: false });
    expect(replaced.version).not.toBe(focused.version);
    expect(adapter.mediaStore.get(file.id)?.bytes).toEqual(PNG2);

    const again = { bytes: PNG, filename: "a.png", changeId: "r2" };
    expect(await status(client.media.replace(file.id, { ...again, contentType: "image/png", expectedVersion: focused.version }))).toBe(409);
    expect(await status(client.media.replace(file.id, { ...again, bytes: JPEG, contentType: "image/jpeg", expectedVersion: replaced.version! }))).toBe(400);
    expect(await status(client.media.replace("uploads/none.png", { ...again, contentType: "image/png", expectedVersion: replaced.version! }))).toBe(404);
    expect(adapter.mediaStore.get(file.id)?.bytes).toEqual(PNG2);
  });
});

/** An R2 bucket in memory, with R2's conditional put: a stale etag writes nothing and answers null. */
function bucket() {
  const objects = new Map<string, R2ObjectLike & { bytes: Uint8Array }>();
  let n = 0;
  const b: R2BucketLike = {
    head: async (key) => objects.get(key) ?? null,
    get: async (key) => {
      const o = objects.get(key);
      return o ? { ...o, arrayBuffer: async () => o.bytes.slice().buffer } : null;
    },
    put: async (key, value, options) => {
      if (objects.get(key)?.etag !== options.onlyIf.etagMatches) return null;
      const etag = `e${++n}`;
      const o = { etag, httpEtag: `"${etag}"`, httpMetadata: options.httpMetadata ?? {}, customMetadata: options.customMetadata ?? {}, bytes: new Uint8Array(value) };
      objects.set(key, o);
      return o;
    },
  };
  objects.set("a.png", { etag: "e0", httpEtag: '"e0"', httpMetadata: { contentType: "image/png", cacheControl: "public" }, customMetadata: { originalName: "A.png" }, bytes: PNG });
  return { b, objects };
}

describe("the R2 half", () => {
  it("writes the focal point where site-runtime's image route reads it, and a replace keeps the metadata but the point", async () => {
    const { b, objects } = bucket();
    await writeFocus(b, "a.png", "0.30x0.7");
    expect(focusOf(objects.get("a.png")!.customMetadata![FOCUS_METADATA])).toBe("0.3x0.7");
    expect(objects.get("a.png")).toMatchObject({ customMetadata: { originalName: "A.png" }, bytes: PNG });

    await expect(replaceObject(b, "a.png", { bytes: JPEG, contentType: "image/jpeg" })).rejects.toThrow(/image\/png/);
    const written = await replaceObject(b, "a.png", { bytes: PNG2, contentType: "image/png" });
    expect(objects.get("a.png")).toMatchObject({ httpMetadata: { contentType: "image/png", cacheControl: "public" }, customMetadata: { originalName: "A.png" }, bytes: PNG2 });
    expect(objects.get("a.png")!.customMetadata![FOCUS_METADATA]).toBeUndefined();

    // Another write lands between the read and the put: refused, and the other write stands.
    const raced: R2BucketLike = { ...b, get: async (key) => ({ ...(await b.get(key))!, etag: "stale" }) };
    await expect(writeFocus(raced, "a.png", "0.5x0.5")).rejects.toThrow(/changed/);
    expect(objects.get("a.png")!.etag).toBe(written.etag);
  });
});
