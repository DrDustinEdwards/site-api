// The media library (v0.24.0): the whole media group over a site's index rows and its R2 bucket, written once. Each site
// wrote this for itself (bsw, julieedwards.info, txasm, Foxhound, Germomics, Foxing, dustinedwards.info) and the copies
// drifted; a site now passes `mediaLibrary` its store, bucket and rules and keeps no adapter of its own.
//
// VERSIONS. A file's version is its row's `rev` (mediaVersion). Every write to its metadata or bytes moves it once, in the
// statement that checks it (the store's writeAtRev), so a stale write is a 409, never a lost update. A write that changes
// the object checks the version before any costly work, claims it (the rev moves first), then changes the object, then the
// row's byte columns (`follow`, which does not move the rev again).
//
// BYTES. A replace, turn, mirror, shrink or revert first keeps the bytes it overwrites as a copy (`history`) and records
// it on the file's revisions, so each one can be taken back. One put writes the new bytes with the object's metadata and
// the focal point that goes with them, conditional on the etag read, so nothing races it unseen.
//
// DELETES. The site's reference check runs first and refuses a file in use; the store's `remove` takes the row and its
// revisions in one batch (and may refuse atomically, against the site's own tables); then the object goes. Copies kept in
// the served bucket go with it; copies kept in a separate backups bucket stay, as backups.

import { slugify } from "@drdustinedwards/site-helpers/slug";
import { FOCUS_METADATA, editImage } from "@dustinedwards/site-runtime/image";

import { MediaInUseError, NotFoundError, RefusedError, VersionConflictError, type MediaAdapter, type MediaUploaded } from "./adapter.js";
import {
  LARGE_MEDIA_BYTES,
  type MediaDetail,
  type MediaEmbeddedField,
  type MediaItem,
  type MediaLens,
  type MediaList,
  type MediaListQuery,
  type MediaResize,
  type MediaRevision,
  type MediaTransformOp,
  type MediaUploadLimits,
  type MediaUse,
} from "./contract.js";
import { kindOf, orientationOf, sha256Hex, transformFocus, turnsSize } from "./media.js";
import { mediaRev, mediaVersion, toArrayBuffer } from "./media-kit.js";
import { placeholderAndColor, prepareUpload, type UploadImages } from "./media-upload.js";

// ---------- What a site gives the library

/** One file's index row, in the contract's terms. A site's store maps its own columns to and from it. */
export interface MediaRecord {
  /** The storage key, which is the file's id (MediaId). */
  key: string;
  /** The version: moved by every write, only through `writeAtRev`. */
  rev: number;
  filename: string | null;
  contentType: string;
  bytes: number;
  width: number | null;
  height: number | null;
  /** The SHA-256 of the current bytes, lower case hex; null only for a row stored before the site hashed. */
  sha256: string | null;
  alt: string;
  caption: string;
  /** In the contract's spelling; the package has sorted and deduplicated a write. */
  tags: string[];
  /** "XxY" (site-runtime's focusOf), or null. */
  focus: string | null;
  credit: string;
  license: string;
  sourceUrl: string | null;
  /** YYYY-MM-DD, or null. */
  licenseExpires: string | null;
  takenAt: string | null;
  placeholder: string | null;
  color: string | null;
  /** ISO 8601. */
  uploadedAt: string;
  /** ISO 8601, or null outside the trash. */
  trashedAt: string | null;
  /** Kept only where the store says so (`MediaLibraryStore.keeps`). */
  decorative?: boolean;
  copyright?: string;
  licenseUrl?: string | null;
  acquireLicenseUrl?: string | null;
}

/** The columns a write may set. */
export type MediaRecordFields = Partial<Omit<MediaRecord, "key" | "rev">>;

export type MediaRevisionReason = MediaRevision["reason"];

/** One set of bytes a file has had. The newest is the current bytes; each earlier one names its kept copy. */
export interface MediaRevisionRecord {
  id: number;
  /** ISO 8601. */
  at: string;
  bytes: number;
  width: number | null;
  height: number | null;
  reason: MediaRevisionReason;
  sha256: string | null;
  /** Where the copy of these bytes is, in the library's history bucket; null for the current bytes. */
  copyKey: string | null;
}

/** A versioned write's outcome: the row as written, no such file, or a stale version with the rev the row holds. */
export type MediaRecordWrite = { ok: true; record: MediaRecord } | { ok: false; reason: "missing" } | { ok: false; reason: "stale"; rev: number };

/** The site's index of its files. `d1MediaStore` is one for the network's standard tables (MEDIA_LIBRARY_SQL). */
export interface MediaLibraryStore {
  /** Optional MediaItem fields the store keeps; any other is dropped on a write and never answered. */
  keeps?: { decorative?: boolean; rights?: boolean };
  /** One file, trashed or not; null when the key is not a library file. */
  record(key: string): Promise<MediaRecord | null>;
  /** Several files at once (at most 90 keys a call), in any order; keys that are not library files are left out. */
  records(keys: string[]): Promise<MediaRecord[]>;
  /** Every library file, trashed included. Lists filter and sort in the Worker: a site's library is small. */
  all(): Promise<MediaRecord[]>;
  /**
   * The file holding these bytes, trashed or not: one whose current bytes have this hash, the first uploaded; else one
   * that was uploaded or imported with it (an `upload` or `import` revision) before a shrink changed them, the earliest.
   */
  byHash(sha256: string): Promise<MediaRecord | null>;
  /** Adds a file at rev 0. Throws when the key is taken. */
  insert(record: Omit<MediaRecord, "rev">): Promise<void>;
  /** Writes `fields` and moves the rev by one, only while the row is at `expectedRev`. */
  writeAtRev(key: string, fields: MediaRecordFields, expectedRev: number): Promise<MediaRecordWrite>;
  /** Columns that follow a byte change the caller has already claimed: written as they are, the rev left alone. */
  follow(key: string, fields: MediaRecordFields): Promise<MediaRecord>;
  /** Records a set of bytes the file has had, and answers its id. */
  addRevision(key: string, revision: Omit<MediaRevisionRecord, "id">): Promise<number>;
  /** The file's revisions, newest first, at most `limit` (100 when absent). */
  revisions(key: string, limit?: number): Promise<MediaRevisionRecord[]>;
  /** Names the kept copy of a revision's bytes. */
  keepCopy(revisionId: number, copyKey: string): Promise<void>;
  /**
   * Removes the file's row and its revisions in one batch, only while the row is at `rev` (the version the reference check
   * saw). `stale` when it moved; `in-use` when the site's own tables still name the file and the store refused
   * atomically; `missing` when there was no row.
   */
  remove(key: string, rev: number): Promise<"removed" | "stale" | "in-use" | "missing">;
  /** Where the next poll of the change log starts: the newest entry's number, or 0 before the first. */
  changeCursor(): Promise<number>;
  /** Each file changed after `from` (up to `head`) once, at its latest change, oldest first; `limit + 1` at most. */
  changedSince(from: number, head: number, limit: number): Promise<Array<{ key: string; seq: number }>>;
}

/** The parts of an R2 object the library reads: no index signature, so Workers' own R2Object fits it. */
export interface MediaObject {
  etag: string;
  httpMetadata?: { contentType?: string; cacheControl?: string; contentDisposition?: string; contentEncoding?: string; contentLanguage?: string };
  customMetadata?: Record<string, string>;
}

/** The parts of an R2 bucket binding the library uses, so a site passes its binding straight in. */
export interface MediaBucket {
  head(key: string): Promise<MediaObject | null>;
  get(key: string): Promise<(MediaObject & { body: ReadableStream; arrayBuffer(): Promise<ArrayBuffer> }) | null>;
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | ReadableStream,
    options?: { httpMetadata?: MediaObject["httpMetadata"]; customMetadata?: Record<string, string>; onlyIf?: { etagMatches: string } },
  ): Promise<MediaObject | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options: { prefix: string; cursor?: string }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>;
}

/** The new file a key is made for. */
export interface MediaKeyInput {
  /** The stored name (prepareUpload's), with the stored type's extension. */
  filename: string;
  contentType: string;
  /** The upload's duplicates key (`uploadSha256`), lower case hex. */
  sha256: string;
  /** The SHA-256 of the bytes stored, which differs from `sha256` only for a converted or shrunk picture. */
  storedSha256: string;
  width: number | null;
  height: number | null;
  /** ISO 8601. */
  at: string;
}

/** One write the library made, for the site's audit or event log. */
export interface MediaLibraryEvent {
  op: "upload" | "delete" | "alt" | "tags" | "trash" | "restore" | "focus" | "caption" | "credit" | "replace" | "transform" | "revert" | "resize";
  id: string;
  changeId: string;
  /** The file a turn stored as a new file. */
  newId?: string;
}

export interface MediaLibraryOptions {
  store: MediaLibraryStore;
  /** The bucket the site serves its files from, under their keys. */
  bucket: MediaBucket;
  /** The Images binding: measuring, HEIC to JPEG, shrinks, turns, placeholders. */
  images: UploadImages;
  limits: MediaUploadLimits;
  /** Where the site serves a file. */
  url(key: string): string;
  /** Where the original downloads from; `url` when absent. */
  downloadUrl?(key: string): string;
  /**
   * The key for a new file, `attempt` 1 first, 2 and on when the one before is taken (by a row or an object). Absent:
   * `datedKey("uploads/")`. Throw RefusedError when no other key will do.
   */
  key?(file: MediaKeyInput, attempt: number): string;
  /** What uploads shrink to (capabilities.mediaResize). Absent: nothing is shrunk, and there is no oversized lens or resize pass. */
  resize?: MediaResize;
  /**
   * False for a site whose addresses carry a picture's size, so a stored picture is never shrunk in place (no resize pass,
   * capabilities.mediaResizePass). On by default where `resize` is set.
   */
  shrink?: boolean;
  /** True when pages hold a picture's width and height, so a replace or revert keeps them and a quarter turn is a new file. */
  replaceKeepsSize?: boolean;
  /**
   * The site's reference check: for each key asked (every library file when `keys` is absent), the places that use it.
   * The library asks at most 90 keys a call, so a check that binds each key stays under D1's 100. Keys with no use may
   * be left out. Throw when the check cannot run: a delete is then refused, never made. Absent: the
   * site counts no uses, and a delete removes the file.
   */
  usage?(keys?: string[]): Promise<Map<string, MediaUse[]>>;
  /**
   * False for a file that is part of the site itself (its own static assets): listed with `deletable: false`, and every
   * write and delete of it refused. Every file is deletable by default.
   */
  deletable?(record: MediaRecord): boolean;
  /**
   * Where earlier bytes are kept: `bucket` (the served bucket by default) under `prefix` (by default "history/"), at
   * <prefix><key>/<sha256>. Copies in the served bucket go when their file is deleted, and the site's media route must
   * never serve the prefix; copies in another bucket (a private backups bucket) are kept, with the file's last bytes beside them.
   */
  history?: { bucket?: MediaBucket; prefix?: string };
  /** HTTP metadata every object of the library carries beside its type, such as a cache-control. */
  httpMetadata?(record: Pick<MediaRecord, "key" | "contentType">): Record<string, string>;
  /** Custom metadata the object carries beside its focal point, written at upload and after each change of its bytes. */
  customMetadata?(record: MediaRecord): Record<string, string>;
  /** Runs after a file's bytes changed under the same key, such as a re-render of the pages that hold its size. */
  afterBytes?(key: string): Promise<void>;
  /** Runs after each write, for the site's audit or event log. A throw here fails the call. */
  onWrite?(event: MediaLibraryEvent): Promise<void> | void;
  /** The site's suggester (mediaSuggester's `suggest`), behind `suggest` and `suggestFile`. */
  suggest?(picture: ReadableStream, id?: string): Promise<{ tags: string[]; alt: string | null; model: string }>;
  /** The fetch imports go through (capabilities.mediaImport). The package checks each address and redirect first. */
  importFetch?: typeof fetch;
  /** The clock, for tests. */
  now?(): Date;
}

// ---------- Keys

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "text/csv": "csv",
  "text/plain": "txt",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
};

/** The extension a stored type is named with: the known one, else the file's own, else "bin". */
export function extensionFor(contentType: string, filename: string): string {
  const own = /\.([A-Za-z0-9]{1,8})$/.exec(filename)?.[1]?.toLowerCase();
  return EXTENSIONS[contentType] ?? own ?? "bin";
}

/**
 * The network's key for a new file: <prefix><yyyy>/<mm>/<name>-<hash>.<ext>, the name a slug of the stored name (at most
 * 60 characters, "file" when none is left) and the hash the first 8 of the upload's, with -2, -3 and on for a taken key.
 */
export function datedKey(prefix: string): (file: MediaKeyInput, attempt: number) => string {
  return (file, attempt) => {
    const name = slugify(file.filename.replace(/\.[^./]*$/, ""), { max: 60 }) || "file";
    return `${prefix}${file.at.slice(0, 4)}/${file.at.slice(5, 7)}/${name}-${file.sha256.slice(0, 8)}${attempt === 1 ? "" : `-${attempt}`}.${extensionFor(file.contentType, file.filename)}`;
  };
}

// ---------- The library

const LIBRARY_LENSES = ["no-alt", "large", "duplicates", "license-expired"] as const satisfies readonly MediaLens[];

/** What the Images binding re-encodes in its own type. Not a GIF: it may be animated, and an edit keeps one frame. */
type Encoded = "image/jpeg" | "image/png" | "image/webp" | "image/avif";
const REENCODED = new Set<string>(["image/jpeg", "image/png", "image/webp", "image/avif"]);

/** The quality a turn or a mirror encodes at: high, since each one re-encodes a lossy picture. */
const TRANSFORM_QUALITY = 92;

/** Each transform as editImage's options. A quarter turn is clockwise, as the contract's rotate-90 is. */
const TRANSFORMS: Record<MediaTransformOp, { rotate?: 90 | 180 | 270; flip?: "h" | "v" }> = {
  "rotate-90": { rotate: 90 },
  "rotate-180": { rotate: 180 },
  "rotate-270": { rotate: 270 },
  "flip-h": { flip: "h" },
  "flip-v": { flip: "v" },
};

const OFFSET = /^(0|[1-9]\d{0,8})$/;
const SEQ = /^(0|[1-9]\d{0,15})$/;
const RACED = "The file changed on the site while this was being written, so its bytes were kept as they were. Reload it and try again.";

/** Every revision a delete or a revert looks through; the history panel shows the newest 100. */
const ALL_REVISIONS = 10_000;

const positive = (n: number | null): number | null => (n !== null && n > 0 ? n : null);

/** The whole media group over the site's store and bucket. */
export function mediaLibrary(options: MediaLibraryOptions): MediaAdapter {
  const { store, bucket, images, resize } = options;
  const keyOf = options.key ? (file: MediaKeyInput, attempt: number) => options.key!(file, attempt) : datedKey("uploads/");
  const historyBucket = options.history?.bucket ?? bucket;
  const historyPrefix = options.history?.prefix ?? "history/";
  const historyServed = historyBucket === bucket;
  const shrinks = Boolean(resize) && options.shrink !== false;
  const keepsDecorative = store.keeps?.decorative === true;
  const keepsRights = store.keeps?.rights === true;
  const now = () => (options.now ? options.now() : new Date());
  const deletable = (record: MediaRecord) => options.deletable?.(record) ?? true;

  const lenses: MediaLens[] = [...(options.usage ? (["unattached"] as const) : []), ...LIBRARY_LENSES, ...(resize ? (["oversized"] as const) : [])];

  /** The site's uses, or the refusal when its check cannot run. */
  async function usesOf(keys?: string[]): Promise<Map<string, MediaUse[]>> {
    if (!options.usage) return new Map();
    try {
      if (!keys) return await options.usage();
      const uses = new Map<string, MediaUse[]>();
      for (let n = 0; n < keys.length; n += 90) for (const [key, used] of await options.usage(keys.slice(n, n + 90))) uses.set(key, used);
      return uses;
    } catch (error) {
      throw new RefusedError(`The site could not check where its files are used, so nothing was done (${error instanceof Error ? error.message : String(error)}).`);
    }
  }

  /** One file in the contract's terms. */
  function itemOf(record: MediaRecord, uses?: Map<string, MediaUse[]>): MediaItem {
    return {
      id: record.key,
      url: options.url(record.key),
      downloadUrl: options.downloadUrl?.(record.key) ?? options.url(record.key),
      filename: record.filename === null ? null : record.filename.slice(0, 300),
      contentType: record.contentType,
      bytes: record.bytes,
      width: positive(record.width),
      height: positive(record.height),
      alt: record.alt,
      uploadedAt: record.uploadedAt,
      deletable: deletable(record),
      version: mediaVersion(record.rev),
      tags: record.tags,
      trashedAt: record.trashedAt,
      focus: record.focus,
      caption: record.caption,
      placeholder: record.placeholder,
      color: record.color,
      credit: record.credit,
      license: record.license,
      sourceUrl: record.sourceUrl,
      licenseExpires: record.licenseExpires,
      takenAt: record.takenAt,
      ...(keepsDecorative && record.decorative !== undefined ? { decorative: record.decorative } : {}),
      ...(keepsRights
        ? { copyright: record.copyright ?? "", licenseUrl: record.licenseUrl ?? null, acquireLicenseUrl: record.acquireLicenseUrl ?? null }
        : {}),
      ...(uses ? { usedCount: uses.get(record.key)?.length ?? 0 } : {}),
    };
  }

  /** An item with its use count, from one check of that file alone. */
  async function itemWithUse(record: MediaRecord): Promise<MediaItem> {
    return itemOf(record, options.usage ? await usesOf([record.key]) : undefined);
  }

  /** A file a write may change: one that exists and that the site lets this API change. */
  async function recordOf(id: string): Promise<MediaRecord> {
    const record = await store.record(id);
    if (!record) throw new NotFoundError("No such media.");
    if (!deletable(record)) throw new RefusedError("This file is part of the site itself, so it is not changed or deleted here.");
    return record;
  }

  /** Refuses a stale version before any costly work; the claim checks it again. */
  function atVersion(record: MediaRecord, expectedVersion: string): void {
    if (record.rev !== mediaRev(expectedVersion)) throw new VersionConflictError(mediaVersion(record.rev), "The file changed since it was loaded.");
  }

  function settle(written: MediaRecordWrite): MediaRecord {
    if (written.ok) return written.record;
    if (written.reason === "missing") throw new NotFoundError("No such media.");
    throw new VersionConflictError(mediaVersion(written.rev), "The file changed since it was loaded.");
  }

  /** Only the optional fields the store keeps. */
  function kept(fields: MediaRecordFields): MediaRecordFields {
    const { decorative, copyright, licenseUrl, acquireLicenseUrl, ...rest } = fields;
    return {
      ...rest,
      ...(keepsDecorative && decorative !== undefined ? { decorative } : {}),
      ...(keepsRights && copyright !== undefined ? { copyright } : {}),
      ...(keepsRights && licenseUrl !== undefined ? { licenseUrl } : {}),
      ...(keepsRights && acquireLicenseUrl !== undefined ? { acquireLicenseUrl } : {}),
    };
  }

  /** A metadata write at the version the editor loaded. */
  async function write(op: MediaLibraryEvent["op"], id: string, input: { expectedVersion: string; changeId: string }, fields: MediaRecordFields): Promise<{ version: string }> {
    await recordOf(id);
    const record = settle(await store.writeAtRev(id, kept(fields), mediaRev(input.expectedVersion)));
    await options.onWrite?.({ op, id, changeId: input.changeId });
    return { version: mediaVersion(record.rev) };
  }

  /** Trash and restore: a file already in the asked state, at the version it holds, answers that version unchanged. */
  async function moveTrash(op: "trash" | "restore", id: string, input: { expectedVersion: string; changeId: string }): Promise<{ version: string }> {
    const record = await recordOf(id);
    atVersion(record, input.expectedVersion);
    if ((record.trashedAt !== null) === (op === "trash")) return { version: mediaVersion(record.rev) };
    return write(op, id, input, { trashedAt: op === "trash" ? now().toISOString() : null });
  }

  /** Claims the version for a write that changes the object: the rev moves first, so a stale writer changes nothing. */
  async function claim(id: string, expectedVersion: string): Promise<MediaRecord> {
    return settle(await store.writeAtRev(id, {}, mediaRev(expectedVersion)));
  }

  /** The object's custom metadata for a record: the site's fields, and the focal point when there is one. */
  function objectMetadata(record: MediaRecord, held: Record<string, string> = {}): Record<string, string> {
    const { [FOCUS_METADATA]: _old, ...rest } = held;
    return { ...rest, ...(options.customMetadata?.(record) ?? {}), ...(record.focus ? { [FOCUS_METADATA]: record.focus } : {}) };
  }

  /** Bytes as the library stores them; a replace or a shrink is not an upload, so it has no alt and no duplicates key. */
  const prepare = (bytes: Uint8Array, contentType: string, filename: string, changeId: string, shrink: boolean) =>
    prepareUpload(images, { bytes, contentType, filename, alt: "", changeId, resize: shrink }, resize ? { resize } : {});

  /** Refuses a picture the Images binding could not measure: its bytes are broken, and no page could size it. */
  function measured<T extends { contentType: string; width: number | null }>(prepared: T): T {
    if (prepared.width === null && kindOf(prepared.contentType) === "image" && prepared.contentType !== "image/svg+xml") {
      throw new RefusedError("Cloudflare Images could not read this picture, so it was not stored. Save it again from an image editor and upload that.");
    }
    return prepared;
  }

  /**
   * Claims a key no row or object holds by inserting the file's row under it: the row's primary key is the lock, so two
   * uploads of the same file at once never share a key. Answers the key.
   */
  async function claimKey(file: MediaKeyInput, record: Omit<MediaRecord, "rev" | "key">): Promise<string> {
    for (let attempt = 1; attempt <= 50; attempt++) {
      const key = keyOf(file, attempt);
      if ((await store.record(key)) || (await bucket.head(key))) continue;
      try {
        await store.insert({ ...record, key });
        return key;
      } catch (error) {
        // Another upload took the key between the check and the insert: try the next.
        if (await store.record(key)) continue;
        throw error;
      }
    }
    throw new RefusedError("No free name was found for this file. Rename it and upload it again.");
  }

  /** Keeps a set of bytes as a copy, and answers where. Content-addressed, so keeping the same bytes twice is one copy. */
  async function keepCopy(key: string, sha256: string, body: ReadableStream | Uint8Array | ArrayBuffer, contentType: string): Promise<string> {
    const copyKey = `${historyPrefix}${key}/${sha256}`;
    await historyBucket.put(copyKey, body, { httpMetadata: { contentType } });
    return copyKey;
  }

  /**
   * Stores a new file: its row first, which claims the key, then the object (the row removed again if the object cannot
   * be written), then its first revisions. Answers the row.
   */
  async function storeFile(file: {
    bytes: Uint8Array;
    contentType: string;
    filename: string;
    uploadSha256: string;
    sha256: string;
    width: number | null;
    height: number | null;
    fields: MediaRecordFields;
    reason: MediaRevisionReason;
    original?: { bytes: Uint8Array; width: number; height: number };
  }): Promise<MediaRecord> {
    const at = now().toISOString();
    const record: Omit<MediaRecord, "rev" | "key"> = {
      filename: file.filename.slice(0, 300),
      contentType: file.contentType,
      bytes: file.bytes.byteLength,
      width: file.width,
      height: file.height,
      sha256: file.sha256,
      alt: "",
      caption: "",
      tags: [],
      focus: null,
      credit: "",
      license: "",
      sourceUrl: null,
      licenseExpires: null,
      takenAt: null,
      placeholder: null,
      color: null,
      uploadedAt: at,
      trashedAt: null,
      ...kept(file.fields),
    };
    const key = await claimKey({ filename: file.filename, contentType: file.contentType, sha256: file.uploadSha256, storedSha256: file.sha256, width: file.width, height: file.height, at }, record);
    try {
      await bucket.put(key, file.bytes, {
        httpMetadata: { ...(options.httpMetadata?.({ ...record, key }) ?? {}), contentType: file.contentType },
        customMetadata: objectMetadata({ ...record, key, rev: 0 }),
      });
    } catch (error) {
      const claimed = await store.record(key);
      if (claimed) await store.remove(key, claimed.rev);
      throw error;
    }
    if (file.original) {
      // The original kept as the revision the shrink replaced.
      const originalSha = await sha256Hex(file.original.bytes);
      const copyKey = await keepCopy(key, originalSha, file.original.bytes, file.contentType);
      await store.addRevision(key, { at, bytes: file.original.bytes.byteLength, width: file.original.width, height: file.original.height, reason: file.reason, sha256: originalSha, copyKey });
      await store.addRevision(key, { at, bytes: file.bytes.byteLength, width: file.width, height: file.height, reason: "resize", sha256: file.sha256, copyKey: null });
    } else {
      await store.addRevision(key, { at, bytes: file.bytes.byteLength, width: file.width, height: file.height, reason: file.reason, sha256: file.sha256, copyKey: null });
    }
    const stored = await store.record(key);
    if (!stored) throw new Error(`${key} was stored, but its row cannot be read`);
    return stored;
  }

  /**
   * Puts new bytes under a file's key as its newest revision, the old ones kept first: the one way a stored file's bytes
   * change. The caller has already claimed the version. `fields` are the columns that move with the bytes.
   */
  async function swapBytes(
    record: MediaRecord,
    next: { bytes: Uint8Array; width: number | null; height: number | null; reason: MediaRevisionReason },
    fields: MediaRecordFields,
  ): Promise<MediaRecord> {
    const current = await bucket.get(record.key);
    if (!current) throw new NotFoundError("No such media.");
    const held = new Uint8Array(await current.arrayBuffer());
    // Hashed here, never taken from the row: a copy's name must be its own bytes, or it overwrites another's.
    const heldSha = await sha256Hex(held);
    const copyKey = await keepCopy(record.key, heldSha, held, record.contentType);
    // The newest revision names the copy only when it is these bytes and names none yet: a copy recorded under an older
    // scheme is kept as it is, and a newest row that is other bytes gets a row of its own for these.
    const [latest] = await store.revisions(record.key, 1);
    const isHeld = latest !== undefined && (latest.sha256 ? latest.sha256 === heldSha : !latest.copyKey);
    if (isHeld && !latest.copyKey) await store.keepCopy(latest.id, copyKey);
    if (!isHeld) {
      await store.addRevision(record.key, {
        at: latest ? now().toISOString() : record.uploadedAt,
        bytes: held.byteLength,
        width: record.width,
        height: record.height,
        reason: latest ? "replace" : record.sourceUrl ? "import" : "upload",
        sha256: heldSha,
        copyKey,
      });
    }
    const sha256 = await sha256Hex(next.bytes);
    const after: MediaRecord = { ...record, ...kept(fields), bytes: next.bytes.byteLength, width: next.width, height: next.height, sha256 };
    const written = await bucket.put(record.key, next.bytes, {
      httpMetadata: { ...current.httpMetadata, contentType: record.contentType },
      customMetadata: objectMetadata(after, current.customMetadata),
      onlyIf: { etagMatches: current.etag },
    });
    if (!written) throw new RefusedError(RACED);
    // The row first, so it describes the bytes served even if the revision cannot be written.
    const followed = await store.follow(record.key, { ...kept(fields), bytes: next.bytes.byteLength, width: next.width, height: next.height, sha256 });
    await store.addRevision(record.key, { at: now().toISOString(), bytes: next.bytes.byteLength, width: next.width, height: next.height, reason: next.reason, sha256, copyKey: null });
    await options.afterBytes?.(record.key);
    return followed;
  }

  /** Placeholder and color for new bytes, where the binding can measure them. */
  const looks = (bytes: Uint8Array, width: number | null) => (width ? placeholderAndColor(images, bytes) : Promise.resolve({ placeholder: null, color: null }));

  /** Every key the bucket holds under a prefix. */
  async function listed(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await historyBucket.list({ prefix, ...(cursor ? { cursor } : {}) });
      keys.push(...page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return keys;
  }

  const adapter: MediaAdapter = {
    limits: options.limits,
    lenses,
    filters: true,
    readsEmbedded: true,
    ...(options.replaceKeepsSize ? { replaceKeepsSize: true } : {}),
    ...(options.usage ? { usage: true } : {}),
    ...(resize ? { resize } : {}),
    ...(options.importFetch ? { importFetch: options.importFetch } : {}),

    async list(query: MediaListQuery): Promise<MediaList> {
      const start = query.cursor === undefined ? 0 : OFFSET.test(query.cursor) ? Number(query.cursor) : Number.NaN;
      if (Number.isNaN(start)) throw new RefusedError("That page cursor is not this site's; reload the library.");
      // The cursor first: a change that lands while the page is read is in the next poll, not lost between them.
      const cursor = String(await store.changeCursor());
      const records = await store.all();
      const uses = options.usage ? await usesOf() : undefined;
      const hashes = new Map<string, number>();
      for (const r of records) if (r.sha256) hashes.set(r.sha256, (hashes.get(r.sha256) ?? 0) + 1);
      const today = now().toISOString().slice(0, 10);
      const lens: Record<MediaLens, (r: MediaRecord) => boolean> = {
        unattached: (r) => (uses?.get(r.key)?.length ?? 0) === 0,
        "no-alt": (r) => r.alt.trim() === "" && r.decorative !== true,
        large: (r) => r.bytes > LARGE_MEDIA_BYTES,
        duplicates: (r) => r.sha256 !== null && (hashes.get(r.sha256) ?? 0) > 1,
        "license-expired": (r) => r.licenseExpires !== null && r.licenseExpires < today,
        oversized: (r) => resize !== undefined && Math.max(r.width ?? 0, r.height ?? 0) > resize.maxEdge,
      };
      const needle = query.q?.trim().toLowerCase();
      const matching = records.filter(
        (r) =>
          (query.trashed === "only" ? r.trashedAt !== null : r.trashedAt === null) &&
          (!query.tag || r.tags.includes(query.tag)) &&
          (!needle || [r.key, r.filename ?? "", r.alt, r.caption, r.credit, ...r.tags].some((t) => t.toLowerCase().includes(needle))) &&
          (!query.lens || lens[query.lens](r)) &&
          (!query.orientation || orientationOf(positive(r.width), positive(r.height)) === query.orientation) &&
          (!query.kind || kindOf(r.contentType) === query.kind),
      );
      // The contract's defaults: added, size and used run largest first, name A to Z. Ties: newest first, then by key.
      const sort = query.sort ?? "added";
      const dir = query.dir ?? (sort === "name" ? "asc" : "desc");
      const keyOf_ = (r: MediaRecord): string | number =>
        sort === "size" ? r.bytes : sort === "used" ? (uses?.get(r.key)?.length ?? 0) : sort === "name" ? (r.filename ?? r.key).toLowerCase() : r.uploadedAt;
      const sorted = matching.sort((a, b) => {
        const [x, y] = [keyOf_(a), keyOf_(b)];
        const by = typeof x === "number" ? x - (y as number) : x.localeCompare(y as string);
        return (dir === "asc" ? 1 : -1) * by || b.uploadedAt.localeCompare(a.uploadedAt) || a.key.localeCompare(b.key);
      });
      const page = sorted.slice(start, start + query.limit);
      return {
        items: page.map((r) => itemOf(r, uses)),
        nextCursor: start + query.limit < sorted.length ? String(start + query.limit) : null,
        total: sorted.length,
        sorted: { sort, dir },
        changeCursor: cursor,
      };
    },

    async get(id): Promise<MediaDetail | null> {
      const record = await store.record(id);
      if (!record) return null;
      const uses = await usesOf([id]);
      const twins = record.sha256
        ? (await store.all())
            .filter((r) => r.sha256 === record.sha256 && r.key !== id)
            .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt) || a.key.localeCompare(b.key))
            .slice(0, 50)
            .map((r) => ({ id: r.key, filename: r.filename }))
        : [];
      return { ...itemOf(record, options.usage ? uses : undefined), usedBy: uses.get(id) ?? [], twins };
    },

    async upload(input): Promise<MediaUploaded> {
      // The limits again: the route checked them, and a site's own upload path calling this did not.
      const prepared = measured(await prepareUpload(images, input, { limits: options.limits, ...(resize ? { resize } : {}) }));
      const found = prepared.embedded;
      const embeddable: MediaEmbeddedField[] = ["credit", "license", "caption", "takenAt", ...(keepsRights ? (["copyright", "licenseUrl", "acquireLicenseUrl"] as const) : [])];
      const embedded = embeddable.filter((field) => found[field]);
      const record = await storeFile({
        bytes: prepared.bytes,
        contentType: prepared.contentType,
        filename: prepared.filename,
        uploadSha256: prepared.uploadSha256,
        sha256: prepared.sha256,
        width: prepared.width,
        height: prepared.height,
        fields: {
          alt: input.alt,
          ...(input.decorative ? { decorative: true } : {}),
          caption: found.caption ?? "",
          credit: found.credit ?? "",
          license: found.license ?? "",
          takenAt: found.takenAt ?? null,
          copyright: found.copyright ?? "",
          licenseUrl: found.licenseUrl ?? null,
          acquireLicenseUrl: found.acquireLicenseUrl ?? null,
          sourceUrl: input.sourceUrl ?? null,
          placeholder: prepared.placeholder,
          color: prepared.color,
        },
        reason: input.sourceUrl ? "import" : "upload",
        ...(prepared.resizedFrom && prepared.original
          ? { original: { bytes: prepared.original, width: prepared.resizedFrom.width, height: prepared.resizedFrom.height } }
          : {}),
      });
      await options.onWrite?.({ op: "upload", id: record.key, changeId: input.changeId });
      return {
        ...(await itemWithUse(record)),
        ...(embedded.length > 0 ? { embedded } : {}),
        ...(prepared.resizedFrom ? { resizedFrom: prepared.resizedFrom } : {}),
      };
    },

    // The reference check, then the rows (refused atomically where the store guards them), then the objects, so a failure
    // leaves only bytes nothing lists.
    async delete(id, input) {
      const record = await recordOf(id);
      const uses = await usesOf([id]);
      const using = uses.get(id) ?? [];
      if (using.length > 0) throw new MediaInUseError(using);
      const copies = historyServed ? (await store.revisions(id, ALL_REVISIONS)).flatMap((r) => (r.copyKey ? [r.copyKey] : [])) : [];
      if (!historyServed) {
        // A backups bucket keeps the last bytes too, so a file deleted for good can still be put back by hand.
        const last = await bucket.get(id);
        if (last) {
          const bytes = new Uint8Array(await last.arrayBuffer());
          await keepCopy(id, await sha256Hex(bytes), bytes, record.contentType);
        }
      }
      const removed = await store.remove(id, record.rev);
      if (removed === "missing") throw new NotFoundError("No such media.");
      if (removed === "stale") throw new RefusedError("The file changed while it was being deleted, so it was kept. Reload it, then delete it again.");
      if (removed === "in-use") {
        const now_ = (await usesOf([id])).get(id) ?? [];
        if (now_.length > 0) throw new MediaInUseError(now_);
        throw new RefusedError("The file came into use while it was being deleted, so it was kept. Check where it is used, then try again.");
      }
      const extra = historyServed ? await listed(`${historyPrefix}${id}/`) : [];
      // The file first, then its copies, at most 1000 keys a call (R2's limit).
      await bucket.delete(id);
      const gone = [...new Set([...copies, ...extra])];
      for (let n = 0; n < gone.length; n += 1000) await bucket.delete(gone.slice(n, n + 1000));
      await options.onWrite?.({ op: "delete", id, changeId: input.changeId });
    },

    setAlt: (id, input) => write("alt", id, input, { alt: input.alt, ...(input.decorative !== undefined ? { decorative: input.decorative } : {}) }),
    setTags: (id, input) => write("tags", id, input, { tags: input.tags }),
    trash: (id, input) => moveTrash("trash", id, input),
    restore: (id, input) => moveTrash("restore", id, input),
    setCaption: (id, input) => write("caption", id, input, { caption: input.caption }),

    // The object's customMetadata `focus` is what site-runtime ./image crops around. Claimed first, then the object, then
    // the row.
    async setFocus(id, input) {
      const record = await recordOf(id);
      atVersion(record, input.expectedVersion);
      const object = await bucket.get(id);
      if (!object) throw new NotFoundError("No such media.");
      const claimed = await claim(id, input.expectedVersion);
      const after = { ...claimed, focus: input.focus };
      const written = await bucket.put(id, await object.arrayBuffer(), {
        ...(object.httpMetadata ? { httpMetadata: object.httpMetadata } : {}),
        customMetadata: objectMetadata(after, object.customMetadata),
        onlyIf: { etagMatches: object.etag },
      });
      if (!written) throw new RefusedError(RACED);
      await store.follow(id, { focus: input.focus });
      await options.onWrite?.({ op: "focus", id, changeId: input.changeId });
      return { version: mediaVersion(claimed.rev) };
    },

    setCredit: (id, input) =>
      write("credit", id, input, {
        credit: input.credit,
        license: input.license,
        sourceUrl: input.sourceUrl,
        licenseExpires: input.licenseExpires,
        ...(input.copyright !== undefined ? { copyright: input.copyright } : {}),
        ...(input.licenseUrl !== undefined ? { licenseUrl: input.licenseUrl } : {}),
        ...(input.acquireLicenseUrl !== undefined ? { acquireLicenseUrl: input.acquireLicenseUrl } : {}),
      }),

    // The image route keys each cached size on the object's etag (site-runtime ./image), so no stored size of the old
    // bytes is served after a replace.
    async replace(id, input) {
      const record = await recordOf(id);
      atVersion(record, input.expectedVersion);
      const prepared = measured(await prepare(input.bytes, input.contentType, input.filename, input.changeId, false));
      if (options.replaceKeepsSize && (prepared.width !== positive(record.width) || prepared.height !== positive(record.height))) {
        throw new RefusedError(
          `Pages on this site hold this picture's size (${record.width ?? "?"} by ${record.height ?? "?"}), and the new one is ${prepared.width ?? "?"} by ${prepared.height ?? "?"}. Upload it as a new file instead.`,
        );
      }
      const claimed = await claim(id, input.expectedVersion);
      const after = await swapBytes(
        claimed,
        { bytes: prepared.bytes, width: prepared.width, height: prepared.height, reason: "replace" },
        { focus: null, filename: input.filename.slice(0, 300), placeholder: prepared.placeholder, color: prepared.color },
      );
      await options.onWrite?.({ op: "replace", id, changeId: input.changeId });
      return { item: await itemWithUse(after), sizesNeedPurge: false };
    },

    async findByHash(sha256) {
      const record = await store.byHash(sha256);
      return record ? itemWithUse(record) : null;
    },

    // In place, unless the package asks for a new file (a quarter turn of a picture that is not square, on a site whose
    // pages hold its size): then the turned picture is stored as a new file with the old one's words, and the old is kept.
    async transform(id, input) {
      const record = await recordOf(id);
      atVersion(record, input.expectedVersion);
      if (!REENCODED.has(record.contentType)) throw new RefusedError(`A ${record.contentType} file is not turned here: a GIF may be animated, and an edit would keep one frame.`);
      const object = await bucket.get(id);
      if (!object) throw new NotFoundError("No such media.");
      const edited = await editImage(images, object.body, { ...TRANSFORMS[input.op], quality: TRANSFORM_QUALITY, format: record.contentType as Encoded });
      const bytes = new Uint8Array(await edited.arrayBuffer());
      const [width, height] = turnsSize(input.op) ? [record.height, record.width] : [record.width, record.height];
      const focus = transformFocus(record.focus, input.op);
      const { placeholder, color } = await looks(bytes, width);
      if (input.asNewFile) {
        const sha256 = await sha256Hex(bytes);
        const created = await storeFile({
          bytes,
          contentType: record.contentType,
          filename: record.filename ?? id.split("/").pop()!,
          uploadSha256: sha256,
          sha256,
          width,
          height,
          fields: {
            alt: record.alt,
            ...(record.decorative !== undefined ? { decorative: record.decorative } : {}),
            caption: record.caption,
            tags: record.tags,
            focus,
            credit: record.credit,
            license: record.license,
            sourceUrl: record.sourceUrl,
            licenseExpires: record.licenseExpires,
            takenAt: record.takenAt,
            ...(record.copyright !== undefined ? { copyright: record.copyright } : {}),
            ...(record.licenseUrl !== undefined ? { licenseUrl: record.licenseUrl } : {}),
            ...(record.acquireLicenseUrl !== undefined ? { acquireLicenseUrl: record.acquireLicenseUrl } : {}),
            placeholder,
            color,
          },
          reason: "transform",
        });
        await options.onWrite?.({ op: "transform", id, changeId: input.changeId, newId: created.key });
        return { item: await itemWithUse(created), sizesNeedPurge: false };
      }
      const claimed = await claim(id, input.expectedVersion);
      const after = await swapBytes(claimed, { bytes, width, height, reason: "transform" }, { focus, placeholder, color });
      await options.onWrite?.({ op: "transform", id, changeId: input.changeId });
      return { item: await itemWithUse(after), sizesNeedPurge: false };
    },

    // A file never changed has one revision, its bytes as uploaded, whether or not the site recorded it.
    async history(id) {
      const record = await store.record(id);
      if (!record) return null;
      const revisions = await store.revisions(id);
      const listed_ =
        revisions.length > 0
          ? revisions
          : [{ id: 0, at: record.uploadedAt, bytes: record.bytes, width: record.width, height: record.height, reason: record.sourceUrl ? ("import" as const) : ("upload" as const), sha256: record.sha256, copyKey: null }];
      return listed_.map((r, n) => ({
        rev: String(r.id),
        at: r.at,
        bytes: r.bytes,
        width: positive(r.width),
        height: positive(r.height),
        reason: r.reason,
        current: n === 0,
      }));
    },

    // The package has checked that `to` is an earlier revision; its bytes come back from the copy kept, as a new
    // revision, so a revert is itself undone by another.
    async revert(id, input) {
      const record = await recordOf(id);
      atVersion(record, input.expectedVersion);
      const target = (await store.revisions(id, ALL_REVISIONS)).find((r) => String(r.id) === input.to);
      const copy = target?.copyKey ? await historyBucket.get(target.copyKey) : null;
      if (!target || !copy) throw new NotFoundError("This file has no such earlier version, or its copy is gone.");
      const bytes = new Uint8Array(await copy.arrayBuffer());
      const width = positive(target.width);
      const claimed = await claim(id, input.expectedVersion);
      const after = await swapBytes(claimed, { bytes, width, height: positive(target.height), reason: "revert" }, { focus: null, ...(await looks(bytes, width)) });
      await options.onWrite?.({ op: "revert", id, changeId: input.changeId });
      return { item: await itemWithUse(after), sizesNeedPurge: false };
    },

    // From the change log the store keeps: every insert, update and delete of a row.
    async changes({ since, limit }) {
      const head = await store.changeCursor();
      if (!SEQ.test(since) || Number(since) > head) throw new RefusedError("That change cursor is not this site's; reload the library.");
      const changed = await store.changedSince(Number(since), head, limit);
      const more = changed.length > limit;
      const taken = changed.slice(0, limit);
      // In groups of 90: D1 binds at most 100 values to a statement, and a poll may name up to 200 files.
      const keys = taken.map((c) => c.key);
      const found: MediaRecord[] = [];
      for (let n = 0; n < keys.length; n += 90) found.push(...(await store.records(keys.slice(n, n + 90))));
      const records = new Map(found.map((r) => [r.key, r]));
      const uses = options.usage && records.size > 0 ? await usesOf([...records.keys()]) : undefined;
      return {
        items: taken.flatMap((c) => {
          const record = records.get(c.key);
          return record ? [itemOf(record, options.usage ? (uses ?? new Map()) : undefined)] : [];
        }),
        removed: taken.filter((c) => !records.has(c.key)).map((c) => c.key),
        cursor: String(more ? taken[taken.length - 1]!.seq : head),
        more,
      };
    },

    ...(options.suggest
      ? {
          // Never applied: Carrel shows them, and a person accepts each as an alt or tags write.
          async suggest(id: string) {
            const record = await store.record(id);
            if (!record) return null;
            if (kindOf(record.contentType) !== "image") throw new RefusedError("Only a picture gets suggestions.");
            const object = await bucket.get(id);
            if (!object) return null;
            try {
              return await options.suggest!(object.body, id);
            } catch (error) {
              throw new RefusedError(`No suggestion was made: ${error instanceof Error ? error.message : String(error)}`);
            }
          },
          async suggestFile({ bytes }: { bytes: Uint8Array; contentType: string }) {
            return options.suggest!(new Response(toArrayBuffer(bytes)).body!);
          },
        }
      : {}),
  };

  if (shrinks && resize) {
    // In place, the old bytes kept in the history; a picture already within the size answers as it is, and so does a GIF
    // (prepareUpload shrinks none: it may be animated). The focal point stays: a shrink keeps the picture's proportions.
    adapter.shrink = async (id, input) => {
      const record = await recordOf(id);
      atVersion(record, input.expectedVersion);
      if (Math.max(record.width ?? 0, record.height ?? 0) <= resize.maxEdge || !REENCODED.has(record.contentType)) return { resized: false, item: await itemWithUse(record) };
      const object = await bucket.get(id);
      if (!object) throw new NotFoundError("No such media.");
      const prepared = await prepare(new Uint8Array(await object.arrayBuffer()), record.contentType, record.filename ?? id, input.changeId, true);
      if (!prepared.resizedFrom) return { resized: false, item: await itemWithUse(record) };
      const claimed = await claim(id, input.expectedVersion);
      const after = await swapBytes(
        claimed,
        { bytes: prepared.bytes, width: prepared.width, height: prepared.height, reason: "resize" },
        { placeholder: prepared.placeholder, color: prepared.color },
      );
      await options.onWrite?.({ op: "resize", id, changeId: input.changeId });
      return { resized: true, item: await itemWithUse(after) };
    };
  }

  return adapter;
}
