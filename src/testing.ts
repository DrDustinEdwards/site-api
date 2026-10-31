// A reference adapter held in memory: what a conforming site does, small enough to read in one
// sitting. Carrel's tests run against it, and the conformance suite is proven on it.

import { MediaInUseError, NotFoundError, RefusedError, VersionConflictError, type DueSchedule, type MediaAdapter, type MediaReplace, type MentionsAdapter, type SchedulesAdapter, type SiteAdapter } from "./adapter.js";
import { joinSource, POST_FIELDS, postFieldsOf, setTags as writeTags, splitSource, tagsOf } from "./frontmatter.js";
import { LARGE_MEDIA_BYTES, MEDIA_LENSES } from "./contract.js";
import type { ContentDoc, ContentStatus, ContentSummary, MediaEmbeddedField, MediaLens, MediaItem, MediaResize, MediaRevision, MediaTransformOp, MediaUploadLimits, MediaUse, MentionItem, MentionStatus, NotFoundRow, Revision, ScheduledUpdate, SiteInfo, WriteResult } from "./contract.js";
import { kindOf, orientationOf, transformFocus, turnsSize } from "./media.js";

interface Stored {
  doc: ContentDoc;
  history: Array<{ revision: Revision; source: string }>;
  /** The update waiting on a live item (v0.10.0), kept beside it as a site's own table would. */
  pending?: ScheduledUpdate;
  /** The change that scheduled a scheduled item, which its publish is recorded under. */
  scheduleChangeId?: string;
}

export interface MemoryAdapterOptions {
  site?: SiteInfo;
  now?: () => Date;
  /** The media group's limits, or false for a site with no media manager (a v0.1.0 site). */
  media?: MediaUploadLimits | false;
  /** false for a site whose adapter has no content delete (its route then answers 501). On by default. */
  contentDelete?: boolean;
  /** false for a site that keeps no post tags through the API (a v0.5.0 site): the tags route then answers 501. On by default. */
  contentTags?: boolean;
  /** false for a v0.14.0 content group (v0.17.0): no settable publish date, rename, trash, list filters or post fields. On by default. */
  contentExtras?: boolean;
  /** false for a media manager with no alt, tag, trash, focal point, caption or replace writes (a v0.2.0 site): those routes then answer 501. On by default. */
  mediaWrites?: boolean;
  /** false for a media manager with no lenses and no sort (a v0.5.0 site): a lens then answers 501. On by default. */
  mediaLenses?: boolean;
  /** true for a site whose replace refuses a picture of another size, as some sites do (v0.11.0). Off by default. */
  mediaReplaceKeepsSize?: boolean;
  /**
   * false for a v0.12.0 media manager (v0.13.0): no duplicates, usage counts, filters, credit, transforms, history, changes,
   * embedded metadata, suggestions or new lenses. On by default, with `mediaWrites`.
   */
  mediaExtras?: boolean;
  /**
   * true for a site that answers an upload of bytes it holds with that file (v0.13.0), and the duplicates lens. Off by
   * default, since tests upload the same few bytes again and again.
   */
  mediaDuplicates?: boolean;
  /** What uploads shrink to (v0.13.0), or false for none. { maxEdge: 2048, quality: 82 } by default, with `mediaExtras`. */
  mediaResize?: MediaResize | false;
  /** The fetch imports use (v0.13.0). Absent: the site does not import, so no test ever reaches the network. */
  mediaImportFetch?: typeof fetch;
  /** false for a mentions group that ignores q and targetId (a v0.5.0 site) and so echoes no `filtered`. On by default. */
  mentionFilters?: boolean;
  /** false for a site that does not receive webmentions (its routes then answer 501). On by default. */
  mentions?: boolean;
  /** false for a mentions group with no reset (a v0.5.0 site): a reset then answers 501. On by default. */
  mentionReset?: boolean;
  /** false for a site with no scheduled updates (a v0.9.0 site): reading and canceling a schedule answer 501. On by default. */
  schedules?: boolean;
  /** The site's counted 404s (v0.16.0), as report rows most hits first. Absent: the site reports none, and the route answers 501. */
  notFound?: NotFoundRow[];
}

/** What the reference adapter's sweep keeps, like dustinedwards.info: failed rows 30 days, rejected rows 90. */
const MEMORY_MENTION_RETENTION_DAYS = { failed: 30, rejected: 90 } as const;

/** What the endpoint writes when a stranger sends a mention, for tests to seed the queue with. */
export interface ReceivedMention {
  sourceUrl: string;
  targetId: string;
  status?: MentionStatus;
  authorName?: string | null;
  authorUrl?: string | null;
  excerpt?: string | null;
  failureReason?: string | null;
  receivedAt?: Date;
}

/** What the reference adapter accepts, like dustinedwards.info's own list, at a test-sized limit. */
export const MEMORY_MEDIA_LIMITS: MediaUploadLimits = {
  maxBytes: 5 * 1024 * 1024,
  types: ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml"],
};

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
};

interface StoredMedia {
  item: MediaItem;
  bytes: Uint8Array;
  /** v0.13.0: the content hash the package sent, for duplicates. */
  sha256?: string;
  /** v0.13.0: every set of bytes the file has had, oldest first; the last is current. */
  revisions?: Array<Omit<MediaRevision, "current"> & { data: Uint8Array }>;
}

/** A PNG's width and height from its IHDR chunk, as a site measures an upload; null for anything else. */
function measure(bytes: Uint8Array): { width: number; height: number } | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => bytes[i] === v);
  if (!png || bytes.length < 24 || String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const [width, height] = [view.getUint32(16), view.getUint32(20)];
  return width > 0 && height > 0 ? { width, height } : null;
}

/** A PNG's tEXt chunks, the embedded metadata the reference adapter reads (a real site reads IPTC and EXIF as well). */
function pngText(bytes: Uint8Array): Record<string, string> {
  const found: Record<string, string> = {};
  if (!measure(bytes)) return found;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 8; at + 8 <= bytes.length; ) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, Math.min(at + 8 + length, bytes.length));
    if (type === "tEXt") {
      const nul = data.indexOf(0);
      if (nul > 0) found[String.fromCharCode(...data.subarray(0, nul))] = String.fromCharCode(...data.subarray(nul + 1));
    }
    at += 12 + length;
  }
  return found;
}

/** The item with its tags (v0.6.0), where its frontmatter can hold them, and its authors and excerpt where it has them (v0.17.0). */
function withTags(doc: ContentDoc): ContentDoc {
  const front = splitSource(doc.source).front;
  if (front === null) return doc;
  const { authors, excerpt } = postFieldsOf(front);
  return { ...doc, tags: tagsOf(front), ...(authors.length ? { authors } : {}), ...(excerpt ? { excerpt } : {}) };
}

/** A list row: the item without its source, with its version and tags. */
function summaryOf(doc: ContentDoc): ContentSummary {
  const { source: _s, format: _f, ...summary } = withTags(doc);
  return summary;
}

function titleOf(source: string, id: string): string {
  const front = source.match(/^---\r?\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m);
  if (front) return front[1]!;
  const heading = source.match(/^#\s+(.+)$/m);
  return heading ? heading[1]!.trim() : id;
}

export function memoryAdapter(
  options: MemoryAdapterOptions = {},
): SiteAdapter & {
  store: Map<string, Stored>;
  mediaStore: Map<string, StoredMedia>;
  deleted: string[];
  deletedContent: string[];
  mentionStore: Map<string, MentionItem>;
  /** Targets whose cached page the adapter purged, one entry per write that purges. */
  purged: string[];
  /** Adds a mention as the site's endpoint would, and returns its id. */
  receiveMention(fields: ReceivedMention): string;
  /** The permanent redirects a rename left (v0.17.0), old path to new. */
  redirects: Map<string, string>;
} {
  const site = options.site ?? { id: "memory", name: "Memory site", origin: "https://memory.example" };
  const now = options.now ?? (() => new Date());
  const store = new Map<string, Stored>();
  const schedules = options.schedules !== false;
  const contentExtras = options.contentExtras !== false;
  const redirects = new Map<string, string>();
  let counter = 0;

  function expect(id: string, expectedVersion: string | null): Stored | undefined {
    const current = store.get(id);
    const held = current?.doc.version ?? null;
    if (held !== expectedVersion) throw new VersionConflictError(held);
    return current;
  }

  function commit(
    id: string,
    previous: Stored | undefined,
    changes: { source?: string; status: ContentStatus; publishAt?: string | null; pending?: ScheduledUpdate | null; publishedAt?: string; redate?: string; trashedAt?: string | null },
    changeId: string,
    message: string,
  ): WriteResult {
    const at = now().toISOString();
    const version = `v${++counter}`;
    const source = changes.source ?? previous?.doc.source ?? "";
    const wasPublished = previous?.doc.publishedAt ?? null;
    const doc: ContentDoc = {
      id,
      kind: "post",
      title: titleOf(source, id),
      status: changes.status,
      path: changes.status === "published" || wasPublished ? `/blog/${id}` : null,
      publishAt: changes.publishAt ?? null,
      publishedAt: changes.status === "published" ? (changes.redate ?? wasPublished ?? changes.publishedAt ?? at) : wasPublished,
      updatedAt: at,
      format: "markdown",
      source,
      version,
      ...(contentExtras ? { trashedAt: changes.trashedAt !== undefined ? changes.trashedAt : (previous?.doc.trashedAt ?? null) } : {}),
    };
    // Only a live item carries an update, and a write that does not name one keeps what was waiting.
    const pending = changes.status !== "published" ? undefined : changes.pending === undefined ? previous?.pending : (changes.pending ?? undefined);
    if (schedules) doc.scheduledUpdate = pending ? { publishAt: pending.publishAt, changeId: pending.changeId } : null;
    const history = previous?.history ?? [];
    history.unshift({ revision: { version, at, author: "carrel", message: `${message} [${changeId}]` }, source });
    store.set(id, { doc, history, ...(pending ? { pending } : {}), ...(changes.status === "scheduled" ? { scheduleChangeId: changeId } : {}) });
    return { id, version, status: doc.status, changeId, ...(schedules ? { scheduledUpdate: doc.scheduledUpdate } : {}) };
  }

  function existing(id: string, expectedVersion: string): Stored {
    const current = expect(id, expectedVersion);
    if (!current) throw new NotFoundError();
    return current;
  }

  const mediaStore = new Map<string, StoredMedia>();
  const deleted: string[] = [];
  const deletedContent: string[] = [];
  let mediaCounter = 0;
  let mediaVersion = 0;
  const nextMediaVersion = () => `m${++mediaVersion}`;
  const mediaWrites = options.mediaWrites !== false;

  /** The stored file, or NotFoundError; a stale expectedVersion is VersionConflictError. */
  function heldMedia(id: string, expectedVersion: string): StoredMedia {
    const stored = mediaStore.get(id);
    if (!stored) throw new NotFoundError("No such media.");
    if (stored.item.version !== expectedVersion) throw new VersionConflictError(stored.item.version ?? null, "The file changed since it was loaded.");
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
  const resize = extras && options.mediaResize !== false ? (options.mediaResize ?? { maxEdge: 2048, quality: 82 }) : undefined;
  /** Every change in order, as a site's own change log would hold it: what `changes` answers from. */
  const changeLog: Array<{ seq: number; id: string }> = [];
  let changeSeq = 0;
  let revCounter = 0;
  function logChange(id: string) {
    changeLog.push({ seq: ++changeSeq, id });
  }

  /** Keeps a new set of bytes as the file's current revision; the earlier ones stay. */
  function keepBytes(stored: StoredMedia, data: Uint8Array, size: { width: number | null; height: number | null }, reason: MediaRevision["reason"]) {
    if (!extras) return;
    stored.revisions ??= [];
    stored.revisions.push({ rev: `r${++revCounter}`, at: now().toISOString(), bytes: data.byteLength, width: size.width, height: size.height, reason, data });
  }

  /** A size scaled so its longer edge is the site's maxEdge, or null when it already fits. */
  function shrunk(width: number | null, height: number | null): { width: number; height: number } | null {
    if (!resize || !width || !height || Math.max(width, height) <= resize.maxEdge) return null;
    const scale = resize.maxEdge / Math.max(width, height);
    return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
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
    "license-expired": (i) => Boolean(i.licenseExpires && i.licenseExpires < now().toISOString().slice(0, 10)),
    oversized: (i) => shrunk(i.width, i.height) !== null,
  };

  /** The other files holding exactly this file's bytes. */
  function twinsOf(id: string): Array<{ id: string; filename: string | null }> {
    const hash = mediaStore.get(id)?.sha256;
    if (!hash) return [];
    return [...mediaStore.values()].filter((m) => m.sha256 === hash && m.item.id !== id).map((m) => ({ id: m.item.id, filename: m.item.filename }));
  }

  /** The site's reference check: every post whose source carries the file's URL, as the real site scans. */
  function usesOf(id: string): MediaUse[] {
    const url = `/media/${id}`;
    const uses: MediaUse[] = [];
    for (const { doc } of store.values()) {
      const lines = doc.source.split("\n");
      lines.forEach((line, i) => {
        if (line.includes(url)) uses.push({ type: "post", id: doc.id, title: doc.title, detail: `line ${i + 1}` });
      });
    }
    return uses;
  }

  const mediaAdapter: MediaAdapter | undefined =
    options.media === false
      ? undefined
      : {
          limits: options.media ?? MEMORY_MEDIA_LIMITS,
          ...(options.mediaLenses === false ? {} : { lenses: MEDIA_LENSES.filter((l) => (extras || ["unattached", "no-alt", "large"].includes(l)) && (l !== "oversized" || resize) && (l !== "duplicates" || dedupe)) }),
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
              .filter((i) => !needle || [i.id, i.filename ?? "", i.alt].some((t) => t.toLowerCase().includes(needle)))
              .filter((i) => !lensed || !query.lens || LENS[query.lens](i))
              .filter((i) => !query.orientation || orientationOf(i.width, i.height) === query.orientation)
              .filter((i) => !query.kind || kindOf(i.contentType) === query.kind)
              .map(shown)
              .reverse();
            // v0.6.0: sorted as asked, newest, largest or A to Z first unless dir says otherwise.
            const sorted = lensed && query.sort ? { sort: query.sort, dir: query.dir ?? (query.sort === "name" ? "asc" : "desc") } : undefined;
            if (sorted) {
              const key = (i: MediaItem): string | number =>
                sorted.sort === "size" ? i.bytes : sorted.sort === "used" ? (i.usedCount ?? 0) : sorted.sort === "name" ? (i.filename ?? i.id).toLowerCase() : (i.uploadedAt ?? "");
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
            return stored ? { ...shown(stored.item), usedBy: usesOf(id), ...(dedupe ? { twins: twinsOf(id) } : {}) } : null;
          },
          async upload(input) {
            const base = input.filename.replace(/\.[^.]*$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "file";
            const id = `uploads/${++mediaCounter}-${base}.${EXTENSIONS[input.contentType] ?? "bin"}`;
            const size = (extras ? measure(input.bytes) : null) ?? { width: null, height: null };
            // v0.13.0: shrunk to the site's longest edge unless the upload said no. The reference adapter does not re-encode,
            // so only the measured size moves.
            const small = input.resize ? shrunk(size.width, size.height) : null;
            // The embedded metadata fills only what the upload left empty.
            const text = extras ? pngText(input.bytes) : {};
            const taken = text["Creation Time"] && !Number.isNaN(Date.parse(text["Creation Time"])) ? new Date(text["Creation Time"]).toISOString() : null;
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
              ...(mediaWrites ? { version: nextMediaVersion(), tags: [], trashedAt: null, focus: null, caption: text.Description?.slice(0, 2000) ?? "" } : {}),
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
            const stored: StoredMedia = { item, bytes: input.bytes, ...(input.sha256 ? { sha256: input.sha256 } : {}) };
            keepBytes(stored, input.bytes, item, input.sourceUrl ? "import" : "upload");
            mediaStore.set(id, stored);
            logChange(id);
            return {
              ...item,
              ...(embedded.length > 0 ? { embedded } : {}),
              ...(small && size.width && size.height ? { resizedFrom: { width: size.width, height: size.height, bytes: input.bytes.byteLength } } : {}),
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
                async setAlt(id: string, input: { alt: string; decorative?: boolean; expectedVersion: string; changeId: string }) {
                  return touchMedia(heldMedia(id, input.expectedVersion), { alt: input.alt, decorative: input.decorative === true });
                },
                async setTags(id: string, input: { tags: string[]; expectedVersion: string; changeId: string }) {
                  return touchMedia(heldMedia(id, input.expectedVersion), { tags: input.tags });
                },
                async trash(id: string, input: { expectedVersion: string; changeId: string }) {
                  return touchMedia(heldMedia(id, input.expectedVersion), { trashedAt: now().toISOString() });
                },
                async restore(id: string, input: { expectedVersion: string; changeId: string }) {
                  return touchMedia(heldMedia(id, input.expectedVersion), { trashedAt: null });
                },
                async setFocus(id: string, input: { focus: string | null; expectedVersion: string; changeId: string }) {
                  return touchMedia(heldMedia(id, input.expectedVersion), { focus: input.focus });
                },
                async setCaption(id: string, input: { caption: string; expectedVersion: string; changeId: string }) {
                  return touchMedia(heldMedia(id, input.expectedVersion), { caption: input.caption });
                },
                // Same id and address, alt, caption and tags kept, the focal point cleared. Nothing is cached in memory,
                // so no size can be stale.
                async replace(id: string, input: MediaReplace) {
                  const stored = heldMedia(id, input.expectedVersion);
                  const size = (extras ? measure(input.bytes) : null) ?? { width: null, height: null };
                  if (options.mediaReplaceKeepsSize && (size.width !== stored.item.width || size.height !== stored.item.height)) {
                    throw new RefusedError("The new picture is another size; this site's addresses carry the size.");
                  }
                  stored.bytes = input.bytes;
                  keepBytes(stored, input.bytes, size, "replace");
                  touchMedia(stored, { filename: input.filename, bytes: input.bytes.byteLength, ...size, focus: null, uploadedAt: now().toISOString() });
                  return { item: shown(stored.item), sizesNeedPurge: false };
                },
              }
            : {}),
          ...(extras ? extraMedia() : {}),
        };

  /** The v0.13.0 methods, as a site that offers every one of them would write them. */
  function extraMedia(): Partial<MediaAdapter> {
    return {
      ...(dedupe
        ? {
            async findByHash(sha256: string) {
              const found = [...mediaStore.values()].find((m) => m.sha256 === sha256);
              return found ? shown(found.item) : null;
            },
          }
        : {}),
      async setCredit(id, input) {
        const { credit, license, sourceUrl, licenseExpires, copyright, licenseUrl, acquireLicenseUrl } = input;
        const named = Object.entries({ copyright, licenseUrl, acquireLicenseUrl }).filter(([, v]) => v !== undefined);
        return touchMedia(heldMedia(id, input.expectedVersion), { credit, license, sourceUrl, licenseExpires, ...Object.fromEntries(named) });
      },
      // The reference adapter does not decode pictures, so a turn moves the size and the focal point and keeps the bytes.
      async transform(id, input: { op: MediaTransformOp; asNewFile: boolean; expectedVersion: string; changeId: string }) {
        const stored = heldMedia(id, input.expectedVersion);
        const { width, height } = stored.item;
        const size = turnsSize(input.op) ? { width: height, height: width } : { width, height };
        const focus = transformFocus(stored.item.focus ?? null, input.op);
        if (input.asNewFile) {
          const newId = id.replace(/(\.[a-z0-9]+)?$/, (ext) => `-${input.op}${ext}`);
          const copy: StoredMedia = { item: { ...stored.item, ...size, focus, id: newId, url: `/media/${newId}`, downloadUrl: `/media/${newId}`, version: nextMediaVersion(), uploadedAt: now().toISOString() }, bytes: stored.bytes };
          keepBytes(copy, stored.bytes, size, "transform");
          mediaStore.set(newId, copy);
          logChange(newId);
          return { item: shown(copy.item), sizesNeedPurge: false };
        }
        keepBytes(stored, stored.bytes, size, "transform");
        touchMedia(stored, { ...size, focus });
        return { item: shown(stored.item), sizesNeedPurge: false };
      },
      async history(id) {
        const revisions = mediaStore.get(id)?.revisions;
        if (!revisions) return null;
        return revisions.map(({ data: _d, ...r }, n) => ({ ...r, current: n === revisions.length - 1 })).reverse();
      },
      async revert(id, input) {
        const stored = heldMedia(id, input.expectedVersion);
        const target = stored.revisions?.find((r) => r.rev === input.to);
        if (!target) throw new NotFoundError("This file has no such earlier version.");
        stored.bytes = target.data;
        keepBytes(stored, target.data, target, "revert");
        touchMedia(stored, { bytes: target.bytes, width: target.width, height: target.height, focus: null });
        return { item: shown(stored.item), sizesNeedPurge: false };
      },
      async changes({ since, limit }) {
        const from = Number(since);
        if (!Number.isInteger(from) || from < 0 || from > changeSeq) throw new RefusedError("That change cursor is not this site's; reload the library.");
        // Each file once, at its latest change, oldest first.
        const latest = new Map<string, number>();
        for (const entry of changeLog) if (entry.seq > from) latest.set(entry.id, entry.seq);
        const order = [...latest].sort((a, b) => a[1] - b[1]);
        const taken = order.slice(0, limit);
        const more = order.length > limit;
        return {
          items: taken.filter(([id]) => mediaStore.has(id)).map(([id]) => shown(mediaStore.get(id)!.item)),
          removed: taken.filter(([id]) => !mediaStore.has(id)).map(([id]) => id),
          cursor: String(more ? taken[taken.length - 1]![1] : changeSeq),
          more,
        };
      },
      ...(resize && !options.mediaReplaceKeepsSize
        ? {
            async shrink(id: string, input: { expectedVersion: string; changeId: string }) {
              const stored = heldMedia(id, input.expectedVersion);
              const small = shrunk(stored.item.width, stored.item.height);
              if (!small) return { resized: false, item: shown(stored.item) };
              keepBytes(stored, stored.bytes, small, "resize");
              touchMedia(stored, small);
              return { resized: true, item: shown(stored.item) };
            },
          }
        : {}),
      // What a model might say, made from the file name, so tests see suggestions without one.
      async suggest(id) {
        const item = mediaStore.get(id)?.item;
        if (!item) return null;
        const words = (item.filename ?? id).replace(/\.[^.]*$/, "").split(/[^A-Za-z]+/).filter((w) => w.length >= 3);
        return { tags: words.map((w) => w.toLowerCase()), alt: words.length > 0 ? `A picture of ${words.join(" ").toLowerCase()}.` : null, model: "memory-suggester" };
      },
      // Before an upload there is no name to go on: the model's answer is the file's size.
      async suggestFile({ bytes }) {
        return { tags: ["upload"], alt: `A picture of ${bytes.byteLength} bytes.`, model: "memory-suggester" };
      },
    };
  }

  // ---------- mentions: what dustinedwards.info does, in memory

  const mentionStore = new Map<string, MentionItem>();
  const purged: string[] = [];
  let mentionCounter = 0;
  let mentionVersion = 0;
  const DAY = 24 * 60 * 60 * 1000;
  /** Same rule as the site: only a verified mention (pending, approved, rejected) takes a decision. */
  const DECIDABLE: MentionStatus[] = ["pending", "approved", "rejected"];

  function receiveMention(fields: ReceivedMention): string {
    const id = String(++mentionCounter);
    const status = fields.status ?? "pending";
    const receivedAt = (fields.receivedAt ?? now()).toISOString();
    mentionStore.set(id, {
      id,
      status,
      sourceUrl: fields.sourceUrl,
      targetId: fields.targetId,
      authorName: fields.authorName ?? null,
      authorUrl: fields.authorUrl ?? null,
      excerpt: fields.excerpt ?? null,
      failureReason: fields.failureReason ?? (status === "failed" ? "no-link" : null),
      receivedAt,
      verifiedAt: status === "unverified" ? null : receivedAt,
      decidedAt: null,
      version: `m${++mentionVersion}`,
    });
    return id;
  }

  function heldMention(id: string, expectedVersion: string): MentionItem {
    const current = mentionStore.get(id);
    if (!current) throw new NotFoundError("No such mention.");
    if (current.version !== expectedVersion) throw new VersionConflictError(current.version);
    return current;
  }

  function expiring(): { failed: MentionItem[]; rejected: MentionItem[] } {
    const at = now().getTime();
    const past = (status: "failed" | "rejected") =>
      [...mentionStore.values()].filter(
        (m) => m.status === status && Date.parse(m.receivedAt) < at - MEMORY_MENTION_RETENTION_DAYS[status] * DAY,
      );
    return { failed: past("failed"), rejected: past("rejected") };
  }

  const mentionsAdapter: MentionsAdapter | undefined =
    options.mentions === false
      ? undefined
      : {
          async list(query) {
            const filters = options.mentionFilters !== false;
            const needle = filters ? query.q?.toLowerCase() : undefined;
            const all = [...mentionStore.values()]
              .filter((m) => !query.status || m.status === query.status)
              .filter((m) => !needle || [m.sourceUrl, m.authorName ?? "", m.excerpt ?? ""].some((t) => t.toLowerCase().includes(needle)))
              .filter((m) => !filters || !query.targetId || m.targetId === query.targetId)
              .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt) || Number(b.id) - Number(a.id));
            const start = query.cursor ? Number(query.cursor) : 0;
            const counts = { unverified: 0, pending: 0, approved: 0, rejected: 0, failed: 0 };
            for (const m of mentionStore.values()) counts[m.status]++;
            const soon = expiring();
            return {
              items: all.slice(start, start + query.limit),
              nextCursor: start + query.limit < all.length ? String(start + query.limit) : null,
              counts,
              expiring: { failed: soon.failed.length, rejected: soon.rejected.length },
              ...(filters && (query.q || query.targetId) ? { filtered: { ...(query.q ? { q: query.q } : {}), ...(query.targetId ? { targetId: query.targetId } : {}) } } : {}),
            };
          },
          async decide(id, input) {
            const current = heldMention(id, input.expectedVersion);
            if (!DECIDABLE.includes(current.status)) {
              throw new RefusedError(`A ${current.status} mention cannot be decided: only a verified mention can.`);
            }
            const next: MentionItem = {
              ...current,
              status: input.decision === "approve" ? "approved" : "rejected",
              decidedAt: now().toISOString(),
              version: `m${++mentionVersion}`,
            };
            mentionStore.set(id, next);
            purged.push(current.targetId);
            return { status: next.status, version: next.version, purged: true };
          },
          async reset(id, input) {
            const current = heldMention(id, input.expectedVersion);
            if (current.status !== "approved" && current.status !== "rejected") {
              throw new RefusedError(`A ${current.status} mention has no decision to take back.`);
            }
            const next: MentionItem = { ...current, status: "pending", decidedAt: null, version: `m${++mentionVersion}` };
            mentionStore.set(id, next);
            purged.push(current.targetId);
            return { status: next.status, version: next.version, purged: true };
          },
          async delete(id, input) {
            const current = heldMention(id, input.expectedVersion);
            mentionStore.delete(id);
            purged.push(current.targetId);
            return { purged: true };
          },
          async sweep() {
            const gone = expiring();
            for (const m of [...gone.failed, ...gone.rejected]) mentionStore.delete(m.id);
            return { failed: gone.failed.length, rejected: gone.rejected.length };
          },
        };

  // A v0.5.0 mentions group: no way back to pending.
  if (mentionsAdapter && options.mentionReset === false) delete mentionsAdapter.reset;

  const at = (time: string) => Date.parse(time);

  /** The reference schedules group (v0.10.0): the update sits beside the live item until `apply` puts it live. */
  const schedulesAdapter: SchedulesAdapter = {
    async get(id) {
      return store.get(id)?.pending ?? null;
    },
    async update(id, input) {
      const previous = existing(id, input.expectedVersion);
      if (previous.doc.status !== "published") throw new RefusedError("Only a live post takes a scheduled update.");
      const pending = { id, source: input.source, publishAt: input.publishAt, changeId: input.changeId, scheduledAt: now().toISOString() };
      return commit(id, previous, { status: "published", pending }, input.changeId, "Schedule update");
    },
    async cancel(id, input) {
      if (!store.has(id)) throw new NotFoundError();
      const previous = existing(id, input.expectedVersion);
      if (previous.pending) return commit(id, previous, { status: "published", pending: null }, input.changeId, "Cancel scheduled update");
      if (previous.doc.status === "scheduled") return commit(id, previous, { status: "draft" }, input.changeId, "Unschedule");
      throw new RefusedError("Nothing is scheduled for this post.");
    },
    async due({ now: time, limit }) {
      const due: DueSchedule[] = [];
      for (const { doc, pending, scheduleChangeId } of store.values()) {
        if (pending) due.push({ id: doc.id, kind: "update", publishAt: pending.publishAt, changeId: pending.changeId });
        else if (doc.status === "scheduled" && doc.publishAt) due.push({ id: doc.id, kind: "publish", publishAt: doc.publishAt, changeId: scheduleChangeId ?? "schedule" });
      }
      return due
        .filter((d) => at(d.publishAt) <= time.getTime())
        .sort((a, b) => at(a.publishAt) - at(b.publishAt) || a.id.localeCompare(b.id))
        .slice(0, limit);
    },
    async apply(id, input) {
      const previous = store.get(id);
      if (!previous || at(input.publishAt) > input.now.getTime()) return null;
      const { doc, pending } = previous;
      if (input.kind === "update") {
        if (doc.status !== "published" || !pending || pending.changeId !== input.changeId || at(pending.publishAt) !== at(input.publishAt)) return null;
        return commit(id, previous, { source: pending.source, status: "published", pending: null }, input.changeId, "Publish scheduled update");
      }
      if (doc.status !== "scheduled" || !doc.publishAt || at(doc.publishAt) !== at(input.publishAt)) return null;
      // A first publication records the time it was scheduled for, not the time the cron ran.
      return commit(id, previous, { status: "published", publishedAt: new Date(doc.publishAt).toISOString() }, input.changeId, "Publish scheduled");
    },
  };

  return {
    site,
    ...(schedules ? { schedules: schedulesAdapter } : {}),
    mentionStore,
    purged,
    receiveMention,
    ...(mentionsAdapter ? { mentions: mentionsAdapter } : {}),
    ...(options.notFound
      ? { insight: { notFound: async (q) => options.notFound!.filter((row) => q.includeProbes || row.kind === "page").slice(0, q.limit) } }
      : {}),
    store,
    redirects,
    mediaStore,
    deleted,
    deletedContent,
    ...(mediaAdapter ? { media: mediaAdapter } : {}),
    content: {
      ...(contentExtras ? { publishedAtSettable: true, postFields: POST_FIELDS, filters: ["kind", "tag", "author", "published"] as const } : {}),
      async list(query) {
        const needle = query.q?.toLowerCase();
        const all = [...store.values()]
          .map((s) => s.doc)
          .filter((d) => !query.status || d.status === query.status)
          .filter((d) => Boolean(d.trashedAt) === Boolean(query.trashed))
          .filter((d) => !query.kind || d.kind === query.kind)
          .filter((d) => !query.tag || (withTags(d).tags ?? []).some((t) => t.toLowerCase() === query.tag!.toLowerCase()))
          .filter((d) => !query.author || (withTags(d).authors ?? []).includes(query.author))
          .filter((d) => !query.publishedAfter || (d.publishedAt !== null && at(d.publishedAt) >= at(query.publishedAfter)))
          .filter((d) => !query.publishedBefore || (d.publishedAt !== null && at(d.publishedAt) < at(query.publishedBefore)))
          .filter((d) => !needle || d.title.toLowerCase().includes(needle) || d.source.toLowerCase().includes(needle))
          .sort((a, b) => a.id.localeCompare(b.id));
        // A search without a sort answers the newest updated first (v0.17.0), as every site's does.
        if (needle && !query.sort) all.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.id.localeCompare(b.id));
        // v0.6.0: sorted as asked, newest first for the dates and A to Z for titles unless dir says otherwise.
        const sorted = query.sort ? { sort: query.sort, dir: query.dir ?? (query.sort === "title" ? "asc" : "desc") } : undefined;
        if (sorted) {
          const key = (d: ContentDoc) => (sorted.sort === "title" ? d.title.toLowerCase() : sorted.sort === "published" ? (d.publishedAt ?? d.publishAt ?? "") : (d.updatedAt ?? ""));
          all.sort((a, b) => (sorted.dir === "asc" ? 1 : -1) * key(a).localeCompare(key(b)) || a.id.localeCompare(b.id));
        }
        const start = query.cursor ? Number(query.cursor) : 0;
        const page = all.slice(start, start + query.limit);
        const next = start + query.limit < all.length ? String(start + query.limit) : null;
        return {
          items: page.map(summaryOf),
          nextCursor: next,
          total: all.length,
          ...(sorted ? { sorted } : {}),
        };
      },
      async get(id) {
        const doc = store.get(id)?.doc;
        return doc ? withTags(doc) : null;
      },
      async saveDraft(id, input) {
        const previous = expect(id, input.expectedVersion);
        const status = previous?.doc.status === "published" ? "published" : "draft";
        return commit(id, previous, { source: input.source, status, publishAt: previous?.doc.publishAt }, input.changeId, "Save");
      },
      async publish(id, input) {
        const previous = existing(id, input.expectedVersion);
        // A publish now drops any update that was waiting: what goes live is this.
        const redate = input.publishedAt ? { redate: new Date(input.publishedAt).toISOString() } : {};
        return commit(id, previous, { source: input.source, status: "published", pending: null, ...redate }, input.changeId, "Publish");
      },
      async schedule(id, input) {
        const previous = existing(id, input.expectedVersion);
        return commit(id, previous, { source: input.source, status: "scheduled", publishAt: input.publishAt }, input.changeId, "Schedule");
      },
      async unpublish(id, input) {
        const previous = existing(id, input.expectedVersion);
        return commit(id, previous, { status: "draft" }, input.changeId, "Unpublish");
      },
      async revisions(id) {
        return store.get(id)?.history.map((h) => h.revision) ?? null;
      },
      async revisionSource(id, version) {
        return store.get(id)?.history.find((h) => h.revision.version === version)?.source ?? null;
      },
      ...(options.contentTags === false
        ? {}
        : {
            async setTags(id: string, input: { tags: string[]; expectedVersion: string; changeId: string }) {
              if (!store.has(id)) throw new NotFoundError();
              const previous = existing(id, input.expectedVersion);
              const parts = splitSource(previous.doc.source);
              if (parts.front === null) throw new RefusedError("This post has no frontmatter, so it has nowhere to keep tags.");
              const source = joinSource({ ...parts, front: writeTags(parts.front, input.tags) });
              return commit(id, previous, { source, status: previous.doc.status, publishAt: previous.doc.publishAt }, input.changeId, "Tags");
            },
          }),
      ...(contentExtras
        ? {
            async rename(id: string, input: { newId: string; expectedVersion: string; changeId: string }) {
              if (!store.has(id)) throw new NotFoundError();
              const previous = existing(id, input.expectedVersion);
              if (store.has(input.newId)) throw new RefusedError(`${input.newId} is already taken.`);
              const previousPath = previous.doc.publishedAt ? previous.doc.path : null;
              store.delete(id);
              const moved = { ...previous, doc: { ...previous.doc, id: input.newId } };
              const written = commit(input.newId, moved, { status: previous.doc.status, publishAt: previous.doc.publishAt }, input.changeId, `Rename from ${id}`);
              if (previousPath) redirects.set(previousPath, store.get(input.newId)!.doc.path!);
              return { ...written, previousPath };
            },
            // A live item leaves the site as it goes to the trash, and comes back a draft.
            async trash(id: string, input: { expectedVersion: string; changeId: string }) {
              if (!store.has(id)) throw new NotFoundError();
              const previous = existing(id, input.expectedVersion);
              if (previous.doc.trashedAt) throw new RefusedError("This post is already in the trash.");
              return commit(id, previous, { status: "draft", pending: null, trashedAt: now().toISOString() }, input.changeId, "Trash");
            },
            async restore(id: string, input: { expectedVersion: string; changeId: string }) {
              if (!store.has(id)) throw new NotFoundError();
              const previous = existing(id, input.expectedVersion);
              if (!previous.doc.trashedAt) throw new RefusedError("This post is not in the trash.");
              return commit(id, previous, { status: "draft", trashedAt: null }, input.changeId, "Restore");
            },
          }
        : {}),
      ...(options.contentDelete === false
        ? {}
        : {
            async delete(id: string, input: { expectedVersion: string; changeId: string }) {
              if (!store.has(id)) throw new NotFoundError();
              expect(id, input.expectedVersion);
              store.delete(id);
              deletedContent.push(id);
            },
          }),
    },
    preview: {
      async render(input) {
        const title = titleOf(input.source, input.id ?? "preview");
        const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
        return `<!doctype html><html><head><title>${escape(title)}</title></head><body><pre>${escape(input.source)}</pre></body></html>`;
      },
    },
  };
}
