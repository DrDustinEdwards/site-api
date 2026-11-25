import { FOCUS_METADATA } from "@dustinedwards/site-runtime/image";

import { NotFoundError, RefusedError, VersionConflictError } from "../adapter.js";
import { type MediaItem, type MediaLens, type MediaUse } from "../contract.js";
import { sha256Hex } from "@dustinedwards/site-runtime/encoding";
import { kindOf } from "../media.js";
import { mediaRev, mediaVersion } from "../media-kit.js";
import { placeholderAndColor, prepareUpload } from "../media-upload.js";
import {
  type MediaKeyInput,
  type MediaLibraryEvent,
  type MediaLibraryOptions,
  type MediaRecord,
  type MediaRecordFields,
  type MediaRecordWrite,
  type MediaRevisionReason,
} from "./types.js";
import { LIBRARY_LENSES, RACED, datedKey, positive } from "./constants.js";
export type {
  MediaBucket,
  MediaKeyInput,
  MediaLibraryEvent,
  MediaLibraryOptions,
  MediaLibraryStore,
  MediaObject,
  MediaRecord,
  MediaRecordFields,
  MediaRecordWrite,
  MediaRevisionReason,
  MediaRevisionRecord,
} from "./types.js";
export {
  PICTURE_RESIZE,
  PICTURE_TYPES,
  datedKey,
  extensionFor,
  pictureLimits,
} from "./constants.js";

/** What every method of the media library shares: the options, their derived settings and the row and object helpers. */
export function libraryCore(options: MediaLibraryOptions) {
  const { store, bucket, images, resize } = options;
  const keyOf = options.key
    ? (file: MediaKeyInput, attempt: number) => options.key!(file, attempt)
    : datedKey("uploads/");
  const historyBucket = options.history?.bucket ?? bucket;
  const historyPrefix = options.history?.prefix ?? "history/";
  const historyServed = historyBucket === bucket;
  const shrinks = Boolean(resize) && options.shrink !== false;
  const keepsDecorative = store.keeps?.decorative === true;
  const keepsRights = store.keeps?.rights === true;
  const now = () => (options.now ? options.now() : new Date());
  const deletable = (record: MediaRecord) => options.deletable?.(record) ?? true;

  const lenses: MediaLens[] = [
    ...(options.usage ? (["unattached"] as const) : []),
    ...LIBRARY_LENSES,
    ...(resize ? (["oversized"] as const) : []),
  ];

  /** The site's uses, or the refusal when its check cannot run. */
  async function usesOf(keys?: string[]): Promise<Map<string, MediaUse[]>> {
    if (!options.usage) return new Map();
    try {
      if (!keys) return await options.usage();
      const uses = new Map<string, MediaUse[]>();
      for (let n = 0; n < keys.length; n += 90)
        for (const [key, used] of await options.usage(keys.slice(n, n + 90))) uses.set(key, used);
      return uses;
    } catch (error) {
      throw new RefusedError(
        `The site could not check where its files are used, so nothing was done (${error instanceof Error ? error.message : String(error)}).`,
      );
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
      ...(keepsDecorative && record.decorative !== undefined
        ? { decorative: record.decorative }
        : {}),
      ...(keepsRights
        ? {
            copyright: record.copyright ?? "",
            licenseUrl: record.licenseUrl ?? null,
            acquireLicenseUrl: record.acquireLicenseUrl ?? null,
          }
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
    if (!deletable(record))
      throw new RefusedError(
        "This file is part of the site itself, so it is not changed or deleted here.",
      );
    return record;
  }

  /** Refuses a stale version before any costly work; the claim checks it again. */
  function atVersion(record: MediaRecord, expectedVersion: string): void {
    if (record.rev !== mediaRev(expectedVersion))
      throw new VersionConflictError(
        mediaVersion(record.rev),
        "The file changed since it was loaded.",
      );
  }

  function settle(written: MediaRecordWrite): MediaRecord {
    if (written.ok) return written.record;
    if (written.reason === "missing") throw new NotFoundError("No such media.");
    throw new VersionConflictError(
      mediaVersion(written.rev),
      "The file changed since it was loaded.",
    );
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
  async function write(
    op: MediaLibraryEvent["op"],
    id: string,
    input: { expectedVersion: string; changeId: string },
    fields: MediaRecordFields,
  ): Promise<{ version: string }> {
    await recordOf(id);
    const record = settle(
      await store.writeAtRev(id, kept(fields), mediaRev(input.expectedVersion)),
    );
    await options.onWrite?.({ op, id, changeId: input.changeId });
    return { version: mediaVersion(record.rev) };
  }

  /** Trash and restore: a file already in the asked state, at the version it holds, answers that version unchanged. */
  async function moveTrash(
    op: "trash" | "restore",
    id: string,
    input: { expectedVersion: string; changeId: string },
  ): Promise<{ version: string }> {
    const record = await recordOf(id);
    atVersion(record, input.expectedVersion);
    if ((record.trashedAt !== null) === (op === "trash"))
      return { version: mediaVersion(record.rev) };
    return write(op, id, input, { trashedAt: op === "trash" ? now().toISOString() : null });
  }

  /** Claims the version for a write that changes the object: the rev moves first, so a stale writer changes nothing. */
  async function claim(id: string, expectedVersion: string): Promise<MediaRecord> {
    return settle(await store.writeAtRev(id, {}, mediaRev(expectedVersion)));
  }

  /** The object's custom metadata for a record: the site's fields, and the focal point when there is one. */
  function objectMetadata(
    record: MediaRecord,
    held: Record<string, string> = {},
  ): Record<string, string> {
    const { [FOCUS_METADATA]: _old, ...rest } = held;
    return {
      ...rest,
      ...options.customMetadata?.(record),
      ...(record.focus ? { [FOCUS_METADATA]: record.focus } : {}),
    };
  }

  /** Bytes as the library stores them; a replace or a shrink is not an upload, so it has no alt and no duplicates key. */
  const prepare = (
    bytes: Uint8Array,
    contentType: string,
    filename: string,
    changeId: string,
    shrink: boolean,
  ) =>
    prepareUpload(
      images,
      { bytes, contentType, filename, alt: "", changeId, resize: shrink },
      resize ? { resize } : {},
    );

  /** Refuses a picture the Images binding could not measure: its bytes are broken, and no page could size it. */
  function measured<T extends { contentType: string; width: number | null }>(prepared: T): T {
    if (
      prepared.width === null &&
      kindOf(prepared.contentType) === "image" &&
      prepared.contentType !== "image/svg+xml"
    ) {
      throw new RefusedError(
        "Cloudflare Images could not read this picture, so it was not stored. Save it again from an image editor and upload that.",
      );
    }
    return prepared;
  }

  /**
   * Claims a key no row or object holds by inserting the file's row under it: the row's primary key is the lock, so two
   * uploads of the same file at once never share a key. Answers the key.
   */
  async function claimKey(
    file: MediaKeyInput,
    record: Omit<MediaRecord, "rev" | "key">,
  ): Promise<string> {
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
  async function keepCopy(
    key: string,
    sha256: string,
    body: ReadableStream | Uint8Array | ArrayBuffer,
    contentType: string,
  ): Promise<string> {
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
    const key = await claimKey(
      {
        filename: file.filename,
        contentType: file.contentType,
        sha256: file.uploadSha256,
        storedSha256: file.sha256,
        width: file.width,
        height: file.height,
        at,
      },
      record,
    );
    try {
      await bucket.put(key, file.bytes, {
        httpMetadata: {
          ...options.httpMetadata?.({ ...record, key }),
          contentType: file.contentType,
        },
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
      await store.addRevision(key, {
        at,
        bytes: file.original.bytes.byteLength,
        width: file.original.width,
        height: file.original.height,
        reason: file.reason,
        sha256: originalSha,
        copyKey,
      });
      await store.addRevision(key, {
        at,
        bytes: file.bytes.byteLength,
        width: file.width,
        height: file.height,
        reason: "resize",
        sha256: file.sha256,
        copyKey: null,
      });
    } else {
      await store.addRevision(key, {
        at,
        bytes: file.bytes.byteLength,
        width: file.width,
        height: file.height,
        reason: file.reason,
        sha256: file.sha256,
        copyKey: null,
      });
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
    next: {
      bytes: Uint8Array;
      width: number | null;
      height: number | null;
      reason: MediaRevisionReason;
    },
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
    const isHeld =
      latest !== undefined && (latest.sha256 ? latest.sha256 === heldSha : !latest.copyKey);
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
    const hash = await sha256Hex(next.bytes);
    const after: MediaRecord = {
      ...record,
      ...kept(fields),
      bytes: next.bytes.byteLength,
      width: next.width,
      height: next.height,
      sha256: hash,
    };
    const written = await bucket.put(record.key, next.bytes, {
      httpMetadata: { ...current.httpMetadata, contentType: record.contentType },
      customMetadata: objectMetadata(after, current.customMetadata),
      onlyIf: { etagMatches: current.etag },
    });
    if (!written) throw new RefusedError(RACED);
    // The row first, so it describes the bytes served even if the revision cannot be written.
    const followed = await store.follow(record.key, {
      ...kept(fields),
      bytes: next.bytes.byteLength,
      width: next.width,
      height: next.height,
      sha256: hash,
    });
    await store.addRevision(record.key, {
      at: now().toISOString(),
      bytes: next.bytes.byteLength,
      width: next.width,
      height: next.height,
      reason: next.reason,
      sha256: hash,
      copyKey: null,
    });
    await options.afterBytes?.(record.key);
    return followed;
  }

  /** Placeholder and color for new bytes, where the binding can measure them. */
  const looks = (bytes: Uint8Array, width: number | null) =>
    width
      ? placeholderAndColor(images, bytes)
      : Promise.resolve({ placeholder: null, color: null });

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

  return {
    store,
    bucket,
    images,
    resize,
    keyOf,
    historyBucket,
    historyPrefix,
    historyServed,
    shrinks,
    keepsDecorative,
    keepsRights,
    now,
    deletable,
    lenses,
    usesOf,
    itemOf,
    itemWithUse,
    recordOf,
    atVersion,
    settle,
    kept,
    write,
    moveTrash,
    claim,
    objectMetadata,
    prepare,
    measured,
    claimKey,
    keepCopy,
    storeFile,
    swapBytes,
    looks,
    listed,
  };
}
