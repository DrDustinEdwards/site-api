// The media library's ideas (v0.13.0), through the client against the reference site, with a PLANT for each refusal:
// the request is refused and the adapter's method never ran.

import { describe, expect, it, vi } from "vitest";
import { createSiteClient, SiteApiError } from "../src/client.js";
import { transformFocus } from "../src/media.js";
import { MEDIA_TRANSFORMS } from "../src/contract.js";
import { memoryAdapter, type MemoryAdapterOptions } from "../src/testing.js";
import { KEY, ORIGIN, body, png, req, site, withDns } from "./helpers.js";

function setup(options: MemoryAdapterOptions = {}) {
  const s = site(memoryAdapter(options));
  const client = createSiteClient({ baseUrl: ORIGIN, key: KEY, fetch: s.fetch });
  const put = (c: typeof client, name: string, bytes: Uint8Array, extra: { resize?: "no" } = {}) =>
    c.media.upload({ bytes, contentType: "image/png", filename: name, changeId: `u-${name.replace(/\W/g, "")}`, ...extra });
  return { ...s, client, put: (name: string, bytes: Uint8Array, extra?: { resize?: "no" }) => put(client, name, bytes, extra) };
}

async function status(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(SiteApiError);
  return (error as SiteApiError).status;
}

const path = (id: string, rest = "") => `/api/carrel/v1/media/${encodeURIComponent(id)}${rest}`;

describe("duplicates (1)", () => {
  it("answers bytes the site holds with that file and duplicateOf, storing nothing; the lens and twins name files that match", async () => {
    const { client, adapter, put } = setup({ mediaDuplicates: true });
    const first = await put("a.png", png(10, 10));
    const upload = vi.spyOn(adapter.media!, "upload");
    const again = await put("copy.png", png(10, 10));
    expect(again).toMatchObject({ id: first.id, duplicateOf: first.id });
    expect(upload).not.toHaveBeenCalled();
    expect(adapter.mediaStore.size).toBe(1);

    // Two files already holding the same bytes, as a site with older uploads might.
    await adapter.media!.upload({ bytes: png(10, 10), contentType: "image/png", filename: "old.png", alt: "", changeId: "seed", sha256: adapter.mediaStore.get(first.id)!.sha256! });
    expect((await client.media.list({ lens: "duplicates" })).items).toHaveLength(2);
    expect((await client.media.get(first.id)).twins).toEqual([{ id: "uploads/2-old.png", filename: "old.png" }]);
  });
});

describe("usage, filters and the item's new fields (2, 3, 5, 8)", () => {
  it("counts each file's uses, sorts most used first, and filters by orientation and kind", async () => {
    const { client, put } = setup();
    const wide = await put("wide.png", png(40, 20));
    const tall = await put("tall.png", png(20, 40));
    await client.saveDraft("p", { source: `# P\n![a](/media/${tall.id})\n![b](/media/${tall.id})\n`, expectedVersion: null, changeId: "c1" });
    const used = await client.media.list({ sort: "used" });
    expect(used.items.map((i) => [i.filename, i.usedCount])).toEqual([["tall.png", 2], ["wide.png", 0]]);
    expect(used.sorted).toEqual({ sort: "used", dir: "desc" });
    expect((await client.media.list({ orientation: "portrait" })).items.map((i) => i.id)).toEqual([tall.id]);
    expect((await client.media.list({ kind: "document" })).items).toEqual([]);
    expect(wide).toMatchObject({ width: 40, height: 20, downloadUrl: wide.url, placeholder: null, color: null });
  });

  it("PLANT: answers the used sort and the filters with 501 on a site without them, before the adapter", async () => {
    const { adapter, api } = setup({ mediaExtras: false });
    const list = vi.spyOn(adapter.media!, "list");
    for (const q of ["sort=used", "orientation=square", "kind=image", "changedSince=1"]) expect((await api.handle(req(`/api/carrel/v1/media?${q}`))).status, q).toBe(501);
    expect(list).not.toHaveBeenCalled();
  });

  it("PLANT: reports a placeholder that is not a small raster data: URI as a site failure, and never passes it on", async () => {
    const { adapter, api, put, logs } = setup();
    const file = await put("a.png", png(10, 10));
    for (const placeholder of ["data:image/svg+xml;base64,PHN2Zz4=", `data:image/png;base64,${"A".repeat(3000)}`]) {
      adapter.mediaStore.get(file.id)!.item.placeholder = placeholder;
      const response = await api.handle(req(path(file.id)));
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("data:image");
    }
    expect(logs).toContainEqual(expect.objectContaining({ siteApi: "contract-breach" }));
  });
});

describe("import (4)", () => {
  const remote = (answers: Record<string, Response | (() => Response)>) =>
    vi.fn(async (input: RequestInfo | URL) => {
      const answer = answers[String(input)];
      if (!answer) return new Response("no", { status: 404 });
      return typeof answer === "function" ? answer() : answer;
    }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

  it("fetches an https address, following a redirect, into the site's own storage, and keeps where it came from", async () => {
    const fetchRemote = remote({
      "https://photos.example.com/r/1": new Response(null, { status: 302, headers: { location: "/files/River%20at%20dusk.png" } }),
      "https://photos.example.com/files/River%20at%20dusk.png": new Response(png(30, 20) as Uint8Array<ArrayBuffer>, { headers: { "content-type": "image/png" } }),
    });
    const { client, adapter } = setup({ mediaImportFetch: withDns(fetchRemote) });
    const item = await client.media.importUrl({ url: "https://photos.example.com/r/1", alt: "A river", changeId: "i1" });
    expect(item).toMatchObject({ filename: "River at dusk.png", alt: "A river", sourceUrl: "https://photos.example.com/r/1", url: `/media/${item.id}` });
    expect(adapter.mediaStore.get(item.id)!.revisions![0]!.reason).toBe("import");
  });

  it("PLANT: refuses an address it must not fetch before fetching, and a redirect or a type it must not take before storing", async () => {
    const fetchRemote = remote({
      "https://bounce.example.com/a": new Response(null, { status: 301, headers: { location: "https://127.0.0.1/admin" } }),
      "https://pages.example.com/a": new Response("<html>", { headers: { "content-type": "text/html" } }),
    });
    // v0.19.0: a name that resolves to a private address is refused at the fetch, after DNS, before the site is asked.
    const { adapter, api } = setup({ mediaImportFetch: withDns(fetchRemote, { "127.0.0.1.nip.io": "127.0.0.1" }) });
    const upload = vi.spyOn(adapter.media!, "upload");
    const send = (url: string) => api.handle(req("/api/carrel/v1/media/import", { method: "POST", ...body({ url, changeId: "i1" }) }));
    for (const url of ["http://example.com/a.png", "https://10.0.0.1/a.png", "https://[::1]/a.png", "https://localhost/a.png", "https://example.com:8443/a.png", "https://me:pw@example.com/a.png", "https://intranet/a.png"]) {
      expect((await send(url)).status, url).toBe(400);
    }
    expect(fetchRemote).not.toHaveBeenCalled();
    expect((await send("https://127.0.0.1.nip.io/a.png")).status).toBe(422);
    expect(fetchRemote).not.toHaveBeenCalled();
    expect((await send("https://bounce.example.com/a")).status).toBe(422);
    expect(fetchRemote).toHaveBeenCalledTimes(1);
    expect((await send("https://pages.example.com/a")).status).toBe(400);
    expect(upload).not.toHaveBeenCalled();
    expect((await setup().api.handle(req("/api/carrel/v1/media/import", { method: "POST", ...body({ url: "https://example.com/a.png", changeId: "i1" }) }))).status).toBe(501);
  });
});

describe("credit, license and its end (6, 12, 13)", () => {
  it("saves the four as one write, lists an expired license, and fills empty fields from the file's own metadata at upload", async () => {
    const { client, put } = setup({ now: () => new Date("2026-10-29T12:00:00Z") });
    const embedded = await put("tagged.png", png(10, 10, { Author: "Ada Example", Copyright: "CC BY 4.0", "Creation Time": "2026-05-01T09:30:00Z" }));
    expect(embedded).toMatchObject({ credit: "Ada Example", license: "CC BY 4.0", takenAt: "2026-05-01T09:30:00.000Z", embedded: ["credit", "license", "takenAt"] });
    const file = await put("a.png", png(10, 10));
    expect(file.embedded).toBeUndefined();
    const written = await client.media.setCredit(file.id, { credit: " Grace ", license: "Licensed", sourceUrl: "https://example.com/p", licenseExpires: "2026-10-01", expectedVersion: file.version!, changeId: "c1" });
    expect(await client.media.get(file.id)).toMatchObject({ credit: "Grace", license: "Licensed", sourceUrl: "https://example.com/p", licenseExpires: "2026-10-01", version: written.version });
    expect((await client.media.list({ lens: "license-expired" })).items.map((i) => i.id)).toEqual([file.id]);
    expect(await status(client.media.setCredit(file.id, { credit: "", license: "", sourceUrl: null, licenseExpires: null, expectedVersion: file.version!, changeId: "c2" }))).toBe(409);
  });

  it("PLANT: refuses a source that is not a web address and a license end that is not a date, before the adapter", async () => {
    const { adapter, api, put } = setup();
    const file = await put("a.png", png(10, 10));
    const write = vi.spyOn(adapter.media!, "setCredit");
    const base = { credit: "", license: "", sourceUrl: null, licenseExpires: null, expectedVersion: file.version, changeId: "c1" };
    for (const bad of [{ sourceUrl: "javascript:alert(1)" }, { licenseExpires: "next year" }, { credit: "x".repeat(301) }]) {
      expect((await api.handle(req(path(file.id, "/credit"), { method: "PUT", ...body({ ...base, ...bad }) }))).status).toBe(400);
    }
    expect(write).not.toHaveBeenCalled();
  });
});

describe("transform, history and revert (7)", () => {
  it("turns in place moving the focal point, keeps the old bytes, and a revert puts them back as a new revision", async () => {
    const { client, put } = setup();
    const file = await put("a.png", png(40, 20));
    const focused = await client.media.setFocus(file.id, { focus: "0.1x0.2", expectedVersion: file.version!, changeId: "f1" });
    const turned = await client.media.transform(file.id, { op: "rotate-90", expectedVersion: focused.version, changeId: "t1" });
    expect(turned).toMatchObject({ id: file.id, url: file.url, width: 20, height: 40, focus: "0.8x0.1", asNewFile: false, changeId: "t1" });
    const history = await client.media.history(file.id);
    expect(history.revisions.map((r) => [r.reason, r.width, r.current])).toEqual([["transform", 20, true], ["upload", 40, false]]);
    const back = await client.media.revert(file.id, { to: history.revisions[1]!.rev, expectedVersion: turned.version!, changeId: "r1" });
    expect(back).toMatchObject({ width: 40, height: 20, focus: null, asNewFile: false });
    expect((await client.media.history(file.id)).revisions).toHaveLength(3);
    expect(await status(client.media.revert(file.id, { to: history.revisions[1]!.rev, expectedVersion: turned.version!, changeId: "r2" }))).toBe(409);
  });

  it("on a site whose addresses carry the size, saves a quarter turn of a picture that is not square as a new file, and turns the rest in place", async () => {
    const { client, adapter, put } = setup({ mediaReplaceKeepsSize: true });
    const wide = await put("wide.png", png(40, 20));
    const turned = await client.media.transform(wide.id, { op: "rotate-270", expectedVersion: wide.version!, changeId: "t1" });
    expect(turned).toMatchObject({ asNewFile: true, width: 20, height: 40 });
    expect(turned.id).not.toBe(wide.id);
    expect(adapter.mediaStore.get(wide.id)!.item).toMatchObject({ width: 40, height: 20, version: wide.version });
    expect(await client.media.transform(wide.id, { op: "rotate-180", expectedVersion: wide.version!, changeId: "t2" })).toMatchObject({ id: wide.id, asNewFile: false });
    const square = await put("square.png", png(20, 20));
    expect(await client.media.transform(square.id, { op: "rotate-90", expectedVersion: square.version!, changeId: "t3" })).toMatchObject({ id: square.id, asNewFile: false });
  });

  it("PLANT: refuses a turn of what is not a picture or not the site's to change, and a revert to the current bytes or another size, before the adapter", async () => {
    const { adapter, api, put } = setup({ mediaReplaceKeepsSize: true, media: { maxBytes: 1000, types: ["image/png", "application/pdf"] } });
    const file = await put("a.png", png(40, 20));
    const pdf = await adapter.media!.upload({ bytes: new TextEncoder().encode("%PDF-1.4"), contentType: "application/pdf", filename: "a.pdf", alt: "", changeId: "s" });
    adapter.mediaStore.get(file.id)!.item.deletable = false;
    const transform = vi.spyOn(adapter.media!, "transform");
    const revert = vi.spyOn(adapter.media!, "revert");
    const turn = (id: string, version: string) => api.handle(req(path(id, "/transform"), { method: "POST", ...body({ op: "flip-h", expectedVersion: version, changeId: "t" }) }));
    expect((await turn(pdf.id, pdf.version!)).status).toBe(422);
    expect((await turn(file.id, file.version!)).status).toBe(422);
    adapter.mediaStore.get(file.id)!.item.deletable = true;
    const current = adapter.mediaStore.get(file.id)!.revisions![0]!.rev;
    const back = (to: string) => api.handle(req(path(file.id, "/revert"), { method: "POST", ...body({ to, expectedVersion: file.version, changeId: "r" }) }));
    expect((await back(current)).status).toBe(422);
    expect((await back("r999")).status).toBe(404);
    // An earlier revision of another size, which this site's own writes never make.
    adapter.mediaStore.get(file.id)!.revisions!.unshift({ rev: "r0", at: "2026-01-01T00:00:00Z", bytes: 9, width: 10, height: 10, reason: "upload", data: png(10, 10) });
    expect((await back("r0")).status).toBe(422);
    expect(transform).not.toHaveBeenCalled();
    expect(revert).not.toHaveBeenCalled();
  });

  it("moves a focal point with every transform, so each and its inverse put it back", () => {
    const inverse = { "rotate-90": "rotate-270", "rotate-180": "rotate-180", "rotate-270": "rotate-90", "flip-h": "flip-h", "flip-v": "flip-v" } as const;
    for (const op of MEDIA_TRANSFORMS) expect(transformFocus(transformFocus("0.1x0.3", op), inverse[op]), op).toBe("0.1x0.3");
    expect(transformFocus("0.1x0.3", "rotate-90")).toBe("0.7x0.1");
    expect(transformFocus(null, "flip-h")).toBeNull();
  });
});

describe("live updates (10)", () => {
  it("answers what changed since a list's cursor, each file once, deletes as removed, in pages", async () => {
    const { client, put } = setup();
    const a = await put("a.png", png(10, 10));
    const start = (await client.media.list()).changeCursor!;
    const b = await put("b.png", png(10, 10));
    const alt = await client.media.setAlt(a.id, { alt: "One", expectedVersion: a.version!, changeId: "s1" });
    await client.media.setAlt(a.id, { alt: "Two", expectedVersion: alt.version, changeId: "s2" });
    await client.media.delete(b.id, { changeId: "d1" });
    const changes = await client.media.changes(start);
    expect(changes).toMatchObject({ items: [{ id: a.id, alt: "Two" }], removed: [b.id], moreChanges: false });
    expect((await client.media.changes(changes.changeCursor!)).items).toEqual([]);
    // The oldest change first: a's last alt came before b's delete.
    const paged = await client.media.changes(start, 1);
    expect(paged).toMatchObject({ items: [{ id: a.id }], removed: [], moreChanges: true });
    expect(await client.media.changes(paged.changeCursor!, 1)).toMatchObject({ items: [], removed: [b.id], moreChanges: false });
  });

  it("PLANT: refuses a poll with any other filter before the adapter, and a cursor the site cannot answer from", async () => {
    const { adapter, api } = setup();
    const changes = vi.spyOn(adapter.media!, "changes");
    for (const q of ["changedSince=0&lens=no-alt", "changedSince=0&cursor=5", "changedSince=0&q=x"]) expect((await api.handle(req(`/api/carrel/v1/media?${q}`))).status, q).toBe(400);
    expect(changes).not.toHaveBeenCalled();
    expect((await api.handle(req("/api/carrel/v1/media?changedSince=999"))).status).toBe(422);
  });
});

describe("shrinking large pictures (11)", () => {
  it("shrinks an upload to the site's longest edge unless asked not to, and a pass shrinks stored pictures file by file", async () => {
    const { client, put, adapter } = setup();
    expect((await client.meta()).capabilities.mediaResize).toEqual({ maxEdge: 2048, quality: 82 });
    const big = await put("big.png", png(4000, 3000));
    expect(big).toMatchObject({ width: 2048, height: 1536, resizedFrom: { width: 4000, height: 3000 } });
    const kept = await put("kept.png", png(4000, 3000, {}, 1), { resize: "no" });
    expect(kept).toMatchObject({ width: 4000, height: 3000 });
    expect(kept.resizedFrom).toBeUndefined();
    expect((await client.media.list({ lens: "oversized" })).items.map((i) => i.id)).toEqual([kept.id]);

    const pass = await client.media.resizePass({
      items: [
        { id: kept.id, expectedVersion: kept.version!, changeId: "p1" },
        { id: big.id, expectedVersion: big.version!, changeId: "p2" },
        { id: big.id, expectedVersion: "m0", changeId: "p3" },
      ],
    });
    expect(pass.results).toMatchObject([
      { ok: true, id: kept.id, resized: true, width: 2048, height: 1536 },
      { ok: true, id: big.id, resized: false, version: big.version },
      { ok: false, id: big.id, error: "version-conflict", currentVersion: big.version },
    ]);
    expect(adapter.mediaStore.get(kept.id)!.revisions!.map((r) => r.reason)).toEqual(["upload", "resize"]);
  });

  it("PLANT: refuses more files than one pass takes before the adapter, and offers no pass where addresses carry the size", async () => {
    const { adapter, api } = setup();
    const shrink = vi.spyOn(adapter.media!, "shrink");
    const items = Array.from({ length: 21 }, (_, n) => ({ id: `uploads/${n}.png`, expectedVersion: "m1", changeId: `p${n}` }));
    expect((await api.handle(req("/api/carrel/v1/media/resize-pass", { method: "POST", ...body({ items }) }))).status).toBe(400);
    expect(shrink).not.toHaveBeenCalled();
    const keeps = setup({ mediaReplaceKeepsSize: true });
    expect((await keeps.client.meta()).capabilities.mediaResizePass).toBeUndefined();
    expect((await keeps.api.handle(req("/api/carrel/v1/media/resize-pass", { method: "POST", ...body({ items: items.slice(0, 1) }) }))).status).toBe(501);
  });
});

describe("suggestions (14)", () => {
  it("answers the model's tags in the contract's spelling and its alt text, and applies neither", async () => {
    const { client, adapter, put } = setup();
    const file = await put("river at dusk.png", png(10, 10));
    expect(await status(client.media.suggestions("uploads/none.png"))).toBe(404);
    adapter.media!.suggest = async () => ({ tags: ["River", "golden hour", "dusk", "dusk", "not/a tag"], alt: "  The Brazos at dusk.  ", model: "@cf/example/vision" });
    expect(await client.media.suggestions(file.id)).toEqual({ id: file.id, tags: ["river", "golden-hour", "dusk"], alt: "The Brazos at dusk.", model: "@cf/example/vision" });
    expect(adapter.mediaStore.get(file.id)!.item).toMatchObject({ alt: "", tags: [], version: file.version });
  });

  it("PLANT: answers 501 on a site without a model, before the adapter", async () => {
    const { api, put } = setup({ mediaExtras: false });
    const file = await put("a.png", png(10, 10));
    expect((await api.handle(req(path(file.id, "/suggestions")))).status).toBe(501);
  });
});
