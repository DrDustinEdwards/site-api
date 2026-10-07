// The contract between Carrel and a site: every request and response body, as zod schemas.
//
// A site and Carrel agree when their schema hashes match. The hash covers these schemas and the
// route table, so any change to either is a new contract, and Carrel's health check sees it.

import { z } from "zod";

export const PACKAGE_VERSION = "0.4.0";
export const PREFIX = "/api/carrel/v1";

/** Opaque to Carrel: each site decides what a version is. It should identify the item's own content (dustinedwards.info uses the git blob sha of the item's own file). */
export const Version = z.string().min(1).max(200);

/** Carrel's id for one change, carried into the site's commit or row so the two records join. */
export const ChangeId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

/** A site's id for one piece of content: a slug, or a row id. Never a path. */
export const ContentId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);

const Timestamp = z.iso.datetime({ offset: true });

/** Two million characters: far above any article, far below a Worker's memory. */
const Source = z.string().max(2_000_000);

export const ContentStatus = z.enum(["draft", "scheduled", "published"]);

export const SiteInfo = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,64}$/),
  name: z.string().min(1).max(200),
  origin: z.url(),
});

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

export const Capabilities = z.object({
  content: z.boolean(),
  preview: z.boolean(),
  media: z.boolean(),
  inbox: z.boolean(),
  insight: z.boolean(),
  publications: z.boolean(),
  /** Present when `media` is true (v0.2.0). Optional, so a v0.1.0 reader parses a v0.2.0 meta. */
  mediaUpload: MediaUploadLimits.optional(),
  /** True when the site can delete content (v0.3.0). Absent or false: `DELETE /content/:id` answers 501. */
  contentDelete: z.boolean().optional(),
  /** True when the site can edit a file's alt text after upload (v0.4.0). Absent or false: the alt route answers 501. */
  mediaAlt: z.boolean().optional(),
  /** True when the site keeps tags on files (v0.4.0). Absent or false: the tags route answers 501. */
  mediaTags: z.boolean().optional(),
  /** True when the site has a media trash: soft delete and restore (v0.4.0). Absent or false: those routes answer 501. */
  mediaTrash: z.boolean().optional(),
});

export const Meta = z.object({
  api: z.literal("carrel-site-api"),
  packageVersion: z.string(),
  schemaHash: z.string().regex(/^[0-9a-f]{64}$/),
  site: SiteInfo,
  capabilities: Capabilities,
});

export const ContentSummary = z.object({
  id: ContentId,
  kind: z.string().min(1).max(64),
  title: z.string().max(1000),
  status: ContentStatus,
  /** The public path once published, such as /blog/some-post; null while never published. */
  path: z.string().startsWith("/").nullable(),
  publishAt: Timestamp.nullable(),
  publishedAt: Timestamp.nullable(),
  updatedAt: Timestamp.nullable(),
});

export const ContentDoc = ContentSummary.extend({
  format: z.literal("markdown"),
  source: Source,
  version: Version,
});

export const ListQuery = z.object({
  status: ContentStatus.optional(),
  q: z.string().max(200).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const ContentList = z.object({
  items: z.array(ContentSummary),
  nextCursor: z.string().nullable(),
});

/** expectedVersion null means "this id must not exist yet": the create case. */
export const SaveDraftInput = z.object({
  source: Source,
  expectedVersion: Version.nullable(),
  changeId: ChangeId,
});

/** source, when sent, is saved and published in one write. */
export const PublishInput = z.object({
  expectedVersion: Version,
  changeId: ChangeId,
  source: Source.optional(),
});

export const ScheduleInput = PublishInput.extend({
  publishAt: Timestamp,
});

export const UnpublishInput = z.object({
  expectedVersion: Version,
  changeId: ChangeId,
});

export const WriteResult = z.object({
  id: ContentId,
  version: Version,
  status: ContentStatus,
  changeId: ChangeId,
});

export const Revision = z.object({
  version: Version,
  at: Timestamp,
  author: z.string().max(200),
  message: z.string().max(2000),
});

export const RevisionList = z.object({ items: z.array(Revision) });

/** to defaults to the current version. */
export const DiffQuery = z.object({
  from: Version,
  to: Version.optional(),
});

export const Diff = z.object({
  id: ContentId,
  from: Version,
  to: Version,
  /** A unified diff of the source, from `from` to `to`. */
  patch: z.string(),
});

/** One revision's source, so each revision in the list can be opened (v0.3.0). */
export const RevisionSource = z.object({
  id: ContentId,
  version: Version,
  source: Source,
});

/**
 * Deleting an item (v0.3.0, optional per site). Sent as a query, since a DELETE carries no body:
 * the version the caller last saw, and Carrel's change id.
 */
export const ContentDeleteQuery = z.object({
  expectedVersion: Version,
  changeId: ChangeId,
});

export const ContentDeleteResult = z.object({
  id: ContentId,
  deleted: z.literal(true),
  changeId: ChangeId,
});

/** id, when sent, lets the site render the draft at that item's own route. */
export const PreviewInput = z.object({
  id: ContentId.optional(),
  source: Source,
});

// ---------- media (v0.2.0)

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

export const MediaListQuery = z.object({
  q: z.string().max(200).optional(),
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
});

/**
 * An upload is the file's own bytes as the body, its type as Content-Type, and these as the query:
 * no base64, so a file costs its own size and no more.
 */
export const MediaUploadQuery = z.object({
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

export const ErrorCode = z.enum([
  "unauthorized",
  "rate-limited",
  "not-configured",
  "unavailable",
  "not-found",
  "method-not-allowed",
  "invalid",
  "too-large",
  "version-conflict",
  "refused",
  "not-implemented",
  "internal",
]);

export const ErrorBody = z.object({
  error: ErrorCode,
  message: z.string(),
  /** On version-conflict only: what the site holds now, or null when the id does not exist. */
  currentVersion: Version.nullable().optional(),
  /** On a refused media delete only (v0.2.0): every place the file is used. */
  usedBy: z.array(MediaUse).optional(),
});

export type SiteInfo = z.infer<typeof SiteInfo>;
export type Capabilities = z.infer<typeof Capabilities>;
export type Meta = z.infer<typeof Meta>;
export type ContentStatus = z.infer<typeof ContentStatus>;
export type ContentSummary = z.infer<typeof ContentSummary>;
export type ContentDoc = z.infer<typeof ContentDoc>;
export type ListQuery = z.infer<typeof ListQuery>;
export type ContentList = z.infer<typeof ContentList>;
export type SaveDraftInput = z.infer<typeof SaveDraftInput>;
export type PublishInput = z.infer<typeof PublishInput>;
export type ScheduleInput = z.infer<typeof ScheduleInput>;
export type UnpublishInput = z.infer<typeof UnpublishInput>;
export type WriteResult = z.infer<typeof WriteResult>;
export type Revision = z.infer<typeof Revision>;
export type RevisionList = z.infer<typeof RevisionList>;
export type Diff = z.infer<typeof Diff>;
export type RevisionSource = z.infer<typeof RevisionSource>;
export type ContentDeleteQuery = z.infer<typeof ContentDeleteQuery>;
export type ContentDeleteResult = z.infer<typeof ContentDeleteResult>;
export type PreviewInput = z.infer<typeof PreviewInput>;
export type ErrorCode = z.infer<typeof ErrorCode>;
export type MediaUploadLimits = z.infer<typeof MediaUploadLimits>;
export type MediaUse = z.infer<typeof MediaUse>;
export type MediaItem = z.infer<typeof MediaItem>;
export type MediaDetail = z.infer<typeof MediaDetail>;
export type MediaListQuery = z.infer<typeof MediaListQuery>;
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
export type ErrorBody = z.infer<typeof ErrorBody>;

/**
 * Every route, relative to PREFIX. Groups declared for later stages answer 501 until a site
 * implements them, so a route's existence is part of the contract even before its body is. The
 * media group arrived in v0.2.0; a site whose adapter has no `media` still answers it 501. v0.3.0
 * adds the source at a revision and an optional content delete (501 when the adapter has none).
 * v0.4.0 adds media writes, each optional per site (501 when the adapter lacks the method): alt
 * text, tags, trash and restore, and one bulk route that applies any of them to many files.
 */
export const ROUTES = [
  { group: "meta", method: "GET", path: "/meta", response: "Meta" },
  { group: "content", method: "GET", path: "/content", query: "ListQuery", response: "ContentList" },
  { group: "content", method: "GET", path: "/content/:id", response: "ContentDoc" },
  { group: "content", method: "PUT", path: "/content/:id/draft", request: "SaveDraftInput", response: "WriteResult" },
  { group: "content", method: "POST", path: "/content/:id/publish", request: "PublishInput", response: "WriteResult" },
  { group: "content", method: "POST", path: "/content/:id/schedule", request: "ScheduleInput", response: "WriteResult" },
  { group: "content", method: "POST", path: "/content/:id/unpublish", request: "UnpublishInput", response: "WriteResult" },
  { group: "content", method: "GET", path: "/content/:id/revisions", response: "RevisionList" },
  { group: "content", method: "GET", path: "/content/:id/diff", query: "DiffQuery", response: "Diff" },
  { group: "content", method: "GET", path: "/content/:id/revisions/:version", response: "RevisionSource" },
  { group: "content", method: "DELETE", path: "/content/:id", query: "ContentDeleteQuery", response: "ContentDeleteResult" },
  { group: "preview", method: "POST", path: "/preview", request: "PreviewInput", response: "text/html" },
  { group: "media", method: "GET", path: "/media", query: "MediaListQuery", response: "MediaList" },
  { group: "media", method: "POST", path: "/media", query: "MediaUploadQuery", request: "the file's bytes", response: "MediaItem" },
  { group: "media", method: "GET", path: "/media/:id", response: "MediaDetail" },
  { group: "media", method: "DELETE", path: "/media/:id", query: "MediaDeleteQuery", response: "MediaDeleteResult" },
  { group: "media", method: "PUT", path: "/media/:id/alt", request: "MediaAltInput", response: "MediaWriteResult" },
  { group: "media", method: "PUT", path: "/media/:id/tags", request: "MediaTagsInput", response: "MediaWriteResult" },
  { group: "media", method: "POST", path: "/media/:id/trash", request: "MediaTrashInput", response: "MediaWriteResult" },
  { group: "media", method: "POST", path: "/media/:id/restore", request: "MediaTrashInput", response: "MediaWriteResult" },
  { group: "media", method: "POST", path: "/media/bulk", request: "MediaBulkInput", response: "MediaBulkResult" },
  { group: "inbox", method: "*", path: "/inbox/*", response: "not-implemented" },
  { group: "insight", method: "*", path: "/insight/*", response: "not-implemented" },
  { group: "publications", method: "*", path: "/publications/*", response: "not-implemented" },
] as const;

const HASHED = {
  Meta, ContentSummary, ContentDoc, ListQuery, ContentList, SaveDraftInput, PublishInput,
  ScheduleInput, UnpublishInput, WriteResult, Revision, RevisionList, DiffQuery, Diff,
  PreviewInput, ErrorBody, MediaItem, MediaDetail, MediaListQuery, MediaList, MediaUploadQuery,
  MediaDeleteQuery, MediaDeleteResult, RevisionSource, ContentDeleteQuery, ContentDeleteResult,
  MediaAltInput, MediaTagsInput, MediaTrashInput, MediaWriteResult, MediaBulkInput, MediaBulkResult,
};

/** JSON with sorted keys, so the hash depends on the contract and not on property order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

let cachedHash: Promise<string> | undefined;

/** The SHA-256 of the contract: every schema as JSON Schema, plus the route table. */
export function schemaHash(): Promise<string> {
  cachedHash ??= (async () => {
    const schemas = Object.fromEntries(
      Object.entries(HASHED).map(([name, schema]) => [name, z.toJSONSchema(schema, { io: "input" })]),
    );
    const bytes = new TextEncoder().encode(canonical({ prefix: PREFIX, routes: ROUTES, schemas }));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  })();
  return cachedHash;
}
