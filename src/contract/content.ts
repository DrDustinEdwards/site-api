// The content group: list, read, write, revisions, diff, delete, tags and the preview.

import { z } from "zod";
import { ChangeId, ContentId, Source, SortDir, Timestamp, Version } from "./base.js";

export const ContentStatus = z.enum(["draft", "scheduled", "published"]);

/** A post tag (v0.6.0): one short piece of text, trimmed, with nothing that would break a frontmatter list. */
export const ContentTag = z.string().min(1).max(40).regex(/^[^\s,[\]"'#:\\](?:[^\r\n,[\]"'#:\\]*[^\s,[\]"'#:\\])?$/);

/** A post's whole tag set (v0.6.0). */
export const ContentTags = z.array(ContentTag).max(50);

/** What a list can be sorted by (v0.6.0). updated and published run newest first unless `dir` says otherwise; title runs A to Z. */
export const CONTENT_SORTS = ["updated", "published", "title"] as const;

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

export type ContentStatus = z.infer<typeof ContentStatus>;
export type ContentSummary = z.infer<typeof ContentSummary>;
export type ContentDoc = z.infer<typeof ContentDoc>;
export type ListQuery = z.infer<typeof ListQuery>;
export type ContentList = z.infer<typeof ContentList>;
export type ContentTagsInput = z.infer<typeof ContentTagsInput>;
export type ContentSort = (typeof CONTENT_SORTS)[number];
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
