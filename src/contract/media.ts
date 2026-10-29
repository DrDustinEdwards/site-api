// The media group (v0.2.0, writes v0.4.0, lenses v0.6.0, focal point, caption and replace v0.10.0, the media library's
// fourteen ideas v0.13.0).

import { focusOf } from "@dustinedwards/site-runtime/image";
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
 * site's own reference check), files with no alt text, and files larger than LARGE_MEDIA_BYTES. v0.13.0 adds files whose
 * bytes are exactly another file's (by content hash, never a picture's likeness), files whose license has run out
 * (`licenseExpires` before today, in UTC), and pictures with an edge longer than the site's `mediaResize.maxEdge`.
 */
export const MEDIA_LENSES = ["unattached", "no-alt", "large", "duplicates", "license-expired", "oversized"] as const;
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

/**
 * A file's focal point (v0.10.0): "XxY", each from 0 to 1 from the top left with up to three decimals, such as
 * "0.25x0.4". The site keeps it where site-runtime's ./image reads it for its crops (an R2 object's customMetadata
 * `focus`, FOCUS_METADATA), so the package takes only what that module's `focusOf` takes.
 */
export const MediaFocus = z
  .string()
  .max(20)
  .refine((v) => focusOf(v) !== null, 'A focal point is "XxY", each from 0 to 1 with up to three decimals');

/** A file's caption (v0.10.0): what a figure shows under it, beside its alt text. "" for none. */
export const MediaCaption = z.string().max(2000);

/** Where the site serves a file, or offers it: a path on the site, such as /media/2026/09/photo.webp, or a full https URL. */
const MediaAddress = z.string().min(1).max(2000).refine((u) => u.startsWith("/") || /^https:\/\//.test(u), "A path or an https URL");

/** The longest placeholder a file may carry (v0.13.0): a tiny blurred picture, never the picture itself. */
export const MAX_PLACEHOLDER_CHARS = 2048;

/**
 * A file's placeholder (v0.13.0): a tiny picture as a base64 data: URI in a raster type, which a page shows while the file
 * loads. No SVG, so a placeholder never carries markup.
 */
export const MediaPlaceholder = z
  .string()
  .max(MAX_PLACEHOLDER_CHARS)
  .regex(/^data:image\/(png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/, "A base64 data: URI of a png, jpeg, gif, webp or avif");

/** A file's main color (v0.13.0), as #rrggbb in lower case. */
export const MediaColor = z.string().regex(/^#[0-9a-f]{6}$/, "A color as #rrggbb in lower case");

/** Who made a file and the terms it is used under (v0.13.0): free text, "" for none. */
export const MediaCredit = z.string().max(300);
export const MediaLicense = z.string().max(300);

/** Where a file came from (v0.13.0): the page or file it was taken from, http or https. */
export const MediaSourceUrl = z.url({ protocol: /^https?$/ }).max(2000);

/** What a file is, from its type (v0.13.0): kindOf in the package says which. */
export const MEDIA_KINDS = ["image", "document", "video", "audio"] as const;
export const MediaKind = z.enum(MEDIA_KINDS);

/** Which way a picture lies (v0.13.0): orientationOf in the package says which. */
export const MEDIA_ORIENTATIONS = ["landscape", "portrait", "square"] as const;
export const MediaOrientation = z.enum(MEDIA_ORIENTATIONS);

/** The fields a site may fill from a file's own embedded metadata (IPTC, EXIF) at upload (v0.13.0). */
export const MEDIA_EMBEDDED_FIELDS = ["credit", "license", "caption", "takenAt"] as const;

export const MediaItem = z.object({
  id: MediaId,
  /** Where the site serves it: a path on the site, such as /media/2026/09/photo.webp, or a full URL. */
  url: MediaAddress,
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
  /** The file's focal point (v0.10.0), on a site that keeps one: null when it has none, and the crop is the site's guess. */
  focus: MediaFocus.nullable().optional(),
  /** The file's caption (v0.10.0), on a site that keeps one: "" when it has none. */
  caption: MediaCaption.optional(),
  // ---------- v0.13.0, each on a site that keeps it
  /** How many places use the file, by the site's own reference check (capabilities.mediaUsage). */
  usedCount: z.number().int().min(0).optional(),
  /** A tiny placeholder picture and the main color, both made at upload. null when the site made none for this file. */
  placeholder: MediaPlaceholder.nullable().optional(),
  color: MediaColor.nullable().optional(),
  /** Who made it, the terms it is used under, and where it came from (capabilities.mediaCredit). */
  credit: MediaCredit.optional(),
  license: MediaLicense.optional(),
  sourceUrl: MediaSourceUrl.nullable().optional(),
  /** The day the license runs out (YYYY-MM-DD); null for a license with no end. */
  licenseExpires: z.iso.date().nullable().optional(),
  /** When the picture was taken, as its embedded metadata says: with an offset where the file names one, local time where not. */
  takenAt: z.iso.datetime({ offset: true, local: true }).nullable().optional(),
  /** Where the original file downloads from, where the site offers it. It may be `url` itself. */
  downloadUrl: MediaAddress.optional(),
});

/** Another file whose bytes are exactly this one's (v0.13.0). */
export const MediaTwin = z.object({ id: MediaId, filename: z.string().max(300).nullable() });

/** One file with the places it is used: what a delete would be refused over. */
export const MediaDetail = MediaItem.extend({
  usedBy: z.array(MediaUse),
  /** Files whose bytes are exactly this one's (v0.13.0, capabilities.mediaDuplicates): [] when there are none. */
  twins: z.array(MediaTwin).max(50).optional(),
});

/**
 * What a media list can be sorted by (v0.6.0). added runs newest first, size largest first and name A to Z, unless `dir`
 * says otherwise. used (v0.13.0, capabilities.mediaUsage) runs most used first.
 */
export const MEDIA_SORTS = ["added", "name", "size", "used"] as const;

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
  /** v0.13.0, on a site with capabilities.mediaFilters; any other site answers 501. A file with no size has no orientation. */
  orientation: MediaOrientation.optional(),
  kind: MediaKind.optional(),
  /**
   * v0.13.0, on a site with capabilities.mediaChanges: the `changeCursor` of an earlier answer. The list then answers every
   * file changed since, trash included, and `removed`, and takes no other filter but `limit`.
   */
  changedSince: z.string().min(1).max(500).optional(),
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
  /** v0.13.0, on a site with capabilities.mediaChanges: the point to poll from next, as `changedSince`. */
  changeCursor: z.string().min(1).max(500).optional(),
  /** On a `changedSince` answer only: the ids deleted for good since. */
  removed: z.array(MediaId).optional(),
  /** On a `changedSince` answer only: true when more changes wait than one answer holds; poll again at once from `changeCursor`. */
  moreChanges: z.boolean().optional(),
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
  /** "no" keeps this file at its own size on a site that shrinks large pictures at upload (v0.13.0, capabilities.mediaResize). */
  resize: z.enum(["no"]).optional(),
});

/**
 * The answer to an upload or an import (v0.13.0; before it, a MediaItem): the file, and what the site did with it. The
 * extra properties are each absent where they do not apply.
 */
export const MediaUploadResult = MediaItem.extend({
  /** The id of the file already holding these exact bytes (capabilities.mediaDuplicates): the answer is that file, and nothing new was stored. */
  duplicateOf: MediaId.optional(),
  /** The fields the site filled from the file's own embedded metadata (capabilities.mediaEmbedded). */
  embedded: z.array(z.enum(MEDIA_EMBEDDED_FIELDS)).optional(),
  /** The picture's size before the site shrank it (capabilities.mediaResize). */
  resizedFrom: z.object({ width: z.number().int().min(1), height: z.number().int().min(1), bytes: z.number().int().min(0) }).optional(),
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

// ---------- focal point, caption and replace (v0.10.0)

/** Sets or clears (null) the point a file's crops are cut around. */
export const MediaFocusInput = z.object({
  focus: MediaFocus.nullable(),
  expectedVersion: Version,
  changeId: ChangeId,
});

export const MediaCaptionInput = z.object({
  caption: MediaCaption,
  expectedVersion: Version,
  changeId: ChangeId,
});

/**
 * A replace is the new bytes as the body, their type as Content-Type (the file's own type: the address names it), and
 * these as the query, like an upload.
 */
export const MediaReplaceQuery = MediaUploadQuery.pick({ filename: true, changeId: true }).extend({
  expectedVersion: Version,
});

/**
 * The file after a replace: the same id and address, its alt, caption and tags kept, its focal point cleared (it named a
 * place in the old picture), and a new version.
 */
export const MediaReplaceResult = MediaItem.extend({
  changeId: ChangeId,
  /**
   * True when the site's cache may still serve sizes made from the old bytes, so they need purging (or wait out their
   * cache lifetime). False when none can be stale: the site's image route keys its cache by the file's etag
   * (site-runtime ./image 0.27.0 and later) or the site purged them in the write. Either way, a browser that already
   * holds the old file under a long cache lifetime keeps it until that runs out.
   */
  sizesNeedPurge: z.boolean(),
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

// ---------- the media library's ideas (v0.13.0), each optional per site

/** What a site does to large pictures at upload: the longest edge it keeps, and the quality it encodes them at. */
export const MediaResize = z.object({
  maxEdge: z.number().int().min(256).max(16384),
  quality: z.number().int().min(1).max(100),
});

/** Fetch a file from the web into the site's own storage. The site serves its own copy, never the source. */
export const MediaImportInput = z.object({
  url: z.url({ protocol: /^https$/ }).max(2000),
  /** The name to keep; the last segment of the address when left out. */
  // oxlint-disable-next-line no-control-regex
  filename: z.string().min(1).max(200).regex(/^[^/\\\u0000-\u001f]+$/, "A file name, with no path").optional(),
  alt: z.string().max(2000).default(""),
  resize: z.enum(["no"]).optional(),
  changeId: ChangeId,
});

/** The file's credit, license, source and license end, as one write: each is the whole value after it. */
export const MediaCreditInput = z.object({
  credit: MediaCredit,
  license: MediaLicense,
  sourceUrl: MediaSourceUrl.nullable(),
  licenseExpires: z.iso.date().nullable(),
  expectedVersion: Version,
  changeId: ChangeId,
});

export const MEDIA_TRANSFORMS = ["rotate-90", "rotate-180", "rotate-270", "flip-h", "flip-v"] as const;
export const MediaTransformOp = z.enum(MEDIA_TRANSFORMS);

/** A quarter turn clockwise (rotate-90), a half turn, three quarters, or a mirror left to right (flip-h) or top to bottom. */
export const MediaTransformInput = z.object({
  op: MediaTransformOp,
  expectedVersion: Version,
  changeId: ChangeId,
});

/**
 * The file after a transform or a revert. In place (`asNewFile: false`): the same id and address, alt, caption, tags and
 * credit kept, the old bytes kept in the file's history. As a new file (`asNewFile: true`, a quarter turn of a picture
 * that is not square on a site whose addresses carry the size): a new file, and the old one as it was.
 */
export const MediaTransformResult = MediaItem.extend({
  changeId: ChangeId,
  sizesNeedPurge: z.boolean(),
  asNewFile: z.boolean(),
});

/** One earlier (or the current) set of a file's bytes. */
export const MediaRevision = z.object({
  /** The site's id for these bytes, which a revert names as `to`. */
  rev: z.string().min(1).max(200),
  at: Timestamp,
  bytes: z.number().int().min(0),
  width: z.number().int().min(1).nullable(),
  height: z.number().int().min(1).nullable(),
  /** What made these bytes. */
  reason: z.enum(["upload", "import", "replace", "transform", "resize", "revert"]),
  /** True for the bytes the file has now: exactly one revision is current. */
  current: z.boolean(),
});

/** A file's byte history, newest first, at most 100. */
export const MediaHistory = z.object({
  id: MediaId,
  revisions: z
    .array(MediaRevision)
    .max(100)
    .refine((r) => r.filter((x) => x.current).length === 1, "Exactly one revision is current"),
});

export const MediaRevertInput = z.object({
  to: z.string().min(1).max(200),
  expectedVersion: Version,
  changeId: ChangeId,
});

/** The most files one resize pass request shrinks: image work is slow, so the caller sends the rest in further requests. */
export const MAX_RESIZE_PASS = 20;

/** Shrink stored pictures to the site's `mediaResize`, each file with the version the caller saw and its own change id. */
export const MediaResizePassInput = z.object({
  items: z
    .array(z.object({ id: MediaId, expectedVersion: Version, changeId: ChangeId }))
    .min(1)
    .max(MAX_RESIZE_PASS),
});

export const MediaResizeOutcome = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    id: MediaId,
    changeId: ChangeId,
    /** False when the picture was already within the size: nothing changed and the version did not move. */
    resized: z.boolean(),
    version: Version.optional(),
    width: z.number().int().min(1).nullable(),
    height: z.number().int().min(1).nullable(),
    bytes: z.number().int().min(0),
  }),
  z.object({
    ok: z.literal(false),
    id: MediaId,
    changeId: ChangeId,
    error: z.enum(["not-found", "version-conflict", "refused", "invalid", "internal"]),
    message: z.string(),
    currentVersion: Version.nullable().optional(),
  }),
]);

export const MediaResizePassResult = z.object({
  results: z.array(MediaResizeOutcome),
});

/** What the site's model suggests for a file. The site never applies it: a person accepts or dismisses each. */
export const MediaSuggestions = z.object({
  id: MediaId,
  tags: MediaTags,
  alt: z.string().max(2000).nullable(),
  /** The model that made them, as the site names it. */
  model: z.string().min(1).max(200),
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
export type MediaFocusInput = z.infer<typeof MediaFocusInput>;
export type MediaCaptionInput = z.infer<typeof MediaCaptionInput>;
export type MediaReplaceQuery = z.infer<typeof MediaReplaceQuery>;
export type MediaReplaceResult = z.infer<typeof MediaReplaceResult>;
export type MediaBulkItem = z.infer<typeof MediaBulkItem>;
export type MediaBulkInput = z.infer<typeof MediaBulkInput>;
export type MediaBulkOutcome = z.infer<typeof MediaBulkOutcome>;
export type MediaBulkResult = z.infer<typeof MediaBulkResult>;
export type MediaTrashEmptyInput = z.infer<typeof MediaTrashEmptyInput>;
export type MediaTrashEmptyResult = z.infer<typeof MediaTrashEmptyResult>;
export type MediaKind = z.infer<typeof MediaKind>;
export type MediaOrientation = z.infer<typeof MediaOrientation>;
export type MediaEmbeddedField = (typeof MEDIA_EMBEDDED_FIELDS)[number];
export type MediaTwin = z.infer<typeof MediaTwin>;
export type MediaUploadResult = z.infer<typeof MediaUploadResult>;
export type MediaResize = z.infer<typeof MediaResize>;
export type MediaImportInput = z.infer<typeof MediaImportInput>;
export type MediaCreditInput = z.infer<typeof MediaCreditInput>;
export type MediaTransformOp = z.infer<typeof MediaTransformOp>;
export type MediaTransformInput = z.infer<typeof MediaTransformInput>;
export type MediaTransformResult = z.infer<typeof MediaTransformResult>;
export type MediaRevision = z.infer<typeof MediaRevision>;
export type MediaHistory = z.infer<typeof MediaHistory>;
export type MediaRevertInput = z.infer<typeof MediaRevertInput>;
export type MediaResizePassInput = z.infer<typeof MediaResizePassInput>;
export type MediaResizeOutcome = z.infer<typeof MediaResizeOutcome>;
export type MediaResizePassResult = z.infer<typeof MediaResizePassResult>;
export type MediaSuggestions = z.infer<typeof MediaSuggestions>;
