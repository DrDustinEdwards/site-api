// The media group's writes: uploads, edits, bulk, trash, transforms, history, resize and suggestions.

import { z } from "zod";
import { Actor, ActorName, ChangeId, Timestamp, Version } from "./base.js";
import {
  MEDIA_EMBEDDED_FIELDS,
  MediaCaption,
  MediaCredit,
  MediaFocus,
  MediaId,
  MediaItem,
  MediaLicense,
  MediaSourceUrl,
  MediaTags,
  MediaUse,
} from "./media.js";

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
 * The answer to an upload or an import (a MediaItem plus the extras): the file, and what the site did with it. The
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

export const MediaDeleteQuery = z.object({
  changeId: ChangeId,
  actorName: ActorName.optional(),
});

export const MediaDeleteResult = z.object({
  id: MediaId,
  deleted: z.literal(true),
  changeId: ChangeId,
});

// ---------- media writes

/** Every media metadata write names the version the caller last saw and Carrel's change id. */
export const MediaAltInput = z.object({
  /** As an upload's, and "" only with `decorative: true`. */
  alt: z.string().max(2000),
  decorative: z.literal(true).optional(),
  expectedVersion: Version,
  changeId: ChangeId,
  actor: Actor.optional(),
});

/** The file's whole tag set after the write. */
export const MediaTagsInput = z.object({
  tags: MediaTags,
  expectedVersion: Version,
  changeId: ChangeId,
  actor: Actor.optional(),
});

/** The body of a trash and of a restore. */
export const MediaTrashInput = z.object({
  expectedVersion: Version,
  changeId: ChangeId,
  actor: Actor.optional(),
});

export const MediaWriteResult = z.object({
  id: MediaId,
  /** The file's version after the write. */
  version: Version,
  changeId: ChangeId,
});

// ---------- focal point, caption and replace

/** Sets or clears (null) the point a file's crops are cut around. */
export const MediaFocusInput = z.object({
  focus: MediaFocus.nullable(),
  expectedVersion: Version,
  changeId: ChangeId,
  actor: Actor.optional(),
});

export const MediaCaptionInput = z.object({
  caption: MediaCaption,
  expectedVersion: Version,
  changeId: ChangeId,
  actor: Actor.optional(),
});

/**
 * A replace is the new bytes as the body, their type as Content-Type (the file's own type: the address names it), and
 * these as the query, like an upload.
 */
export const MediaReplaceQuery = MediaUploadQuery.pick({
  filename: true,
  changeId: true,
  actorName: true,
}).extend({
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
   * (site-runtime ./image) or the site purged them in the write. Either way, a browser that already
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
  actor: Actor.optional(),
});

const MediaFileFailure = z.object({
  ok: z.literal(false),
  id: MediaId,
  changeId: ChangeId,
  error: z.enum(["not-found", "version-conflict", "refused", "invalid", "internal"]),
  message: z.string(),
  /** On version-conflict: what the site holds now. */
  currentVersion: Version.nullable().optional(),
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
  MediaFileFailure.extend({
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
  actor: Actor.optional(),
});

/** The most files one empty-trash request deletes. When more remain, `more` is true and the caller sends it again. */
export const MAX_TRASH_EMPTY = 100;

export const MediaTrashEmptyResult = z.object({
  changeId: ChangeId,
  /** The ids deleted for good. */
  deleted: z.array(MediaId),
  /** Trashed files the site would not delete (still used by a post, for one); they stay in the trash. */
  refused: z.array(
    z.object({ id: MediaId, message: z.string(), usedBy: z.array(MediaUse).optional() }),
  ),
  /** True when the trash held more than one request handles. */
  more: z.boolean(),
});

// ---------- the media library's ideas, each optional per site

/** What a site does to large pictures at upload: the longest edge it keeps, and the quality it encodes them at. */
export const MediaResize = z.object({
  maxEdge: z.number().int().min(256).max(16384),
  quality: z.number().int().min(1).max(100),
});

/** Fetch a file from the web into the site's own storage. The site serves its own copy, never the source. */
export const MediaImportInput = z.object({
  url: z.url({ protocol: /^https$/ }).max(2000),
  /** The name to keep; the last segment of the address when left out. */
  filename: z
    .string()
    .min(1)
    .max(200)
    // oxlint-disable-next-line no-control-regex
    .regex(/^[^/\\\u0000-\u001f]+$/, "A file name, with no path")
    .optional(),
  /** An upload's: optional, and checked when sent. */
  alt: z.string().max(2000).optional(),
  decorative: z.literal(true).optional(),
  resize: z.enum(["no"]).optional(),
  changeId: ChangeId,
  actor: Actor.optional(),
});

/**
 * The file's credit, license, source and license end, as one write: each is the whole value after it. The
 * copyright notice and the two license addresses are each kept as it was where the write leaves it out.
 */
export const MediaCreditInput = z.object({
  credit: MediaCredit,
  license: MediaLicense,
  sourceUrl: MediaSourceUrl.nullable(),
  licenseExpires: z.iso.date().nullable(),
  copyright: MediaCredit.optional(),
  licenseUrl: MediaSourceUrl.nullable().optional(),
  acquireLicenseUrl: MediaSourceUrl.nullable().optional(),
  expectedVersion: Version,
  changeId: ChangeId,
  actor: Actor.optional(),
});

export const MEDIA_TRANSFORMS = [
  "rotate-90",
  "rotate-180",
  "rotate-270",
  "flip-h",
  "flip-v",
] as const;
export const MediaTransformOp = z.enum(MEDIA_TRANSFORMS);

/** A quarter turn clockwise (rotate-90), a half turn, three quarters, or a mirror left to right (flip-h) or top to bottom. */
export const MediaTransformInput = z.object({
  op: MediaTransformOp,
  expectedVersion: Version,
  changeId: ChangeId,
  actor: Actor.optional(),
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
  actor: Actor.optional(),
});

/** The most files one resize pass request shrinks: image work is slow, so the caller sends the rest in further requests. */
export const MAX_RESIZE_PASS = 20;

/** Shrink stored pictures to the site's `mediaResize`, each file with the version the caller saw and its own change id. */
export const MediaResizePassInput = z.object({
  items: z
    .array(z.object({ id: MediaId, expectedVersion: Version, changeId: ChangeId }))
    .min(1)
    .max(MAX_RESIZE_PASS),
  actor: Actor.optional(),
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
  MediaFileFailure,
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
  /**
   * The tokens the suggestion spent, as Anthropic reported them, so a caller that pays for the call (Carrel's monthly
   * cap) counts what was spent. Absent: the site's adapter did not report them.
   */
  usage: z
    .object({
      input: z.number().int().min(0),
      output: z.number().int().min(0),
      cacheRead: z.number().int().min(0),
      cacheWrite: z.number().int().min(0),
    })
    .optional(),
});

/**
 * What the site's model suggests for a file before it is stored (capabilities.mediaUploadSuggestions): the body
 * is the file's bytes, typed by Content-Type, as an upload's; or, for an import, no body and the address as `url`, fetched
 * and checked as an import is. Nothing is stored.
 */
export const MediaFileSuggestQuery = z.object({
  url: MediaImportInput.shape.url.optional(),
});

/** The suggestion an upload form shows in its alt field for the person to keep, change or replace: never stored as it is. */
export const MediaFileSuggestions = MediaSuggestions.omit({ id: true });

export type MediaUploadQuery = z.infer<typeof MediaUploadQuery>;
export type MediaDeleteResult = z.infer<typeof MediaDeleteResult>;
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
export type MediaFileSuggestQuery = z.infer<typeof MediaFileSuggestQuery>;
export type MediaFileSuggestions = z.infer<typeof MediaFileSuggestions>;
