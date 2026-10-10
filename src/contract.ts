// The contract between Carrel and a site: every request and response body, as zod schemas.
//
// A site and Carrel agree when their schema hashes match. The hash covers these schemas and the
// route table, so any change to either is a new contract, and Carrel's health check sees it.

import { z } from "zod";

export const PACKAGE_VERSION = "0.5.0";
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

/** A post tag (v0.6.0): one short piece of text, trimmed, with nothing that would break a frontmatter list. */
export const ContentTag = z.string().min(1).max(40).regex(/^[^\s,[\]"'#:\\](?:[^\r\n,[\]"'#:\\]*[^\s,[\]"'#:\\])?$/);

/** A post's whole tag set (v0.6.0). */
export const ContentTags = z.array(ContentTag).max(50);

/** What a list can be sorted by (v0.6.0). updated and published run newest first unless `dir` says otherwise; title runs A to Z. */
export const CONTENT_SORTS = ["updated", "published", "title"] as const;
export const SortDir = z.enum(["asc", "desc"]);

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

/**
 * The ready-made views of a library (v0.6.0), each optional per site: files nothing uses (by the
 * site's own reference check), files with no alt text, and files larger than LARGE_MEDIA_BYTES.
 */
export const MEDIA_LENSES = ["unattached", "no-alt", "large"] as const;
export const MediaLens = z.enum(MEDIA_LENSES);
export const LARGE_MEDIA_BYTES = 1024 * 1024;

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
  /** True when the site keeps tags on posts and writes them through `PUT /content/:id/tags` (v0.6.0). Absent or false: that route answers 501. */
  contentTags: z.boolean().optional(),
  /** The media lenses the site answers (v0.6.0); with any of them it also sorts the media list. Absent: a lens answers 501. */
  mediaLenses: z.array(MediaLens).optional(),
  /** True when the site receives webmentions and lets Carrel moderate them (v0.5.0). Absent or false: every mentions route answers 501. */
  mentions: z.boolean().optional(),
  /** True when a decision can be taken back to pending (v0.6.0), the `reset` decision. Absent or false: a reset answers 501. */
  mentionReset: z.boolean().optional(),
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
  /** The item's version (v0.6.0), so a row's action needs no read first. Optional: a v0.5.0 site leaves it out. */
  version: Version.optional(),
  /** The item's tags (v0.6.0), on a site that keeps them. */
  tags: ContentTags.optional(),
});

export const ContentDoc = ContentSummary.extend({
  format: z.literal("markdown"),
  source: Source,
  version: Version,
});

export const ListQuery = z.object({
  status: ContentStatus.optional(),
  q: z.string().max(200).optional(),
  /** v0.6.0. A site that sorts says so in the answer's `sorted`; one that does not leaves its own order. */
  sort: z.enum(CONTENT_SORTS).optional(),
  dir: SortDir.optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const ContentList = z.object({
  items: z.array(ContentSummary),
  nextCursor: z.string().nullable(),
  /** How many items match the query across every page (v0.6.0), where the site can count them. */
  total: z.number().int().min(0).optional(),
  /** The order the site applied (v0.6.0). Absent: the site did not sort as asked, so a caller sorts the page itself. */
  sorted: z.object({ sort: z.enum(CONTENT_SORTS), dir: SortDir }).optional(),
});

/** A post's whole tag set after the write (v0.6.0, optional per site). */
export const ContentTagsInput = z.object({
  tags: ContentTags,
  expectedVersion: Version,
  changeId: ChangeId,
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

// ---------- mentions (v0.5.0)

/** A site's id for one received mention, as text: a row id such as 41. Never a path. */
export const MentionId = ContentId;

/**
 * Where a mention is in the site's moderation queue. unverified: received, the sender's page not yet
 * fetched. pending: the link is really there, awaiting a decision. approved: shown on the post.
 * rejected: kept, so a re-sender does not reappear as new. failed: verification found no link.
 */
export const MentionStatus = z.enum(["unverified", "pending", "approved", "rejected", "failed"]);

export const MentionItem = z.object({
  id: MentionId,
  status: MentionStatus,
  /** The page the sender says links to us. Text from a stranger: never a link. */
  sourceUrl: z.string().min(1).max(2000),
  /** The content id the mention targets, such as a post slug. */
  targetId: z.string().min(1).max(300),
  authorName: z.string().max(500).nullable(),
  authorUrl: z.string().max(2000).nullable(),
  excerpt: z.string().max(5000).nullable(),
  /** Why verification failed, in the site's fixed words; null unless failed. */
  failureReason: z.string().max(500).nullable(),
  receivedAt: Timestamp,
  verifiedAt: Timestamp.nullable(),
  decidedAt: Timestamp.nullable(),
  /** Opaque, like a content version: it must move whenever the status, the verification or the decision does. */
  version: Version,
});

export const MentionListQuery = z.object({
  status: MentionStatus.optional(),
  /** v0.6.0: words in the source address, the author or the excerpt. */
  q: z.string().max(200).optional(),
  /** v0.6.0: only the mentions of this content id, such as a post slug. */
  targetId: z.string().min(1).max(300).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** How many mentions the site holds in each status. */
export const MentionCounts = z.object({
  unverified: z.number().int().min(0),
  pending: z.number().int().min(0),
  approved: z.number().int().min(0),
  rejected: z.number().int().min(0),
  failed: z.number().int().min(0),
});

export const MentionList = z.object({
  items: z.array(MentionItem),
  nextCursor: z.string().nullable(),
  /** Across the whole queue, not the page, so a filter can show its count. */
  counts: MentionCounts,
  /** What a sweep would remove now, by status (the site's retention windows). */
  expiring: z.object({ failed: z.number().int().min(0), rejected: z.number().int().min(0) }),
  /** The filters of v0.6.0 the site applied, echoed. Absent: the site did not filter by q or targetId. */
  filtered: z.object({ q: z.string().max(200).optional(), targetId: z.string().max(300).optional() }).optional(),
});

/** `reset` (v0.6.0, optional per site) takes an approved or rejected mention back to pending, so a decision can be undone. */
export const MENTION_DECISIONS = ["approve", "reject", "reset"] as const;

export const MentionDecideInput = z.object({
  decision: z.enum(MENTION_DECISIONS),
  expectedVersion: Version,
  changeId: ChangeId,
});

export const MentionWriteResult = z.object({
  id: MentionId,
  status: MentionStatus,
  /** The mention's version after the write. */
  version: Version,
  changeId: ChangeId,
  /** Whether the site purged the target's cached page: false when the purge failed, null when there was none to run. */
  purged: z.boolean().nullable(),
});

export const MentionDeleteQuery = z.object({
  expectedVersion: Version,
  changeId: ChangeId,
});

export const MentionDeleteResult = z.object({
  id: MentionId,
  deleted: z.literal(true),
  changeId: ChangeId,
  purged: z.boolean().nullable(),
});

/** Sweeping removes the mentions past the site's retention windows: failed and rejected ones. It names no version, since it is not about one mention. */
export const MentionSweepInput = z.object({
  changeId: ChangeId,
});

export const MentionSweepResult = z.object({
  changeId: ChangeId,
  removed: z.object({ failed: z.number().int().min(0), rejected: z.number().int().min(0) }),
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
export type ContentTagsInput = z.infer<typeof ContentTagsInput>;
export type ContentSort = (typeof CONTENT_SORTS)[number];
export type SortDir = z.infer<typeof SortDir>;
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
export type MentionStatus = z.infer<typeof MentionStatus>;
export type MentionItem = z.infer<typeof MentionItem>;
export type MentionListQuery = z.infer<typeof MentionListQuery>;
export type MentionCounts = z.infer<typeof MentionCounts>;
export type MentionList = z.infer<typeof MentionList>;
export type MentionDecideInput = z.infer<typeof MentionDecideInput>;
export type MentionWriteResult = z.infer<typeof MentionWriteResult>;
export type MentionDeleteQuery = z.infer<typeof MentionDeleteQuery>;
export type MentionDeleteResult = z.infer<typeof MentionDeleteResult>;
export type MentionSweepInput = z.infer<typeof MentionSweepInput>;
export type MentionSweepResult = z.infer<typeof MentionSweepResult>;
export type ErrorBody = z.infer<typeof ErrorBody>;

/**
 * Every route, relative to PREFIX. Groups declared for later stages answer 501 until a site
 * implements them, so a route's existence is part of the contract even before its body is. The
 * media group arrived in v0.2.0; a site whose adapter has no `media` still answers it 501. v0.3.0
 * adds the source at a revision and an optional content delete (501 when the adapter has none).
 * v0.4.0 adds media writes, each optional per site (501 when the adapter lacks the method): alt
 * text, tags, trash, restore and empty-trash, and one bulk route that applies any of them to many files.
 * v0.5.0 adds the mentions group: list, decide, delete and sweep, answering 501 for a site whose
 * adapter has no `mentions`.
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
  { group: "content", method: "PUT", path: "/content/:id/tags", request: "ContentTagsInput", response: "WriteResult" },
  { group: "preview", method: "POST", path: "/preview", request: "PreviewInput", response: "text/html" },
  { group: "media", method: "GET", path: "/media", query: "MediaListQuery", response: "MediaList" },
  { group: "media", method: "POST", path: "/media", query: "MediaUploadQuery", request: "the file's bytes", response: "MediaItem" },
  { group: "media", method: "GET", path: "/media/:id", response: "MediaDetail" },
  { group: "media", method: "DELETE", path: "/media/:id", query: "MediaDeleteQuery", response: "MediaDeleteResult" },
  { group: "media", method: "PUT", path: "/media/:id/alt", request: "MediaAltInput", response: "MediaWriteResult" },
  { group: "media", method: "PUT", path: "/media/:id/tags", request: "MediaTagsInput", response: "MediaWriteResult" },
  { group: "media", method: "POST", path: "/media/:id/trash", request: "MediaTrashInput", response: "MediaWriteResult" },
  { group: "media", method: "POST", path: "/media/:id/restore", request: "MediaTrashInput", response: "MediaWriteResult" },
  { group: "media", method: "POST", path: "/media/trash/empty", request: "MediaTrashEmptyInput", response: "MediaTrashEmptyResult" },
  { group: "media", method: "POST", path: "/media/bulk", request: "MediaBulkInput", response: "MediaBulkResult" },
  { group: "mentions", method: "GET", path: "/mentions", query: "MentionListQuery", response: "MentionList" },
  { group: "mentions", method: "POST", path: "/mentions/sweep", request: "MentionSweepInput", response: "MentionSweepResult" },
  { group: "mentions", method: "POST", path: "/mentions/:id/decide", request: "MentionDecideInput", response: "MentionWriteResult" },
  { group: "mentions", method: "DELETE", path: "/mentions/:id", query: "MentionDeleteQuery", response: "MentionDeleteResult" },
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
  MediaTrashEmptyInput, MediaTrashEmptyResult,
  MentionItem, MentionListQuery, MentionList, MentionDecideInput, MentionWriteResult, MentionDeleteQuery,
  MentionDeleteResult, MentionSweepInput, MentionSweepResult,
  ContentTagsInput,
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
