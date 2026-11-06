// The shared media library (v0.24.0) over its D1 store, an R2 bucket and the Images binding, each faked at its edge. The
// conformance suite runs over it, then each behavior the seven sites' own copies disagreed on is checked once.

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { d1MediaStore, mediaLibrary, MEDIA_LIBRARY_SQL, type D1BatchLike, type MediaBucket, type MediaLibraryOptions, type MediaUse, type UploadImages } from "../src/index.js";
import { runConformance } from "../src/conformance.js";
import { memoryAdapter } from "../src/testing.js";
import { KEY, ORIGIN, png, site } from "./helpers.js";

/** SQLite as D1, with D1's batch: the statements run in one transaction. */
function d1(sql: string): D1BatchLike & { db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  db.exec(sql);
  type Bound = { sql: string; values: unknown[] };
  const statement = (sql: string, values: unknown[] = []) => {
    const s = {
      bound: { sql, values } as Bound,
      bind: (...next: unknown[]) => statement(sql, next),
      first: async <T>() => (db.prepare(sql).get(...(values as never[])) ?? null) as T | null,
      all: async <T>() => ({ results: db.prepare(sql).all(...(values as never[])) as T[] }),
      run: async () => db.prepare(sql).run(...(values as never[])),
    };
    return s;
  };
  return {
    db,
    prepare: (sql) => statement(sql),
    batch: async (statements) => {
      db.exec("BEGIN");
      try {
        const out = statements.map((s) => {
          const { sql, values } = (s as unknown as { bound: Bound }).bound;
          return { results: db.prepare(sql).all(...(values as never[])) };
        });
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

/** An R2 bucket in memory, with etags and conditional puts. */
function bucket(): MediaBucket & { objects: Map<string, { bytes: Uint8Array; etag: string; httpMetadata?: Record<string, unknown>; customMetadata?: Record<string, string> }> } {
  const objects = new Map<string, { bytes: Uint8Array; etag: string; httpMetadata?: Record<string, unknown>; customMetadata?: Record<string, string> }>();
  let n = 0;
  const view = (key: string) => {
    const o = objects.get(key);
    return o ? { etag: o.etag, httpEtag: `"${o.etag}"`, httpMetadata: o.httpMetadata as never, customMetadata: o.customMetadata } : null;
  };
  return {
    objects,
    head: async (key) => view(key),
    get: async (key) => {
      const o = objects.get(key);
      if (!o) return null;
      return { ...view(key)!, body: new Response(o.bytes.slice()).body!, arrayBuffer: async () => o.bytes.slice().buffer };
    },
    put: async (key, value, options = {}) => {
      if (options.onlyIf && objects.get(key)?.etag !== options.onlyIf.etagMatches) return null;
      const bytes = value instanceof ReadableStream ? new Uint8Array(await new Response(value).arrayBuffer()) : new Uint8Array(value instanceof Uint8Array ? value : new Uint8Array(value));
      objects.set(key, { bytes, etag: `e${++n}`, ...(options.httpMetadata ? { httpMetadata: options.httpMetadata } : {}), ...(options.customMetadata ? { customMetadata: options.customMetadata } : {}) });
      return view(key);
    },
    delete: async (keys) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) objects.delete(key);
    },
    list: async ({ prefix }) => ({ objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }),
  };
}

const sizeOf = (bytes: Uint8Array) => {
  const be = (at: number) => ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
  return { width: be(16), height: be(20) };
};

/** The Images binding over the test's PNGs: it measures their IHDR, and a turn or a shrink answers a PNG of the new size. */
function imagesOf(): UploadImages {
  const read = async (stream: ReadableStream) => new Uint8Array(await new Response(stream).arrayBuffer());
  return {
    info: async (stream) => sizeOf(await read(stream)),
    input: (stream) => {
      const source = read(stream);
      const output = (options: Record<string, unknown>) => async ({ format }: { format: string }) => {
        const { width, height } = sizeOf(await source);
        if (format !== "image/png" && options.blur) return { response: () => new Response("RIFF\0\0\0\0WEBPVP8 ") };
        const edge = typeof options.width === "number" && options.fit === "scale-down" ? options.width : null;
        const scale = edge ? Math.min(1, edge / Math.max(width, height)) : 1;
        const [w, h] = [Math.round(width * scale), Math.round(height * scale)];
        const turned = options.rotate === 90 || options.rotate === 270;
        return { response: () => new Response(png(turned ? h : w, turned ? w : h, {}, 7).slice().buffer) };
      };
      return { output: output({}), transform: (options: object) => ({ output: output(options as Record<string, unknown>) }) };
    },
  };
}

function library(overrides: Partial<MediaLibraryOptions> & { uses?: Map<string, MediaUse[]> } = {}) {
  const db = d1(MEDIA_LIBRARY_SQL + "CREATE TABLE posts (id TEXT PRIMARY KEY, body TEXT NOT NULL);");
  const media = bucket();
  const store = d1MediaStore(db, { inUse: "EXISTS (SELECT 1 FROM posts WHERE instr(body, '/media/' || ?) > 0)" });
  const adapter = mediaLibrary({
    store,
    bucket: media,
    images: imagesOf(),
    limits: { maxBytes: 5 * 1024 * 1024, types: ["image/png"] },
    url: (key) => `/media/${key}`,
    resize: { maxEdge: 1000, quality: 85 },
    now: () => new Date("2026-11-06T12:00:00.000Z"),
    ...overrides,
  });
  return { db, media, adapter };
}

const upload = (adapter: ReturnType<typeof library>["adapter"], bytes: Uint8Array, alt = "A heron on the river bank") =>
  adapter.upload({ bytes, contentType: "image/png", filename: "heron.png", alt, changeId: `c-${Math.random()}`, resize: true });

describe("media library", () => {
  it("passes the conformance suite as a site's whole media group", async () => {
    const { adapter } = library();
    const { fetch } = site({ ...memoryAdapter(), media: adapter });
    const report = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch, probeMediaUpload: true });
    expect(report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail ?? ""}`)).toEqual([]);
  });

  it("keeps each version, the bytes it replaced and the focal point through a replace, a shrink and a revert", async () => {
    const { adapter, media, db } = library();
    const item = await upload(adapter, png(800, 600));
    expect(item.id).toMatch(/^uploads\/2026\/11\/heron-[0-9a-f]{8}\.png$/);
    expect(item).toMatchObject({ width: 800, height: 600, version: "r0" });

    // A stale version is refused before anything changes.
    await expect(adapter.setAlt!(item.id, { alt: "A heron", expectedVersion: "r9", changeId: "c-a" })).rejects.toMatchObject({ name: "VersionConflictError" });
    const { version } = await adapter.setFocus!(item.id, { focus: "0.25x0.75", expectedVersion: "r0", changeId: "c-f" });
    expect(media.objects.get(item.id)!.customMetadata).toMatchObject({ focus: "0.25x0.75" });

    // Trash twice at one version is one write.
    const trashed = await adapter.trash!(item.id, { expectedVersion: version, changeId: "c-t" });
    expect(await adapter.trash!(item.id, { expectedVersion: trashed.version, changeId: "c-t2" })).toEqual(trashed);
    const restored = await adapter.restore!(item.id, { expectedVersion: trashed.version, changeId: "c-r" });

    // A replace with a picture over the size; its shrink keeps the focal point on the row and on the object.
    const replaced = await adapter.replace!(item.id, { bytes: png(2000, 1500), contentType: "image/png", filename: "heron-2.png", expectedVersion: restored.version, changeId: "c-p" });
    expect(replaced.item).toMatchObject({ width: 2000, filename: "heron-2.png", focus: null, version: "r4" });
    await adapter.setFocus!(item.id, { focus: "0.5x0.5", expectedVersion: "r4", changeId: "c-f2" });
    const shrunk = await adapter.shrink!(item.id, { expectedVersion: "r5", changeId: "c-s" });
    expect(shrunk).toMatchObject({ resized: true, item: { width: 1000, height: 750, focus: "0.5x0.5", version: "r6" } });
    expect(media.objects.get(item.id)!.customMetadata).toMatchObject({ focus: "0.5x0.5" });

    const history = await adapter.history!(item.id);
    expect(history!.map((r) => [r.reason, r.width, r.current])).toEqual([
      ["resize", 1000, true],
      ["replace", 2000, false],
      ["upload", 800, false],
    ]);
    const reverted = await adapter.revert!(item.id, { to: history![2]!.rev, expectedVersion: "r6", changeId: "c-v" });
    expect(reverted.item).toMatchObject({ width: 800, height: 600, focus: null, version: "r7" });
    expect(sizeOf(media.objects.get(item.id)!.bytes)).toEqual({ width: 800, height: 600 });

    // Every change is in the log, once per file.
    const changes = await adapter.changes!({ since: "0", limit: 10 });
    expect(changes).toMatchObject({ items: [{ id: item.id, version: "r7" }], removed: [], more: false });

    // A delete takes the row, its revisions, the object and every copy kept beside it.
    await adapter.delete(item.id, { changeId: "c-d" });
    expect([...media.objects.keys()]).toEqual([]);
    expect(db.db.prepare("SELECT count(*) AS n FROM media_revisions").get()).toEqual({ n: 0 });
    expect((await adapter.changes!({ since: changes.cursor, limit: 10 })).removed).toEqual([item.id]);
  });

  it("finds a re-upload, counts uses, refuses a delete in use and keeps copies in a backups bucket", async () => {
    const uses = new Map<string, MediaUse[]>();
    const backups = bucket();
    const { adapter, media, db } = library({ usage: async () => uses, history: { bucket: backups, prefix: "media/revisions/" } });
    const first = await upload(adapter, png(1600, 1200));
    expect(first).toMatchObject({ width: 1000, resizedFrom: { width: 1600, height: 1200 }, usedCount: 0 });
    // The camera file sent again is found by the bytes it was uploaded with, before the shrink changed them.
    const original = db.db.prepare("SELECT sha256 FROM media_revisions WHERE reason = 'upload'").get() as { sha256: string };
    expect((await adapter.findByHash!(original.sha256))!.id).toBe(first.id);
    expect([...backups.objects.keys()]).toEqual([expect.stringMatching(new RegExp(`^media/revisions/${first.id}/[0-9a-f]{64}$`))]);

    const list = await adapter.list({ lens: "unattached", limit: 50 });
    expect(list.items.map((i) => i.id)).toEqual([first.id]);

    uses.set(first.id, [{ type: "post", id: "a", title: "A walk", detail: "body" }]);
    expect((await adapter.get(first.id))!).toMatchObject({ usedCount: 1, usedBy: [{ id: "a" }] });
    await expect(adapter.delete(first.id, { changeId: "c-1" })).rejects.toMatchObject({ name: "MediaInUseError" });

    // The site's own tables refuse in the same statement, even when its check missed the use.
    uses.clear();
    db.db.prepare("INSERT INTO posts (id, body) VALUES ('b', ?)").run(`![x](/media/${first.id})`);
    await expect(adapter.delete(first.id, { changeId: "c-2" })).rejects.toMatchObject({ name: "RefusedError" });
    expect(media.objects.has(first.id)).toBe(true);

    db.db.exec("DELETE FROM posts");
    await adapter.delete(first.id, { changeId: "c-3" });
    expect(media.objects.has(first.id)).toBe(false);
    // The original the shrink replaced, and the last bytes.
    expect(backups.objects.size).toBe(2);
  });

  it("stores a quarter turn as a new file on a site whose pages hold the size, and refuses a replace of another size", async () => {
    const { adapter } = library({ replaceKeepsSize: true });
    const item = await upload(adapter, png(800, 600));
    await expect(adapter.replace!(item.id, { bytes: png(600, 800), contentType: "image/png", filename: "x.png", expectedVersion: "r0", changeId: "c-1" })).rejects.toMatchObject({
      name: "RefusedError",
    });
    const turned = await adapter.transform!(item.id, { op: "rotate-90", asNewFile: true, expectedVersion: "r0", changeId: "c-2" });
    expect(turned.item).toMatchObject({ width: 600, height: 800, alt: "A heron on the river bank", version: "r0" });
    expect(turned.item.id).not.toBe(item.id);
    expect((await adapter.get(item.id))!).toMatchObject({ width: 800, version: "r0" });
  });
});
