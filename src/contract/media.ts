// The media group.

import { SLUG_PATTERN } from "@drdustinedwards/site-helpers/slug";
import { focusOf } from "@dustinedwards/site-runtime/image";
import { z } from "zod";
import { ActorName, ChangeId, Limit, SortDir, Timestamp, Version } from "./base.js";

/** The largest upload any site may declare: well under a Worker's request body limit. */
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

/**
 * What a site accepts as an upload, declared by the site. `types` are MIME types, such as
 * image/png; the package refuses anything else before the site sees a byte.
 */
export const MediaUploadLimits = z.object({
  maxBytes: z.number().int().min(1).max(MAX_MEDIA_BYTES),
  types: z
    .array(z.string().regex(/^[a-z]+\/[a-z0-9.+-]+$/))
    .min(1)
    .max(50),
});

/**
 * The ready-made views of a library, each optional per site: files nothing uses (by the
 * site's own reference check), files with no alt text, and files larger than LARGE_MEDIA_BYTES, files whose
 * bytes are exactly another file's (by content hash, never a picture's likeness), files whose license has run out
 * (`licenseExpires` before today, in UTC), and pictures with an edge longer than the site's `mediaResize.maxEdge`.
 */
export const MEDIA_LENSES = [
  "unattached",
  "no-alt",
  "large",
  "duplicates",
  "license-expired",
  "oversized",
] as const;
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
  .refine(
    (id) => !id.split("/").some((part) => part === "." || part === ".."),
    "An id segment may not be . or ..",
  );

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
export const MediaTag = z.string().min(1).max(32).regex(SLUG_PATTERN);

/** A file's whole tag set. The most any file carries is 12. */
export const MediaTags = z.array(MediaTag).max(12);

/**
 * A file's focal point: "XxY", each from 0 to 1 from the top left with up to three decimals, such as
 * "0.25x0.4". The site keeps it where site-runtime's ./image reads it for its crops (an R2 object's customMetadata
 * `focus`, FOCUS_METADATA), so the package takes only what that module's `focusOf` takes.
 */
export const MediaFocus = z
  .string()
  .max(20)
  .refine(
    (v) => focusOf(v) !== null,
    'A focal point is "XxY", each from 0 to 1 with up to three decimals',
  );

/** A file's caption: what a figure shows under it, beside its alt text. "" for none. */
export const MediaCaption = z.string().max(2000);

/** Where the site serves a file, or offers it: a path on the site, such as /media/2026/09/photo.webp, or a full https URL. */
const MediaAddress = z
  .string()
  .min(1)
  .max(2000)
  .refine((u) => u.startsWith("/") || u.startsWith("https://"), "A path or an https URL");

/** The longest placeholder a file may carry: a tiny blurred picture, never the picture itself. */
export const MAX_PLACEHOLDER_CHARS = 2048;

/**
 * A file's placeholder: a tiny picture as a base64 data: URI in a raster type, which a page shows while the file
 * loads. No SVG, so a placeholder never carries markup.
 */
export const MediaPlaceholder = z
  .string()
  .max(MAX_PLACEHOLDER_CHARS)
  .regex(
    /^data:image\/(png|jpeg|gif|webp|avif);base64,[A-Za-z0-9+/]+={0,2}$/,
    "A base64 data: URI of a png, jpeg, gif, webp or avif",
  );

/** A file's main color, as #rrggbb in lower case. */
export const MediaColor = z.string().regex(/^#[0-9a-f]{6}$/, "A color as #rrggbb in lower case");

/** Who made a file and the terms it is used under: free text, "" for none. */
export const MediaCredit = z.string().max(300);
export const MediaLicense = z.string().max(300);

/** Where a file came from: the page or file it was taken from, http or https. */
export const MediaSourceUrl = z.url({ protocol: /^https?$/ }).max(2000);

/**
 * The longest alt text a write takes: a description beyond it belongs in the caption or a long description. A
 * file stored before keeps a longer one.
 */
export const MAX_ALT_CHARS = 250;

/** What a file is, from its type: kindOf in the package says which. */
export const MEDIA_KINDS = ["image", "document", "video", "audio"] as const;
export const MediaKind = z.enum(MEDIA_KINDS);

/** Which way a picture lies: orientationOf in the package says which. */
export const MEDIA_ORIENTATIONS = ["landscape", "portrait", "square"] as const;
export const MediaOrientation = z.enum(MEDIA_ORIENTATIONS);

/**
 * The fields a site may fill from a file's own embedded metadata (XMP, IPTC, EXIF) at upload.
 */
export const MEDIA_EMBEDDED_FIELDS = [
  "credit",
  "license",
  "caption",
  "takenAt",
  "copyright",
  "licenseUrl",
  "acquireLicenseUrl",
] as const;

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
   * Opaque, like a content version: it identifies the file's editable metadata, so alt,
   * tags and trash state each move it. Present on a site that offers any media write.
   */
  version: Version.optional(),
  /** The file's tags, present on a site that keeps them. */
  tags: MediaTags.optional(),
  /** When the file was moved to the trash; null or absent when it is in the library. */
  trashedAt: Timestamp.nullable().optional(),
  /** The file's focal point, on a site that keeps one: null when it has none, and the crop is the site's guess. */
  focus: MediaFocus.nullable().optional(),
  /** The file's caption, on a site that keeps one: "" when it has none. */
  caption: MediaCaption.optional(),
  // ---------- each on a site that keeps it
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
  // ---------- each on a site that keeps it
  /**
   * True when the person who placed the file said it is decorative, so its empty alt is a choice and not a gap (the no-alt
   * lens leaves it out). Absent on a file stored before, whose empty alt is a gap.
   */
  decorative: z.boolean().optional(),
  /** The copyright notice, apart from the credit (capabilities.mediaCredit): "" for none. ImageObject's copyrightNotice. */
  copyright: MediaCredit.optional(),
  /** The page that states the license (ImageObject's `license`, XMP's WebStatement); null for none. */
  licenseUrl: MediaSourceUrl.nullable().optional(),
  /** The page where a license can be had (ImageObject's `acquireLicensePage`, PLUS's LicensorURL); null for none. */
  acquireLicenseUrl: MediaSourceUrl.nullable().optional(),
});

/** Another file whose bytes are exactly this one's. */
export const MediaTwin = z.object({ id: MediaId, filename: z.string().max(300).nullable() });

/** One file with the places it is used: what a delete would be refused over. */
export const MediaDetail = MediaItem.extend({
  usedBy: z.array(MediaUse),
  /** Files whose bytes are exactly this one's (capabilities.mediaDuplicates): [] when there are none. */
  twins: z.array(MediaTwin).max(50).optional(),
});

/**
 * What a media list can be sorted by. added runs newest first, size largest first and name A to Z, unless `dir`
 * says otherwise. used (capabilities.mediaUsage) runs most used first.
 */
export const MEDIA_SORTS = ["added", "name", "size", "used"] as const;

export const MediaListQuery = z.object({
  q: z.string().max(200).optional(),
  /** On a site that lists the lens in capabilities.mediaLenses; any other site answers 501. */
  lens: MediaLens.optional(),
  /** A site that sorts says so in the answer's `sorted`. */
  sort: z.enum(MEDIA_SORTS).optional(),
  dir: SortDir.optional(),
  /** Only files carrying this tag. A site without tags ignores it. */
  tag: MediaTag.optional(),
  /** "only" lists the trash. Without it the trash is left out. A site without a trash ignores it. */
  trashed: z.enum(["only"]).optional(),
  /** On a site with capabilities.mediaFilters; any other site answers 501. A file with no size has no orientation. */
  orientation: MediaOrientation.optional(),
  kind: MediaKind.optional(),
  /**
   * On a site with capabilities.mediaChanges: the `changeCursor` of an earlier answer. The list then answers every
   * file changed since, trash included, and `removed`, and takes no other filter but `limit`.
   */
  changedSince: z.string().min(1).max(500).optional(),
  cursor: z.string().max(500).optional(),
  limit: Limit,
});

export const MediaList = z.object({
  items: z.array(MediaItem),
  nextCursor: z.string().nullable(),
  /** How many files match across every page, where the site can count them. */
  total: z.number().int().min(0).optional(),
  /** The order the site applied. Absent: the site did not sort as asked. */
  sorted: z.object({ sort: z.enum(MEDIA_SORTS), dir: SortDir }).optional(),
  /** On a site with capabilities.mediaChanges: the point to poll from next, as `changedSince`. */
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
  filename: z
    .string()
    .min(1)
    .max(200)
    // oxlint-disable-next-line no-control-regex
    .regex(/^[^/\\\u0000-\u001f]+$/, "A file name, with no path"),
  /**
   * What the picture shows (optional; with none the picture is stored with no alt and an alt is written afterward, and the site refuses it where it is placed on a page). Sent, it is checked: what the picture shows, at most MAX_ALT_CHARS, never its file name, a bare
   * "image" or an address.
   */
  alt: z.string().max(2000).optional(),
  /** "yes" says the picture is decorative, so it is stored with alt "" on purpose. Not with an alt. */
  decorative: z.enum(["yes"]).optional(),
  changeId: ChangeId,
  /** "no" keeps this file at its own size on a site that shrinks large pictures at upload (capabilities.mediaResize). */
  resize: z.enum(["no"]).optional(),
  actorName: ActorName.optional(),
});

/**
 * The answer to an upload or an import (a MediaItem with the extras below): the file, and what the site did with it. The
 * extra properties are each absent where they do not apply.
 */
export const MediaUploadResult = MediaItem.extend({
  /** The id of the file already holding these exact bytes (capabilities.mediaDuplicates): the answer is that file, and nothing new was stored. */
  duplicateOf: MediaId.optional(),
  /** The fields the site filled from the file's own embedded metadata (capabilities.mediaEmbedded). */
  embedded: z.array(z.enum(MEDIA_EMBEDDED_FIELDS)).optional(),
  /** The picture's size before the site shrank it (capabilities.mediaResize). */
  resizedFrom: z
    .object({
      width: z.number().int().min(1),
      height: z.number().int().min(1),
      bytes: z.number().int().min(0),
    })
    .optional(),
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
export type MediaTags = z.infer<typeof MediaTags>;
export type MediaKind = z.infer<typeof MediaKind>;
export type MediaOrientation = z.infer<typeof MediaOrientation>;
export type MediaEmbeddedField = (typeof MEDIA_EMBEDDED_FIELDS)[number];
export type MediaTwin = z.infer<typeof MediaTwin>;
export type MediaUploadResult = z.infer<typeof MediaUploadResult>;
