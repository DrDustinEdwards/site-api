// The content group: list, read, write, scheduled updates, revisions, diff, delete, tags and the preview.

import { z } from "zod";
import {
  Actor,
  ActorName,
  ChangeId,
  ContentId,
  Source,
  SortDir,
  Timestamp,
  Limit,
  Version,
} from "./base.js";

export const ContentStatus = z.enum(["draft", "scheduled", "published"]);

/** A post tag: one short piece of text, trimmed, with nothing that would break a frontmatter list. */
export const ContentTag = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[^\s,[\]"'#:\\](?:[^\r\n,[\]"'#:\\]*[^\s,[\]"'#:\\])?$/);

/** A display name credited on a post, as its `authors` post field holds it. */
export const AuthorName = z.string().min(1).max(200);

/** A post's whole tag set. */
export const ContentTags = z.array(ContentTag).max(50);

/** What a list can be sorted by. updated and published run newest first unless `dir` says otherwise; title runs A to Z. */
export const CONTENT_SORTS = ["updated", "published", "title"] as const;

/**
 * The update waiting on a live item: its own source replaces the live one at `publishAt`. Until then the
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
  /** The item's version, so a row's action needs no read first. Optional: a site may leave it out. */
  version: Version.optional(),
  /** The item's tags, on a site that keeps them. */
  tags: ContentTags.optional(),
  /** On a live item, the update scheduled to replace it; null when none. Absent: the site has no scheduled updates. */
  scheduledUpdate: ScheduledUpdateSummary.nullable().optional(),
  /** From the post fields where the site keeps them, for a list: everyone credited, the primary first, and the excerpt. */
  authors: z.array(AuthorName).max(50).optional(),
  excerpt: z.string().max(5000).optional(),
  /** When the item went to the trash, null when it is not there. Absent: the site has no content trash. */
  trashedAt: Timestamp.nullable().optional(),
  /**
   * Where capabilities.contentHasDraft: true when the item is live and a saved draft waits that is not published
   * yet; false otherwise. Such an item's `status` stays `published`, and a list filtered to `draft` lists it too.
   */
  hasDraft: z.boolean().optional(),
});

export const ContentDoc = ContentSummary.extend({
  format: z.literal("markdown"),
  source: Source,
  version: Version,
  /**
   * The item's transcript, read only, for a session that drafts from it (an episode's summary and chapters).
   * Part of no version and no source: a save never carries it. Absent: the item has none or the site does not offer it.
   */
  transcript: z.string().max(500_000).optional(),
  /**
   * Beside `transcript` on a site with capabilities.contentTranscript: the transcript's own version, which a
   * transcript write names as `expectedTranscriptVersion`. The package sets it (transcriptVersion); the item's `version`
   * does not move when the transcript does, so a draft of the post stays good across a transcript fix.
   */
  transcriptVersion: Version.optional(),
});

/** An episode's transcript as WebVTT: the WEBVTT header, then at least one cue. */
export const TranscriptText = z
  .string()
  .min(1)
  .max(500_000)
  .refine((t) => /^\uFEFF?WEBVTT(?:[ \t][^\n]*)?\r?\n/.test(t), {
    message: "A transcript is WebVTT: it starts with the line WEBVTT.",
  })
  .refine((t) => /\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}(?::\d{2})?\.\d{3}/.test(t), {
    message: "A transcript has at least one cue.",
  });

/**
 * Replacing an item's transcript (capabilities.contentTranscript): `PUT /content/:id/transcript`. The whole
 * WebVTT, and the transcriptVersion it was written from, null when the item has none yet. It is live at once: a
 * transcript has no draft on the site, so Carrel keeps the draft and sends this only when it publishes one.
 */
export const TranscriptInput = z.object({
  transcript: TranscriptText,
  expectedTranscriptVersion: Version.nullable(),
  changeId: ChangeId,
  actor: Actor.optional(),
});

export const TranscriptWriteResult = z.object({
  id: ContentId,
  /** The item's version, unchanged by a transcript write. */
  version: Version,
  transcriptVersion: Version,
  changeId: ChangeId,
});

/** The list filters a site may offer, named in capabilities.contentFilters; `published` is the pair of dates. */
export const CONTENT_FILTERS = ["kind", "tag", "author", "published", "trashed"] as const;

export const ListQuery = z.object({
  status: ContentStatus.optional(),
  /** Matches the title and the body. Without `sort`, the newest updated come first. */
  q: z.string().max(200).optional(),
  /** The newer filters, each answering 501 on a site that does not name it in capabilities.contentFilters. */
  kind: z.string().min(1).max(64).optional(),
  tag: ContentTag.optional(),
  author: AuthorName.optional(),
  publishedAfter: Timestamp.optional(),
  publishedBefore: Timestamp.optional(),
  /** A site that sorts says so in the answer's `sorted`; one that does not leaves its own order. */
  sort: z.enum(CONTENT_SORTS).optional(),
  dir: SortDir.optional(),
  /** Where `contentTrash`: true lists only the trash. Absent or false: trashed items are never listed. */
  trashed: z.stringbool().optional(),
  cursor: z.string().max(500).optional(),
  limit: Limit,
});

export const ContentList = z.object({
  items: z.array(ContentSummary),
  nextCursor: z.string().nullable(),
  /** How many items match the query across every page, where the site can count them. */
  total: z.number().int().min(0).optional(),
  /** The order the site applied. Absent: the site did not sort as asked, so a caller sorts the page itself. */
  sorted: z.object({ sort: z.enum(CONTENT_SORTS), dir: SortDir }).optional(),
  /**
   * The filters the site applied. A site that does not know a filter drops it it does not know and lists everything, so the
   * client refuses an answer that leaves out one it asked for, rather than show live posts as the trash.
   */
  filtered: z.array(z.enum(CONTENT_FILTERS)).optional(),
});

/** A post's whole tag set after the write (optional per site). */
export const ContentTagsInput = z.object({
  tags: ContentTags,
  expectedVersion: Version,
  changeId: ChangeId,
  actor: Actor.optional(),
});

/** expectedVersion null means "this id must not exist yet": the create case. */
export const SaveDraftInput = z.object({
  source: Source,
  expectedVersion: Version.nullable(),
  changeId: ChangeId,
  actor: Actor.optional(),
});

const PublishFields = z.object({
  expectedVersion: Version,
  changeId: ChangeId,
  source: Source.optional(),
  actor: Actor.optional(),
});

/**
 * source, when sent, is saved and published in one write. publishedAt (where `contentPublishedAt`) is the
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
  actor: Actor.optional(),
});

export const WriteResult = z.object({
  id: ContentId,
  version: Version,
  status: ContentStatus,
  changeId: ChangeId,
  /** The update still waiting on the item after the write, null when none, on a site with scheduled updates. */
  scheduledUpdate: ScheduledUpdateSummary.nullable().optional(),
});

/** Trashing or restoring an item (optional per site). */
export const ContentTrashInput = z.object({
  expectedVersion: Version,
  changeId: ChangeId,
  actor: Actor.optional(),
});

/**
 * Moving an item to a new id (optional per site). Its old public path, where it was ever published, keeps a
 * permanent redirect to the new one.
 */
export const RenameInput = z.object({
  newId: ContentId,
  expectedVersion: Version,
  changeId: ChangeId,
  actor: Actor.optional(),
});

/** The write under the new id, and the path that now redirects to it (null for an item never published). */
export const RenameResult = WriteResult.extend({
  previousPath: z.string().startsWith("/").nullable(),
});

/** The update waiting on a live item, with its source: `GET /content/:id/schedule`. */
export const ScheduledUpdate = ScheduledUpdateSummary.extend({
  id: ContentId,
  source: Source,
  /** When it was scheduled. */
  scheduledAt: Timestamp,
});

/**
 * Canceling a schedule, sent as a query since a DELETE carries no body. On a live item it drops the waiting
 * update and the live version stays; on a scheduled item that was never live it returns the item to draft.
 */
export const ScheduleCancelQuery = z.object({
  expectedVersion: Version,
  changeId: ChangeId,
  actorName: ActorName.optional(),
});

export const Revision = z.object({
  version: Version,
  at: Timestamp,
  author: z.string().max(200),
  message: z.string().max(2000),
  /** Everyone credited for this version, where the site keeps more than the one `author`. */
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

/** One revision's source, so each revision in the list can be opened. */
export const RevisionSource = z.object({
  id: ContentId,
  version: Version,
  source: Source,
});

/**
 * Deleting an item (optional per site). Sent as a query, since a DELETE carries no body:
 * the version the caller last saw, and Carrel's change id.
 */
export const ContentDeleteQuery = z.object({
  expectedVersion: Version,
  changeId: ChangeId,
  actorName: ActorName.optional(),
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

/** The longest a preview link lives, in hours: 30 days. */
export const PREVIEW_LINK_MAX_HOURS = 720;
/** How long a preview link lives when the request does not say, in hours. */
export const PREVIEW_LINK_DEFAULT_HOURS = 48;

/**
 * A shareable preview link for one item (where `previewLinks`). It lives `expiresInHours`, 1 to 720,
 * 48 by default (capabilities.previewLinkHours says the most). `hours` is the older name, at most a week; send one.
 */
export const PreviewLinkInput = z.object({
  id: ContentId,
  expiresInHours: z.number().int().min(1).max(PREVIEW_LINK_MAX_HOURS).optional(),
  /** @deprecated Send `expiresInHours`. */
  hours: z.number().int().min(1).max(168).optional(),
  changeId: ChangeId,
  actor: Actor.optional(),
});

/** The link's whole token, answered once: the site keeps only its hash. `url` is the page anyone with it can open. */
export const PreviewLink = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  url: z.url(),
  expiresAt: Timestamp,
});

export const PreviewLinkListQuery = z.object({ id: ContentId });

/** A post that links to another (where `backlinks`): its id, title and public path (null or absent while not live). */
export const Backlink = z.object({
  id: ContentId,
  title: z.string().max(1000),
  path: z.string().startsWith("/").nullable().optional(),
});

/** `GET /content/:id/backlinks`: every post that links to this one, so a delete or a trash can warn first. */
export const BacklinkList = z.object({ items: z.array(Backlink).max(1000) });

/** `GET /hooks/recent?changeId=` (with a store): the publish hooks that ran for one change. */
export const HookRunsQuery = z.object({ changeId: ChangeId });

/** One hook run as the store keeps it (`hook_runs`): the hook's name, whether it worked, and when. */
export const HookRun = z.object({
  hook: z.string().min(1).max(200),
  ok: z.boolean(),
  at: Timestamp,
});

export const HookRunList = z.object({ items: z.array(HookRun) });

/** An item's working links, the newest first. `id` is the first 12 hex characters of the token's hash: it revokes the link, and cannot open it. */
export const PreviewLinkList = z.object({
  items: z.array(
    z.object({
      id: z.string().regex(/^[0-9a-f]{12}$/),
      createdAt: Timestamp,
      expiresAt: Timestamp,
    }),
  ),
});

export const PreviewLinkRevokeQuery = z.object({
  changeId: ChangeId,
  actorName: ActorName.optional(),
});

export const PreviewLinkRevokeResult = z.object({
  id: z.string().regex(/^[0-9a-f]{12}$/),
  revoked: z.literal(true),
  changeId: ChangeId,
});

export type PreviewLinkInput = z.input<typeof PreviewLinkInput>;
export type PreviewLink = z.infer<typeof PreviewLink>;
export type PreviewLinkList = z.infer<typeof PreviewLinkList>;
export type Backlink = z.infer<typeof Backlink>;
export type BacklinkList = z.infer<typeof BacklinkList>;
export type HookRun = z.infer<typeof HookRun>;
export type HookRunList = z.infer<typeof HookRunList>;
export type ContentStatus = z.infer<typeof ContentStatus>;
export type ContentSummary = z.infer<typeof ContentSummary>;
export type ContentDoc = z.infer<typeof ContentDoc>;
export type ListQuery = z.infer<typeof ListQuery>;
export type ContentList = z.infer<typeof ContentList>;
export type ContentTagsInput = z.infer<typeof ContentTagsInput>;
export type TranscriptInput = z.infer<typeof TranscriptInput>;
export type TranscriptWriteResult = z.infer<typeof TranscriptWriteResult>;
export type ContentSort = (typeof CONTENT_SORTS)[number];
export type ContentFilter = (typeof CONTENT_FILTERS)[number];

/** The filters a list query asks for. */
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
