// What each site implements. The package owns the route, the key, the rate limit and the shape of
// every body; the adapter owns the site's storage, its rules and its render.

import type {
  Actor,
  Backlink,
  ContentDoc,
  ContentFilter,
  ContentList,
  ListQuery,
  PostField,
  PreviewInput,
  PublishInput,
  RenameInput,
  RenameResult,
  Revision,
  SaveDraftInput,
  ScheduleInput,
  SearchField,
  SiteInfo,
  TranscriptInput,
  UnpublishInput,
  WriteResult,
} from "./contract.js";
import { type MediaAdapter } from "./adapter/media.js";
import {
  type InsightAdapter,
  type MentionsAdapter,
  type SchedulesAdapter,
} from "./adapter/groups.js";

export interface ContentAdapter {
  /**
   * Optional: true when `publish` takes `publishedAt` and publishes under that date, a first publish backdated
   * or a live item re-dated (capabilities.contentPublishedAt). Absent: a publish carrying it answers 501.
   */
  publishedAtSettable?: boolean;
  /**
   * Optional: true when items carry `hasDraft` (live, with a saved draft not yet published) and `list` treats
   * such an item as published, a `status: "draft"` filter matching it too (capabilities.contentHasDraft).
   */
  hasDraft?: boolean;
  /**
   * Optional: the search and post fields the site renders from a post's frontmatter (capabilities.searchFields,
   * capabilities.postFields), each under its shared name in `@dustinedwards/site-api/frontmatter`. Absent: none.
   */
  searchFields?: readonly SearchField[];
  /**
   * Optional: the list filters `list` applies (capabilities.contentFilters): `kind`, `tag`, `author` (one of
   * the item's authors), `published` (publishedAfter and publishedBefore, either or both). The package answers any other
   * with 501. `trashed` is offered with the trash, not here.
   */
  filters?: readonly Exclude<ContentFilter, "trashed">[];
  postFields?: readonly PostField[];
  list(query: ListQuery): Promise<ContentList>;
  /** null when the id does not exist. */
  get(id: string): Promise<ContentDoc | null>;
  /**
   * Creates when expectedVersion is null and the id is free. Throws VersionConflictError when
   * expectedVersion is not what the site holds, including a non-null version for a missing id.
   */
  saveDraft(id: string, input: SaveDraftInput): Promise<WriteResult>;
  /** A first publish from Carrel's key is allowed: Carrel decides who triggers it. */
  publish(id: string, input: PublishInput): Promise<WriteResult>;
  schedule(id: string, input: ScheduleInput): Promise<WriteResult>;
  /** Unpublish returns the item to draft. A delete is the separate, optional `delete` below. */
  unpublish(id: string, input: UnpublishInput): Promise<WriteResult>;
  /** Newest first. null when the id does not exist. */
  revisions(id: string): Promise<Revision[] | null>;
  /** The source as it was at a version; null when the id or the version does not exist. */
  revisionSource(id: string, version: string): Promise<string | null>;
  /**
   * Optional: deletes the item. Throws VersionConflictError when expectedVersion is not
   * what the site holds, NotFoundError for a missing id, and RefusedError when the site's own rules
   * refuse. A site without it answers `DELETE /content/:id` with 501. The write and whatever the
   * site must do afterward (its cache purge, say) are one unit, so the site runs them together here.
   */
  delete?(
    id: string,
    input: { expectedVersion: string; changeId: string; actor?: Actor },
  ): Promise<void>;
  /**
   * Optional: sets the item's whole tag set, already unique, and returns the write like a
   * save does. Throws VersionConflictError, NotFoundError (checked first, for a missing id) or
   * RefusedError like the writes. A site without it answers `PUT /content/:id/tags` with 501.
   */
  setTags?(
    id: string,
    input: { tags: string[]; expectedVersion: string; changeId: string; actor?: Actor },
  ): Promise<WriteResult>;
  /**
   * Optional: moves the item to `newId`, its history with it, and, when it was ever published, keeps a permanent
   * (301) redirect from its old path to the new one; answers that old path as `previousPath` (null when never published).
   * Throws NotFoundError (checked first), VersionConflictError, or RefusedError for a `newId` already taken. The move and
   * the redirect are one unit. A site without it answers `POST /content/:id/rename` with 501.
   */
  rename?(id: string, input: RenameInput): Promise<RenameResult>;
  /**
   * Optional, both or neither, and only beside `delete` (capabilities.contentTrash): `trash` sets `trashedAt`
   * and takes a live item off the site first, as one unit; `restore` clears it and always answers a draft, never a live
   * item. Each throws like the writes. `list` then never lists a trashed item unless `trashed` is true, and then only
   * those. The package's `runSchedules` deletes items trashed more than TRASH_DAYS ago, through `delete`.
   */
  trash?(
    id: string,
    input: { expectedVersion: string; changeId: string; actor?: Actor },
  ): Promise<WriteResult>;
  restore?(
    id: string,
    input: { expectedVersion: string; changeId: string; actor?: Actor },
  ): Promise<WriteResult>;
  /**
   * Optional (capabilities.backlinks): every other post that links to this one, so a delete or a trash warns with
   * the list first. The package checks the id exists before it asks. Absent: `GET /content/:id/backlinks` answers 501.
   */
  backlinks?(id: string): Promise<Backlink[]>;
  /**
   * Optional (capabilities.contentTranscript): replaces the item's transcript, live at once, keeping the one it
   * replaces in the site's own history. Throws NotFoundError (checked first), VersionConflictError with the
   * transcriptVersion the site holds (null when it has none) when `expectedTranscriptVersion` is not it, or RefusedError
   * when the site's rules refuse (a kind that has no transcript). The item's `version` stays as it was; `get` then
   * answers the new text as `transcript`. The package has checked the text is WebVTT. Answers the item's version.
   */
  setTranscript?(id: string, input: TranscriptInput): Promise<{ version: string }>;
}

export interface PreviewAdapter {
  /** The full page HTML, from the site's own route and pipeline, exactly as it would publish. */
  render(input: PreviewInput): Promise<string>;
}

export interface SiteAdapter {
  site: SiteInfo;
  /** Optional: the Prelum `RENDER_VERSION` the site's stored HTML was rendered with (capabilities.render). */
  renderVersion?: string;
  content: ContentAdapter;
  preview: PreviewAdapter;
  /** Absent on a site with no media manager: the media routes then answer 501. */
  media?: MediaAdapter;
  /** Absent on a site that does not receive webmentions: the mentions routes then answer 501. */
  mentions?: MentionsAdapter;
  /**
   * Absent on a site with no scheduled updates: reading and canceling a schedule answer 501, and a schedule on
   * a live item is refused, since the site's own schedule would take it off the site until the time.
   */
  schedules?: SchedulesAdapter;
  /** Absent on a site that reports nothing about its pages: the insight routes then answer 501. */
  insight?: InsightAdapter;
}

export * from "./adapter/media.js";
export * from "./adapter/groups.js";
export * from "./adapter/helpers.js";
export * from "./adapter/errors.js";
