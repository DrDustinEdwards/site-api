import {
  type MediaResize,
  type MediaRevision,
  type MediaUploadLimits,
  type MediaUse,
} from "../contract.js";
import type { UploadImages } from "../media-upload.js";
import type { libraryCore } from "./core.js";

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
export type MediaRecordWrite =
  | { ok: true; record: MediaRecord }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "stale"; rev: number };

/** The site's index of its files. `d1MediaStore` is one for the network's standard tables (MEDIA_LIBRARY_SQL). */
export interface MediaLibraryStore {
  /** Optional MediaItem fields the store keeps; any other is dropped on a write and never answered. */
  keeps?: { decorative?: boolean; rights?: boolean };
  /** One file, trashed or not; null when the key is not a library file. */
  record(key: string): Promise<MediaRecord | null>;
  /** Several files at once (at most 90 keys a call), in any order; keys that are not library files are left out. */
  records(keys: string[]): Promise<MediaRecord[]>;
  /** Every library file, trashed included. Lists filter and sort in the Worker: lenses read the site's own usage. */
  all(): Promise<MediaRecord[]>;
  twins(sha256: string, exceptKey: string, limit: number): Promise<MediaRecord[]>;
  /**
   * The file holding these bytes, trashed or not: one whose current bytes have this hash, the first uploaded; else one
   * that was uploaded or imported with it (an `upload` or `import` revision) before a shrink changed them, the earliest.
   */
  byHash(sha256: string): Promise<MediaRecord | null>;
  /** Adds a file at rev 0. Throws when the key is taken. */
  insert(record: Omit<MediaRecord, "rev">): Promise<void>;
  /** Writes `fields` and moves the rev by one, only while the row is at `expectedRev`. */
  writeAtRev(
    key: string,
    fields: MediaRecordFields,
    expectedRev: number,
  ): Promise<MediaRecordWrite>;
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
  changedSince(
    from: number,
    head: number,
    limit: number,
  ): Promise<Array<{ key: string; seq: number }>>;
}

/** The parts of an R2 object the library reads: no index signature, so Workers' own R2Object fits it. */
export interface MediaObject {
  etag: string;
  httpMetadata?: {
    contentType?: string;
    cacheControl?: string;
    contentDisposition?: string;
    contentEncoding?: string;
    contentLanguage?: string;
  };
  customMetadata?: Record<string, string>;
}

/** The parts of an R2 bucket binding the library uses, so a site passes its binding straight in. */
export interface MediaBucket {
  head(key: string): Promise<MediaObject | null>;
  get(
    key: string,
  ): Promise<(MediaObject & { body: ReadableStream; arrayBuffer(): Promise<ArrayBuffer> }) | null>;
  put(
    key: string,
    value: ArrayBuffer | Uint8Array | ReadableStream,
    options?: {
      httpMetadata?: MediaObject["httpMetadata"];
      customMetadata?: Record<string, string>;
      onlyIf?: { etagMatches: string };
    },
  ): Promise<MediaObject | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options: {
    prefix: string;
    cursor?: string;
  }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }>;
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
  op:
    | "upload"
    | "delete"
    | "alt"
    | "tags"
    | "trash"
    | "restore"
    | "focus"
    | "caption"
    | "credit"
    | "replace"
    | "transform"
    | "revert"
    | "resize";
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
  suggest?(
    picture: ReadableStream,
    id?: string,
  ): Promise<{ tags: string[]; alt: string | null; model: string }>;
  /**
   * The fetch imports go through (capabilities.mediaImport). The package checks each address and redirect first.
   * The Worker's own `fetch` when absent, so imports are on; `null` turns them off.
   */
  importFetch?: typeof fetch | null;
  /** The clock, for tests. */
  now?(): Date;
}

/** What every method of the media library shares. */
export type LibraryCore = ReturnType<typeof libraryCore>;
