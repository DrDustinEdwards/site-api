// The content group: list, read, write, scheduled updates, revisions, diff, delete, tags and the preview.

import { z } from "zod";
import { ChangeId, ContentId, Source, SortDir, Timestamp, Version } from "./base.js";

export const ContentStatus = z.enum(["draft", "scheduled", "published"]);

/** A post tag (v0.6.0): one short piece of text, trimmed, with nothing that would break a frontmatter list. */
export const ContentTag = z.string().min(1).max(40).regex(/^[^\s,[\]"'#:\\](?:[^\r\n,[\]"'#:\\]*[^\s,[\]"'#:\\])?$/);

/** A display name credited on a post (v0.15.0), as its `authors` post field holds it. */
export const AuthorName = z.string().min(1).max(200);

/** A post's whole tag set (v0.6.0). */
export const ContentTags = z.array(ContentTag).max(50);

/** What a list can be sorted by (v0.6.0). updated and published run newest first unless `dir` says otherwise; title runs A to Z. */
export const CONTENT_SORTS = ["updated", "published", "title"] as const;

/**
 * The update waiting on a live item (v0.10.0): its own source replaces the live one at `publishAt`. Until then the
 * live version is the one served. `changeId` is the change that scheduled it, and the one its publish is recorded under.
 */
export const ScheduledUpdateSummary = z.object({
  publishAt: Timestamp,
  changeId: ChangeId,
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
  /** On a live item, the update scheduled to replace it (v0.10.0); null when none. Absent: the site has no scheduled updates. */
  scheduledUpdate: ScheduledUpdateSummary.nullable().optional(),
  /** v0.15.0, from the post fields where the site keeps them, for a list: everyone credited, the primary first, and the excerpt. */
  authors: z.array(AuthorName).max(50).optional(),
  excerpt: z.string().max(5000).optional(),
  /** When the item went to the trash (v0.15.0), null when it is not there. Absent: the site has no content trash. */
  trashedAt: Timestamp.nullable().optional(),
});

export const ContentDoc = ContentSummary.extend({
  format: z.literal("markdown"),
  source: Source,
  version: Version,
});

/** The list filters a site may offer (v0.15.0), named in capabilities.contentFilters; `published` is the pair of dates. */
export const CONTENT_FILTERS = ["kind", "tag", "author", "published", "trashed"] as const;

export const ListQuery = z.object({
  status: ContentStatus.optional(),
  /** Matches the title and the body. Without `sort`, the newest updated come first. */
  q: z.string().max(200).optional(),
  /** v0.15.0 filters, each answering 501 on a site that does not name it in capabilities.contentFilters. */
  kind: z.string().min(1).max(64).optional(),
  tag: ContentTag.optional(),
  author: AuthorName.optional(),
  publishedAfter: Timestamp.optional(),
  publishedBefore: Timestamp.optional(),
  /** v0.6.0. A site that sorts says so in the answer's `sorted`; one that does not leaves its own order. */
  sort: z.enum(CONTENT_SORTS).optional(),
  dir: SortDir.optional(),
  /** v0.15.0, where `contentTrash`: true lists only the trash. Absent or false: trashed items are never listed. */
  trashed: z.stringbool().optional(),
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
  /**
   * The v0.15.0 filters the site applied. A v0.14.0 site drops a filter it does not know and lists everything, so the
   * client refuses an answer that leaves out one it asked for, rather than show live posts as the trash.
   */
  filtered: z.array(z.enum(CONTENT_FILTERS)).optional(),
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

const PublishFields = z.object({
  expectedVersion: Version,
  changeId: ChangeId,
  source: Source.optional(),
});

/**
 * source, when sent, is saved and published in one write. publishedAt (v0.15.0, where `contentPublishedAt`) is the
 * date the item is published under: a backdate, or a new date for a live item. Never in the future: that is a schedule.
 */
export const PublishInput = PublishFields.extend({
  publishedAt: Timestamp.optional(),
});

export const ScheduleInput = PublishFields.extend({
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
  /** The update still waiting on the item after the write (v0.10.0), null when none, on a site with scheduled updates. */
  scheduledUpdate: ScheduledUpdateSummary.nullable().optional(),
});

/** Trashing or restoring an item (v0.15.0, optional per site). */
export const ContentTrashInput = z.object({
  expectedVersion: Version,
  changeId: ChangeId,
});

/**
 * Moving an item to a new id (v0.15.0, optional per site). Its old public path, where it was ever published, keeps a
 * permanent redirect to the new one.
 */
export const RenameInput = z.object({
  newId: ContentId,
  expectedVersion: Version,
  changeId: ChangeId,
});

/** The write under the new id, and the path that now redirects to it (null for an item never published). */
export const RenameResult = WriteResult.extend({
  previousPath: z.string().startsWith("/").nullable(),
});

/** The update waiting on a live item, with its source (v0.10.0): `GET /content/:id/schedule`. */
export const ScheduledUpdate = ScheduledUpdateSummary.extend({
  id: ContentId,
  source: Source,
  /** When it was scheduled. */
  scheduledAt: Timestamp,
});

/**
 * Canceling a schedule (v0.10.0), sent as a query since a DELETE carries no body. On a live item it drops the waiting
 * update and the live version stays; on a scheduled item that was never live it returns the item to draft.
 */
export const ScheduleCancelQuery = z.object({
  expectedVersion: Version,
  changeId: ChangeId,
});

export const Revision = z.object({
  version: Version,
  at: Timestamp,
  author: z.string().max(200),
  message: z.string().max(2000),
  /** Everyone credited for this version (v0.15.0), where the site keeps more than the one `author`. */
  authors: z.array(AuthorName).max(50).optional(),
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

/** A shareable preview link for one item (v0.15.0, where `previewLinks`): it lives `hours`, 48 by default, at most a week. */
export const PreviewLinkInput = z.object({
  id: ContentId,
  hours: z.number().int().min(1).max(168).default(48),
  changeId: ChangeId,
});

/** The link's whole token, answered once: the site keeps only its hash. `url` is the page anyone with it can open. */
export const PreviewLink = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  url: z.url(),
  expiresAt: Timestamp,
});

export const PreviewLinkListQuery = z.object({ id: ContentId });

/** An item's working links, the newest first. `id` is the first 12 hex characters of the token's hash: it revokes the link, and cannot open it. */
export const PreviewLinkList = z.object({
  items: z.array(z.object({ id: z.string().regex(/^[0-9a-f]{12}$/), createdAt: Timestamp, expiresAt: Timestamp })),
});

export const PreviewLinkRevokeQuery = z.object({ changeId: ChangeId });

export const PreviewLinkRevokeResult = z.object({
  id: z.string().regex(/^[0-9a-f]{12}$/),
  revoked: z.literal(true),
  changeId: ChangeId,
});

export type PreviewLinkInput = z.input<typeof PreviewLinkInput>;
export type PreviewLink = z.infer<typeof PreviewLink>;
export type PreviewLinkList = z.infer<typeof PreviewLinkList>;
export type ContentStatus = z.infer<typeof ContentStatus>;
export type ContentSummary = z.infer<typeof ContentSummary>;
export type ContentDoc = z.infer<typeof ContentDoc>;
export type ListQuery = z.infer<typeof ListQuery>;
export type ContentList = z.infer<typeof ContentList>;
export type ContentTagsInput = z.infer<typeof ContentTagsInput>;
export type ContentSort = (typeof CONTENT_SORTS)[number];
export type ContentFilter = (typeof CONTENT_FILTERS)[number];

/** The v0.15.0 filters a list query asks for. */
export function filtersAsked(query: Partial<z.infer<typeof ListQuery>>): ContentFilter[] {
  const asked: Record<ContentFilter, boolean> = {
    kind: query.kind !== undefined,
    tag: query.tag !== undefined,
    author: query.author !== undefined,
    published: query.publishedAfter !== undefined || query.publishedBefore !== undefined,
    trashed: query.trashed === true,
  };
  return CONTENT_FILTERS.filter((f) => asked[f]);
}
export type SaveDraftInput = z.infer<typeof SaveDraftInput>;
export type PublishInput = z.infer<typeof PublishInput>;
export type ScheduleInput = z.infer<typeof ScheduleInput>;
export type UnpublishInput = z.infer<typeof UnpublishInput>;
export type WriteResult = z.infer<typeof WriteResult>;
export type RenameInput = z.infer<typeof RenameInput>;
export type ContentTrashInput = z.infer<typeof ContentTrashInput>;
export type RenameResult = z.infer<typeof RenameResult>;
export type ScheduledUpdateSummary = z.infer<typeof ScheduledUpdateSummary>;
export type ScheduledUpdate = z.infer<typeof ScheduledUpdate>;
export type ScheduleCancelQuery = z.infer<typeof ScheduleCancelQuery>;
export type Revision = z.infer<typeof Revision>;
export type RevisionList = z.infer<typeof RevisionList>;
export type Diff = z.infer<typeof Diff>;
export type RevisionSource = z.infer<typeof RevisionSource>;
export type ContentDeleteQuery = z.infer<typeof ContentDeleteQuery>;
export type ContentDeleteResult = z.infer<typeof ContentDeleteResult>;
export type PreviewInput = z.infer<typeof PreviewInput>;
