// Alt text asked at upload, and the model's suggestion before it (v0.19.0), through the client against the reference
// site, with a PLANT for each refusal: the request is refused and the adapter's method never ran.

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createSiteClient, SiteApiError } from "../src/client.js";
import { memoryAdapter, type MemoryAdapterOptions } from "../src/testing.js";
import { KEY, ORIGIN, png, req, site } from "./helpers.js";

function setup(options: MemoryAdapterOptions = {}) {
  const s = site(memoryAdapter(options));
  return { ...s, client: createSiteClient({ baseUrl: ORIGIN, key: KEY, fetch: s.fetch }) };
}

const refusal = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: unknown) => (e instanceof SiteApiError ? `${e.status} ${e.body?.message}` : e),
  );

describe("alt at upload (B2, B3)", () => {
  it("PLANT: refuses an upload or an import with no alt and no decorative choice, or an alt that is the file's name, before the adapter", async () => {
    const remote = vi.fn(async () => new Response(png(4, 4) as Uint8Array<ArrayBuffer>, { headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
    const { adapter, client } = setup({ mediaImportFetch: remote });
    const upload = vi.spyOn(adapter.media!, "upload");
    const file = { bytes: png(4, 4), contentType: "image/png", filename: "river-dusk.png", changeId: "u1" };
    expect(await refusal(client.media.upload(file))).toMatch(/^400 alt: Say what the picture shows/);
    expect(await refusal(client.media.upload({ ...file, alt: "River dusk" }))).toMatch(/^400 alt: Alt text says what the picture shows, not its file name/);
    expect(await refusal(client.media.upload({ ...file, alt: "Photo" }))).toMatch(/^400 alt:/);
    expect(await refusal(client.media.upload({ ...file, alt: "x".repeat(251) }))).toMatch(/^400 alt: Alt text is at most 250 characters/);
    expect(await refusal(client.media.upload({ ...file, alt: "A river", decorative: true }))).toMatch(/^400 alt: A decorative picture has no alt text/);
    expect(await refusal(client.media.importUrl({ url: "https://photos.example.com/a.png", changeId: "i1" }))).toMatch(/^400 alt:/);
    expect(upload).not.toHaveBeenCalled();
    expect(remote).not.toHaveBeenCalled();

    // A decorative picture is stored with alt "" on purpose, and the no-alt lens leaves it out; clearing an alt is the same choice.
    const plain = await client.media.upload({ ...file, decorative: true });
    const described = await client.media.upload({ ...file, bytes: png(5, 5), filename: "b.png", alt: "The Paluxy River at dusk", changeId: "u2" });
    expect(plain).toMatchObject({ alt: "", decorative: true });
    expect(described.alt).toBe("The Paluxy River at dusk");
    expect(await refusal(client.media.setAlt(described.id, { alt: "", expectedVersion: described.version!, changeId: "a1" }))).toMatch(/^400 alt: Say what/);
    await client.media.setAlt(described.id, { alt: " ", decorative: true, expectedVersion: described.version!, changeId: "a2" });
    expect((await client.media.list({ lens: "no-alt" })).items).toEqual([]);
  });

  it("takes a replacement's private metadata out before the site stores it", async () => {
    const { adapter, client } = setup();
    const photo = new Uint8Array(readFileSync(new URL("./fixtures/photo.jpg", import.meta.url)));
    const file = await client.media.upload({ bytes: photo, contentType: "image/jpeg", filename: "a.jpg", alt: "A test picture", changeId: "u1" });
    await client.media.replace(file.id, { bytes: photo, contentType: "image/jpeg", filename: "a.jpg", expectedVersion: file.version!, changeId: "r1" });
    const stored = Buffer.from(adapter.mediaStore.get(file.id)!.bytes).toString("latin1");
    expect(["GPS", "SN-SAMPLE", "Sample City"].filter((p) => stored.includes(p))).toEqual([]);
  });
});

describe("suggestions before an upload (B4)", () => {
  it("answers the model's alt text and tags for bytes or an import's address, storing nothing", async () => {
    const remote = vi.fn(async () => new Response(png(6, 6) as Uint8Array<ArrayBuffer>, { headers: { "content-type": "image/png" } })) as unknown as typeof fetch;
    const { adapter, client } = setup({ mediaImportFetch: remote });
    expect((await client.meta()).capabilities.mediaUploadSuggestions).toBe(true);
    const bytes = png(4, 4);
    expect(await client.media.suggestFile({ bytes, contentType: "image/png" })).toEqual({ tags: ["upload"], alt: `A picture of ${bytes.length} bytes.`, model: "memory-suggester" });
    expect((await client.media.suggestFile({ url: "https://photos.example.com/a.png" })).alt).toBe(`A picture of ${png(6, 6).length} bytes.`);
    expect(adapter.mediaStore.size).toBe(0);
  });

  it("PLANT: answers 501 on a site without it and 400 for what is not a picture or not an address it may fetch, before the model", async () => {
    const { adapter, api } = setup();
    const suggest = vi.spyOn(adapter.media!, "suggestFile");
    const send = (query: string, type = "image/png") => api.handle(req(`/api/carrel/v1/media/suggestions${query}`, { method: "POST", body: new Blob([png(4, 4) as Uint8Array<ArrayBuffer>]), headers: { "content-type": type } }));
    expect((await send("", "application/pdf")).status).toBe(400);
    expect((await send("?url=https%3A%2F%2Fexample.com%2Fa.png")).status).toBe(501);
    expect(suggest).not.toHaveBeenCalled();
    delete adapter.media!.suggestFile;
    expect((await site(adapter).api.handle(req("/api/carrel/v1/media/suggestions", { method: "POST" }))).status).toBe(501);
  });
});
