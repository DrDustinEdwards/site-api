// The media group (v0.2.0, writes v0.4.0, lenses v0.6.0).

import { z } from "zod";
import { ChangeId, SortDir, Timestamp, Version } from "./base.js";

/** The largest upload any site may declare: well under a Worker's request body limit. */
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

/**
 * What a site accepts as an upload, declared by the site (v0.2.0). `types` are MIME types, such as
 * image/png; the package refuses anything else before the site sees a byte.
 */
export const MediaUploadLimits = z.object({
  maxBytes: z.number().int().min(1).max(MAX_MEDIA_BYTES),
  types: z.array(z.string().regex(/^[a-z]+\/[a-z0-9.+-]+$/)).min(1).max(50),
});

/**
 * The ready-made views of a library (v0.6.0), each optional per site: files nothing uses (by the
 * site's own reference check), files with no alt text, and files larger than LARGE_MEDIA_BYTES.
 */
export const MEDIA_LENSES = ["unattached", "no-alt", "large"] as const;
export const MediaLens = z.enum(MEDIA_LENSES);
export const LARGE_MEDIA_BYTES = 1024 * 1024;

/**
 * A site's id for one media file: its storage key, such as 2026/09/photo-a1b2.webp. Segments are
 * joined by "/", and none may be empty, "." or "..", so an id is never a path out of the store.
 */
export const MediaId = z
  .string()
  .max(300)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/)
  .refine((id) => !id.split("/").some((part) => part === "." || part === ".."), "An id segment may not be . or ..");

/** One place a file is used, as the site's own reference check found it. */
export const MediaUse = z.object({
  /** What uses it, such as "post". */
  type: z.string().min(1).max(64),
  id: z.string().min(1).max(300),
  title: z.string().max(1000),
  /** Where in it, such as "cover image" or "line 12". */
  detail: z.string().max(500),
});

/** A tag: lower case words joined by single hyphens, so the same tag is always spelled one way. */
export const MediaTag = z.string().min(1).max(32).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

/** A file's whole tag set (v0.4.0). The most any file carries is 12. */
export const MediaTags = z.array(MediaTag).max(12);

export const MediaItem = z.object({
  id: MediaId,
  /** Where the site serves it: a path on the site, such as /media/2026/09/photo.webp, or a full URL. */
  url: z.string().min(1).max(2000).refine((u) => u.startsWith("/") || /^https:\/\//.test(u), "A path or an https URL"),
  /** The name it was uploaded with, when the site kept it. */
  filename: z.string().max(300).nullable(),
  contentType: z.string().min(1).max(200),
  bytes: z.number().int().min(0),
  width: z.number().int().min(1).nullable(),
  height: z.number().int().min(1).nullable(),
  alt: z.string().max(2000),
  uploadedAt: Timestamp.nullable(),
  /** False for files the site will never delete through this API, such as its own static assets. */
  deletable: z.boolean(),
  /**
   * Opaque, like a content version (v0.4.0): it identifies the file's editable metadata, so alt,
   * tags and trash state each move it. Present on a site that offers any media write.
   */
  version: Version.optional(),
  /** The file's tags (v0.4.0), present on a site that keeps them. */
  tags: MediaTags.optional(),
  /** When the file was moved to the trash (v0.4.0); null or absent when it is in the library. */
  trashedAt: Timestamp.nullable().optional(),
});

/** One file with the places it is used: what a delete would be refused over. */
export const MediaDetail = MediaItem.extend({
  usedBy: z.array(MediaUse),
});

/** What a media list can be sorted by (v0.6.0). added runs newest first, size largest first and name A to Z, unless `dir` says otherwise. */
export const MEDIA_SORTS = ["added", "name", "size"] as const;

export const MediaListQuery = z.object({
  q: z.string().max(200).optional(),
  /** v0.6.0, on a site that lists the lens in capabilities.mediaLenses; any other site answers 501. */
  lens: MediaLens.optional(),
  /** v0.6.0. A site that sorts says so in the answer's `sorted`. */
  sort: z.enum(MEDIA_SORTS).optional(),
  dir: SortDir.optional(),
  /** Only files carrying this tag (v0.4.0). A site without tags ignores it. */
  tag: MediaTag.optional(),
  /** "only" lists the trash (v0.4.0). Without it the trash is left out. A site without a trash ignores it. */
  trashed: z.enum(["only"]).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const MediaList = z.object({
  items: z.array(MediaItem),
  nextCursor: z.string().nullable(),
  /** How many files match across every page (v0.6.0), where the site can count them. */
  total: z.number().int().min(0).optional(),
  /** The order the site applied (v0.6.0). Absent: the site did not sort as asked. */
  sorted: z.object({ sort: z.enum(MEDIA_SORTS), dir: SortDir }).optional(),
});

/**
 * An upload is the file's own bytes as the body, its type as Content-Type, and these as the query:
 * no base64, so a file costs its own size and no more.
 */
export const MediaUploadQuery = z.object({
  // A file name may not hold control characters, on purpose.
  // oxlint-disable-next-line no-control-regex
  filename: z.string().min(1).max(200).regex(/^[^/\\\u0000-\u001f]+$/, "A file name, with no path"),
  alt: z.string().max(2000).default(""),
  changeId: ChangeId,
});

export const MediaDeleteQuery = z.object({
  changeId: ChangeId,
});

export const MediaDeleteResult = z.object({
  id: MediaId,
  deleted: z.literal(true),
  changeId: ChangeId,
});

// ---------- media writes (v0.4.0)

/** Every media metadata write names the version the caller last saw and Carrel's change id. */
export const MediaAltInput = z.object({
  alt: z.string().max(2000),
  expectedVersion: Version,
  changeId: ChangeId,
});

/** The file's whole tag set after the write. */
export const MediaTagsInput = z.object({
  tags: MediaTags,
  expectedVersion: Version,
  changeId: ChangeId,
});

/** The body of a trash and of a restore. */
export const MediaTrashInput = z.object({
  expectedVersion: Version,
  changeId: ChangeId,
});

export const MediaWriteResult = z.object({
  id: MediaId,
  /** The file's version after the write. */
  version: Version,
  changeId: ChangeId,
});

export const MEDIA_BULK_OPS = ["trash", "restore", "delete", "add-tags", "remove-tags"] as const;
export const MAX_MEDIA_BULK = 100;

/** One file in a bulk write, with its own change id so each file has its own authorship record. */
export const MediaBulkItem = z.object({
  id: MediaId,
  /** Required for every op but delete, which is the site's reference check and carries no version. */
  expectedVersion: Version.optional(),
  changeId: ChangeId,
});

export const MediaBulkInput = z.object({
  op: z.enum(MEDIA_BULK_OPS),
  /** For add-tags and remove-tags only: the tags to add to, or take from, each file. */
  tags: MediaTags.optional(),
  items: z.array(MediaBulkItem).min(1).max(MAX_MEDIA_BULK),
});

/** The outcome of one file. A refusal for one file never stops the others. */
export const MediaBulkOutcome = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    id: MediaId,
    changeId: ChangeId,
    /** The file's version after the write; absent after a delete. */
    version: Version.optional(),
  }),
  z.object({
    ok: z.literal(false),
    id: MediaId,
    changeId: ChangeId,
    error: z.enum(["not-found", "version-conflict", "refused", "invalid", "internal"]),
    message: z.string(),
    /** On version-conflict: what the site holds now. */
    currentVersion: Version.nullable().optional(),
    /** On a refused delete: every place the file is used. */
    usedBy: z.array(MediaUse).optional(),
  }),
]);

/** The request as a whole answers 200 whenever it was well formed: each file's result is its own. */
export const MediaBulkResult = z.object({
  op: z.enum(MEDIA_BULK_OPS),
  results: z.array(MediaBulkOutcome),
});

/** Empty the trash: delete for good every file in it, each through the site's own reference check. */
export const MediaTrashEmptyInput = z.object({
  /** The base of each file's own change id: file n is recorded as `<changeId>-<n>`, so each has its own authorship record. */
  changeId: ChangeId,
});

/** The most files one empty-trash request deletes. When more remain, `more` is true and the caller sends it again. */
export const MAX_TRASH_EMPTY = 100;

export const MediaTrashEmptyResult = z.object({
  changeId: ChangeId,
  /** The ids deleted for good. */
  deleted: z.array(MediaId),
  /** Trashed files the site would not delete (still used by a post, for one); they stay in the trash. */
  refused: z.array(z.object({ id: MediaId, message: z.string(), usedBy: z.array(MediaUse).optional() })),
  /** True when the trash held more than one request handles. */
  more: z.boolean(),
});

export type MediaUploadLimits = z.infer<typeof MediaUploadLimits>;
export type MediaUse = z.infer<typeof MediaUse>;
export type MediaItem = z.infer<typeof MediaItem>;
export type MediaDetail = z.infer<typeof MediaDetail>;
export type MediaListQuery = z.infer<typeof MediaListQuery>;
export type MediaLens = z.infer<typeof MediaLens>;
export type MediaSort = (typeof MEDIA_SORTS)[number];
export type MediaList = z.infer<typeof MediaList>;
export type MediaUploadQuery = z.infer<typeof MediaUploadQuery>;
export type MediaDeleteResult = z.infer<typeof MediaDeleteResult>;
export type MediaTags = z.infer<typeof MediaTags>;
export type MediaAltInput = z.infer<typeof MediaAltInput>;
export type MediaTagsInput = z.infer<typeof MediaTagsInput>;
export type MediaTrashInput = z.infer<typeof MediaTrashInput>;
export type MediaWriteResult = z.infer<typeof MediaWriteResult>;
export type MediaBulkItem = z.infer<typeof MediaBulkItem>;
export type MediaBulkInput = z.infer<typeof MediaBulkInput>;
export type MediaBulkOutcome = z.infer<typeof MediaBulkOutcome>;
export type MediaBulkResult = z.infer<typeof MediaBulkResult>;
export type MediaTrashEmptyInput = z.infer<typeof MediaTrashEmptyInput>;
export type MediaTrashEmptyResult = z.infer<typeof MediaTrashEmptyResult>;
