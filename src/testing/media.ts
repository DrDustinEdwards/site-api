import { extraMedia } from "./media-extras.js";
import {
  MediaInUseError,
  NotFoundError,
  RefusedError,
  VersionConflictError,
  type MediaAdapter,
  type MediaReplace,
} from "../adapter.js";
import { LARGE_MEDIA_BYTES, MEDIA_LENSES } from "../contract.js";
import type {
  MediaEmbeddedField,
  MediaLens,
  MediaItem,
  MediaResize,
  MediaRevision,
  MediaUse,
} from "../contract.js";
import { kindOf, orientationOf } from "../media.js";

import {
  EXTENSIONS,
  MEMORY_MEDIA_LIMITS,
  measure,
  pngText,
  type MemoryAdapterOptions,
  type Stored,
  type StoredMedia,
} from "./shared.js";

/** The in-memory media group: its files, their revisions and change log, and the adapter over them. */
/** The state and helpers the media group's optional methods share with the core ones. */
export interface MediaExtrasContext {
  now: () => Date;
  mediaStore: Map<string, StoredMedia>;
  changeLog: Array<{ seq: number; id: string }>;
  lastSeq: () => number;
  logChange: (id: string) => void;
  dedupe: boolean;
  resize: MediaResize | undefined;
  heldMedia: (id: string, expectedVersion: string) => StoredMedia;
  touchMedia: (stored: StoredMedia, changes: Partial<MediaItem>) => { version: string };
  nextMediaVersion: () => string;
  keepBytes: (
    stored: StoredMedia,
    data: Uint8Array,
    size: { width: number | null; height: number | null },
    reason: MediaRevision["reason"],
  ) => void;
  shrunk: (width: number | null, height: number | null) => { width: number; height: number } | null;
  shown: (item: MediaItem) => MediaItem;
}

export function memoryMedia(
  options: MemoryAdapterOptions,
  store: Map<string, Stored>,
  now: () => Date,
) {
  const mediaStore = new Map<string, StoredMedia>();
  const deleted: string[] = [];
  let mediaCounter = 0;
  let mediaVersion = 0;
  const nextMediaVersion = () => `m${++mediaVersion}`;
  const mediaWrites = options.mediaWrites !== false;

  /** The stored file, or NotFoundError; a stale expectedVersion is VersionConflictError. */
  function heldMedia(id: string, expectedVersion: string): StoredMedia {
    const stored = mediaStore.get(id);
    if (!stored) throw new NotFoundError("No such media.");
    if (stored.item.version !== expectedVersion)
      throw new VersionConflictError(
        stored.item.version ?? null,
        "The file changed since it was loaded.",
      );
    return stored;
  }

  /** Every metadata write moves the version, so alt, tags and trash each count as a change. */
  function touchMedia(stored: StoredMedia, changes: Partial<MediaItem>): { version: string } {
    const version = nextMediaVersion();
    stored.item = { ...stored.item, ...changes, version };
    logChange(stored.item.id);
    return { version };
  }

  // ---------- v0.13.0
  const extras = mediaWrites && options.mediaExtras !== false;
  const dedupe = extras && options.mediaDuplicates === true;
  const resize =
    extras && options.mediaResize !== false
      ? (options.mediaResize ?? { maxEdge: 2048, quality: 82 })
      : undefined;
  /** Every change in order, as a site's own change log would hold it: what `changes` answers from. */
  const changeLog: Array<{ seq: number; id: string }> = [];
  let changeSeq = 0;
  let revCounter = 0;
  function logChange(id: string) {
    changeLog.push({ seq: ++changeSeq, id });
  }

  /** Keeps a new set of bytes as the file's current revision; the earlier ones stay. */
  function keepBytes(
    stored: StoredMedia,
    data: Uint8Array,
    size: { width: number | null; height: number | null },
    reason: MediaRevision["reason"],
  ) {
    if (!extras) return;
    stored.revisions ??= [];
    stored.revisions.push({
      rev: `r${++revCounter}`,
      at: now().toISOString(),
      bytes: data.byteLength,
      width: size.width,
      height: size.height,
      reason,
      data,
    });
  }

  /** A size scaled so its longer edge is the site's maxEdge, or null when it already fits. */
  function shrunk(
    width: number | null,
    height: number | null,
  ): { width: number; height: number } | null {
    if (!resize || !width || !height || Math.max(width, height) <= resize.maxEdge) return null;
    const scale = resize.maxEdge / Math.max(width, height);
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
    };
  }

  /** An item as the site answers it: with its usage count, which moves whenever a post does. */
  function shown(item: MediaItem): MediaItem {
    return extras ? { ...item, usedCount: usesOf(item.id).length } : item;
  }

  /** The lenses, as the site would answer them: nothing uses it, it has no alt text, it is over the size line. */
  const LENS: Record<MediaLens, (i: MediaItem) => boolean> = {
    unattached: (i) => usesOf(i.id).length === 0,
    "no-alt": (i) => i.alt.trim() === "" && !i.decorative,
    large: (i) => i.bytes > LARGE_MEDIA_BYTES,
    duplicates: (i) => twinsOf(i.id).length > 0,
    "license-expired": (i) =>
      Boolean(i.licenseExpires && i.licenseExpires < now().toISOString().slice(0, 10)),
    oversized: (i) => shrunk(i.width, i.height) !== null,
  };

  /** The other files holding exactly this file's bytes. */
  function twinsOf(id: string): Array<{ id: string; filename: string | null }> {
    const hash = mediaStore.get(id)?.sha256;
    if (!hash) return [];
    return [...mediaStore.values()]
      .filter((m) => m.sha256 === hash && m.item.id !== id)
      .map((m) => ({ id: m.item.id, filename: m.item.filename }));
  }

  /** The site's reference check: every post whose source carries the file's URL, as the real site scans. */
  function usesOf(id: string): MediaUse[] {
    const url = `/media/${id}`;
    const uses: MediaUse[] = [];
    for (const { doc } of store.values()) {
      const lines = doc.source.split("\n");
      lines.forEach((line, i) => {
        if (line.includes(url))
          uses.push({ type: "post", id: doc.id, title: doc.title, detail: `line ${i + 1}` });
      });
    }
    return uses;
  }

  const ctx: MediaExtrasContext = {
    now,
    mediaStore,
    changeLog,
    lastSeq: () => changeSeq,
    logChange,
    dedupe,
    resize,
    heldMedia,
    touchMedia,
    nextMediaVersion,
    keepBytes,
    shrunk,
    shown,
  };
  const mediaAdapter: MediaAdapter | undefined =
    options.media === false
      ? undefined
      : {
          limits: options.media ?? MEMORY_MEDIA_LIMITS,
          ...(options.mediaLenses === false
            ? {}
            : {
                lenses: MEDIA_LENSES.filter(
                  (l) =>
                    (extras || ["unattached", "no-alt", "large"].includes(l)) &&
                    (l !== "oversized" || resize) &&
                    (l !== "duplicates" || dedupe),
                ),
              }),
          ...(options.mediaReplaceKeepsSize ? { replaceKeepsSize: true } : {}),
          ...(extras ? { usage: true, filters: true, readsEmbedded: true } : {}),
          ...(resize ? { resize } : {}),
          ...(extras && options.mediaImportFetch ? { importFetch: options.mediaImportFetch } : {}),
          async list(query) {
            const needle = query.q?.toLowerCase();
            const lensed = options.mediaLenses !== false;
            const all = [...mediaStore.values()]
              .map((m) => m.item)
              .filter((i) => (query.trashed === "only" ? Boolean(i.trashedAt) : !i.trashedAt))
              .filter((i) => !query.tag || (i.tags ?? []).includes(query.tag))
              .filter(
                (i) =>
                  !needle ||
                  [i.id, i.filename ?? "", i.alt].some((t) => t.toLowerCase().includes(needle)),
              )
              .filter((i) => !lensed || !query.lens || LENS[query.lens](i))
              .filter(
                (i) => !query.orientation || orientationOf(i.width, i.height) === query.orientation,
              )
              .filter((i) => !query.kind || kindOf(i.contentType) === query.kind)
              .map(shown)
              .reverse();
            // v0.6.0: sorted as asked, newest, largest or A to Z first unless dir says otherwise.
            const sorted =
              lensed && query.sort
                ? { sort: query.sort, dir: query.dir ?? (query.sort === "name" ? "asc" : "desc") }
                : undefined;
            if (sorted) {
              const key = (i: MediaItem): string | number =>
                sorted.sort === "size"
                  ? i.bytes
                  : sorted.sort === "used"
                    ? (i.usedCount ?? 0)
                    : sorted.sort === "name"
                      ? (i.filename ?? i.id).toLowerCase()
                      : (i.uploadedAt ?? "");
              const order = [...all];
              all.sort((a, b) => {
                const [x, y] = [key(a), key(b)];
                const by = typeof x === "number" ? x - (y as number) : x.localeCompare(y as string);
                return (sorted.dir === "asc" ? 1 : -1) * by || order.indexOf(a) - order.indexOf(b);
              });
            }
            const start = query.cursor ? Number(query.cursor) : 0;
            const page = all.slice(start, start + query.limit);
            return {
              items: page,
              nextCursor: start + query.limit < all.length ? String(start + query.limit) : null,
              ...(lensed ? { total: all.length } : {}),
              ...(sorted ? { sorted } : {}),
              ...(extras ? { changeCursor: String(changeSeq) } : {}),
            };
          },
          async get(id) {
            const stored = mediaStore.get(id);
            return stored
              ? {
                  ...shown(stored.item),
                  usedBy: usesOf(id),
                  ...(dedupe ? { twins: twinsOf(id) } : {}),
                }
              : null;
          },
          async upload(input) {
            const base =
              input.filename
                .replace(/\.[^.]*$/, "")
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "") || "file";
            const id = `uploads/${++mediaCounter}-${base}.${EXTENSIONS[input.contentType] ?? "bin"}`;
            const size = (extras ? measure(input.bytes) : null) ?? { width: null, height: null };
            // v0.13.0: shrunk to the site's longest edge unless the upload said no. The reference adapter does not re-encode,
            // so only the measured size moves.
            const small = input.resize ? shrunk(size.width, size.height) : null;
            // The embedded metadata fills only what the upload left empty.
            const text = extras ? pngText(input.bytes) : {};
            const taken =
              text["Creation Time"] && !Number.isNaN(Date.parse(text["Creation Time"]))
                ? new Date(text["Creation Time"]).toISOString()
                : null;
            const embedded: MediaEmbeddedField[] = [
              ...(text.Author ? (["credit"] as const) : []),
              ...(text.Copyright ? (["license"] as const) : []),
              ...(text.Description ? (["caption"] as const) : []),
              ...(taken ? (["takenAt"] as const) : []),
            ];
            const item: MediaItem = {
              id,
              url: `/media/${id}`,
              filename: input.filename,
              contentType: input.contentType,
              bytes: input.bytes.byteLength,
              width: small?.width ?? size.width,
              height: small?.height ?? size.height,
              alt: input.alt,
              ...(input.decorative ? { decorative: true } : {}),
              uploadedAt: now().toISOString(),
              deletable: true,
              ...(mediaWrites
                ? {
                    version: nextMediaVersion(),
                    tags: [],
                    trashedAt: null,
                    focus: null,
                    caption: text.Description?.slice(0, 2000) ?? "",
                  }
                : {}),
              ...(extras
                ? {
                    credit: text.Author?.slice(0, 300) ?? "",
                    license: text.Copyright?.slice(0, 300) ?? "",
                    sourceUrl: input.sourceUrl ?? null,
                    licenseExpires: null,
                    takenAt: taken,
                    placeholder: null,
                    color: null,
                    downloadUrl: `/media/${id}`,
                  }
                : {}),
            };
            const stored: StoredMedia = {
              item,
              bytes: input.bytes,
              ...(input.sha256 ? { sha256: input.sha256 } : {}),
            };
            keepBytes(stored, input.bytes, item, input.sourceUrl ? "import" : "upload");
            mediaStore.set(id, stored);
            logChange(id);
            return {
              ...item,
              ...(embedded.length > 0 ? { embedded } : {}),
              ...(small && size.width && size.height
                ? {
                    resizedFrom: {
                      width: size.width,
                      height: size.height,
                      bytes: input.bytes.byteLength,
                    },
                  }
                : {}),
            };
          },
          async delete(id) {
            if (!mediaStore.has(id)) throw new NotFoundError("No such media.");
            const uses = usesOf(id);
            if (uses.length > 0) throw new MediaInUseError(uses);
            mediaStore.delete(id);
            deleted.push(id);
            logChange(id);
          },
          ...(mediaWrites
            ? {
                async setAlt(
                  id: string,
                  input: {
                    alt: string;
                    decorative?: boolean;
                    expectedVersion: string;
                    changeId: string;
                  },
                ) {
                  return touchMedia(heldMedia(id, input.expectedVersion), {
                    alt: input.alt,
                    decorative: input.decorative === true,
                  });
                },
                async setTags(
                  id: string,
                  input: {
                    tags: string[];
                    expectedVersion: string;
                    changeId: string;
                    actor?: { name: string };
                  },
                ) {
                  return touchMedia(heldMedia(id, input.expectedVersion), { tags: input.tags });
                },
                async trash(id: string, input: { expectedVersion: string; changeId: string }) {
                  return touchMedia(heldMedia(id, input.expectedVersion), {
                    trashedAt: now().toISOString(),
                  });
                },
                async restore(id: string, input: { expectedVersion: string; changeId: string }) {
                  return touchMedia(heldMedia(id, input.expectedVersion), { trashedAt: null });
                },
                async setFocus(
                  id: string,
                  input: { focus: string | null; expectedVersion: string; changeId: string },
                ) {
                  return touchMedia(heldMedia(id, input.expectedVersion), { focus: input.focus });
                },
                async setCaption(
                  id: string,
                  input: { caption: string; expectedVersion: string; changeId: string },
                ) {
                  return touchMedia(heldMedia(id, input.expectedVersion), {
                    caption: input.caption,
                  });
                },
                // Same id and address, alt, caption and tags kept, the focal point cleared. Nothing is cached in memory,
                // so no size can be stale.
                async replace(id: string, input: MediaReplace) {
                  const stored = heldMedia(id, input.expectedVersion);
                  const size = (extras ? measure(input.bytes) : null) ?? {
                    width: null,
                    height: null,
                  };
                  if (
                    options.mediaReplaceKeepsSize &&
                    (size.width !== stored.item.width || size.height !== stored.item.height)
                  ) {
                    throw new RefusedError(
                      "The new picture is another size; this site's addresses carry the size.",
                    );
                  }
                  stored.bytes = input.bytes;
                  keepBytes(stored, input.bytes, size, "replace");
                  touchMedia(stored, {
                    filename: input.filename,
                    bytes: input.bytes.byteLength,
                    ...size,
                    focus: null,
                    uploadedAt: now().toISOString(),
                  });
                  return { item: shown(stored.item), sizesNeedPurge: false };
                },
              }
            : {}),
          ...(extras ? extraMedia(ctx) : {}),
        };

  return { mediaStore, deleted, mediaAdapter };
}
