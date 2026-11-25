// What each site implements. The package owns the route, the key, the rate limit and the shape of
// every body; the adapter owns the site's storage, its rules and its render.

import { sha256Hex } from "@dustinedwards/site-runtime/encoding";
import { CONTENT_FILTERS, PREVIEW_LINK_MAX_HOURS } from "./contract.js";
import type { MediaAdapter } from "./adapter/media.js";
import type {
  Actor,
  Backlink,
  Capabilities,
  ContentDoc,
  ContentFilter,
  ContentSort,
  ContentList,
  ListQuery,
  MediaUse,
  MentionList,
  MentionListQuery,
  MentionStatus,
  PostField,
  NotFoundRow,
  PreviewInput,
  PublishInput,
  RenameInput,
  RenameResult,
  Revision,
  SaveDraftInput,
  ScheduleInput,
  ScheduledUpdate,
  SearchField,
  SiteInfo,
  TranscriptInput,
  UnpublishInput,
  WriteResult,
} from "./contract.js";

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
  /** A first publish from Carrel's key is allowed (design decision 2): Carrel decides who triggers it. */
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

/**
 * The mentions group, optional per site. Every write throws VersionConflictError when
 * expectedVersion is not what the site holds, NotFoundError for a missing id and RefusedError when
 * the site's own rules refuse. The write and the cache purge it needs are one unit, run together in
 * the method, and the method reports whether the purge worked.
 */
export interface MentionsAdapter {
  /** Newest first. `counts` and `expiring` cover the whole queue, not the page. */
  list(query: MentionListQuery): Promise<MentionList>;
  /** Approve or reject. Refuse (RefusedError) a mention that is not yet verified or that failed verification. */
  decide(
    id: string,
    input: { decision: "approve" | "reject"; expectedVersion: string; changeId: string },
  ): Promise<{ status: MentionStatus; version: string; purged: boolean | null }>;
  /**
   * Optional: takes an approved or rejected mention back to pending, as it was before the
   * decision, so a decision can be undone. Refuse (RefusedError) any other status. Absent: a reset answers 501.
   */
  reset?(
    id: string,
    input: { expectedVersion: string; changeId: string },
  ): Promise<{ status: MentionStatus; version: string; purged: boolean | null }>;
  /** Removes the only copy of what a stranger sent. */
  delete(
    id: string,
    input: { expectedVersion: string; changeId: string },
  ): Promise<{ purged: boolean | null }>;
  /** Removes failed and rejected mentions past the site's retention windows, and reports how many. */
  sweep(input: { changeId: string }): Promise<{ failed: number; rejected: number }>;
}

/** One schedule whose time has come: a scheduled item to publish, or a live item's update to apply. */
export interface DueSchedule {
  id: string;
  /** publish: a scheduled item that was not live goes live. update: a live item's scheduled update replaces it. */
  kind: "publish" | "update";
  publishAt: string;
  /** The change that made the schedule; the publish is recorded under it. */
  changeId: string;
}

/**
 * Scheduled updates, optional per site: a live item carries one waiting update with its own source and time.
 * The live version stays served until then, and at that time the update replaces it. The site stores the update beside
 * the live item (D1 sites: `d1ScheduledUpdates` from `@dustinedwards/site-api/schedules`). With this group, the site's
 * cron calls `api.runSchedules()`, which publishes scheduled items as well, and the publish hooks run for each.
 *
 * Every write here moves the item's version, since the update is part of what the item is, and throws
 * VersionConflictError, NotFoundError or RefusedError like the content writes. Elsewhere in the adapter: a publish or an
 * unpublish of the item drops its waiting update, as does a delete; a save or a tag change to the live item leaves it
 * waiting, and the update's own source replaces the live one when it runs.
 */
export interface SchedulesAdapter {
  /** The update waiting on a live item, with its source; null when the id does not exist or nothing waits. */
  get(id: string): Promise<ScheduledUpdate | null>;
  /**
   * Stores the update on a live item, replacing any update already waiting (a reschedule). The item stays live and
   * unchanged. Refuse (RefusedError) an item that is not live: the package sends only live items here.
   */
  update(
    id: string,
    input: {
      source: string;
      publishAt: string;
      expectedVersion: string;
      changeId: string;
      actor?: Actor;
    },
  ): Promise<WriteResult>;
  /**
   * Cancels the schedule. A live item drops its waiting update and stays live; a scheduled item that was never live
   * returns to draft. Throws NotFoundError for a missing id (checked first), and RefusedError for an item with nothing
   * scheduled.
   */
  cancel(
    id: string,
    input: { expectedVersion: string; changeId: string; actor?: Actor },
  ): Promise<WriteResult>;
  /** Every schedule due at `now`, scheduled items and live items' updates alike, oldest first, at most `limit`. */
  due(input: { now: Date; limit: number }): Promise<DueSchedule[]>;
  /**
   * Runs one due schedule as one unit: publishes the scheduled item, or puts the update's source live and drops the
   * update. Only when what the site holds still matches (the same kind, time and change id, and the time has come);
   * otherwise it changes nothing and returns null, since a cancel, a reschedule or an unpublish got there first. A
   * scheduled item's first publication records `publishAt` as its `publishedAt`, not the time the cron ran.
   *
   * A site whose scheduled item goes live by time alone, with no write (its pages compare `publishAt` with the
   * clock), still lists it in `due` as kind "publish", and `apply` answers its WriteResult without writing anything, so
   * the publish hooks hear it go live. Once applied it must leave `due`, or the hooks would hear it on every pass.
   */
  apply(id: string, input: DueSchedule & { now: Date }): Promise<WriteResult | null>;
}

/** What a 404 report is asked for: site-runtime's `notFoundReport` options, checked and filled in. */
export interface NotFoundOptions {
  days: number;
  limit: number;
  includeProbes: boolean;
}

/** The insight group, optional per site: what the site counted about its own pages. Read only. */
export interface InsightAdapter {
  /**
   * The most-hit missing paths of the last `days` UTC days, at most `limit`, probes only with `includeProbes`. A site
   * that counts its 404s with site-runtime's `./not-found` answers `(options) => notFoundReport(env.DB, options)`.
   */
  notFound(options: NotFoundOptions): Promise<NotFoundRow[]>;
}

export interface SiteAdapter {
  site: SiteInfo;
  /** Optional: the Prelum `RENDER_VERSION` the site's stored HTML was rendered with (capabilities.render). */
  renderVersion?: string;
  content: ContentAdapter;
  preview: PreviewAdapter;
  /** Absent on a site with no media manager: the media routes then answer 501,. */
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

/**
 * What the site's adapter offers, for the capabilities answer. A group the adapter lacks answers 501.
 * `store`: the site gave createSiteApi a store.
 */
export function capabilitiesOf(
  adapter: SiteAdapter,
  options: { store?: boolean; hooks?: readonly string[] } = {},
): Capabilities {
  return {
    content: true,
    preview: true,
    media: Boolean(adapter.media),
    inbox: false,
    insight: Boolean(adapter.insight),
    publications: false,
    ...(adapter.media ? { mediaUpload: adapter.media.limits } : {}),
    ...(adapter.content.delete ? { contentDelete: true } : {}),
    ...(adapter.content.setTags ? { contentTags: true } : {}),
    ...(adapter.content.publishedAtSettable ? { contentPublishedAt: true } : {}),
    ...(adapter.content.hasDraft ? { contentHasDraft: true } : {}),
    ...(adapter.content.rename ? { contentRename: true } : {}),
    ...(hasContentTrash(adapter) ? { contentTrash: true } : {}),
    ...(contentFiltersOf(adapter).length ? { contentFilters: contentFiltersOf(adapter) } : {}),
    ...(adapter.content.searchFields?.length
      ? { searchFields: [...adapter.content.searchFields] }
      : {}),
    ...(adapter.content.postFields?.length ? { postFields: [...adapter.content.postFields] } : {}),
    ...(adapter.media?.setAlt ? { mediaAlt: true } : {}),
    ...(adapter.media?.lenses?.length ? { mediaLenses: [...adapter.media.lenses] } : {}),
    ...(adapter.media?.setTags ? { mediaTags: true } : {}),
    ...(adapter.media?.trash && adapter.media.restore ? { mediaTrash: true } : {}),
    ...(adapter.media?.setFocus ? { mediaFocus: true } : {}),
    ...(adapter.media?.setCaption ? { mediaCaption: true } : {}),
    ...(adapter.media?.replace ? { mediaReplace: true } : {}),
    ...(adapter.media?.replace && adapter.media.replaceKeepsSize
      ? { mediaReplaceKeepsSize: true }
      : {}),
    ...(adapter.media?.findByHash ? { mediaDuplicates: true } : {}),
    ...(adapter.media?.usage ? { mediaUsage: true } : {}),
    ...(adapter.media?.filters ? { mediaFilters: true } : {}),
    ...(adapter.media?.importFetch ? { mediaImport: true } : {}),
    ...(adapter.media?.setCredit ? { mediaCredit: true } : {}),
    ...(adapter.media?.transform ? { mediaTransform: true } : {}),
    ...(adapter.media?.history && adapter.media.revert ? { mediaHistory: true } : {}),
    ...(adapter.media?.changes ? { mediaChanges: true } : {}),
    ...(adapter.media?.resize ? { mediaResize: { ...adapter.media.resize } } : {}),
    ...(adapter.media?.resize && adapter.media.shrink ? { mediaResizePass: true } : {}),
    ...(adapter.media?.readsEmbedded ? { mediaEmbedded: true } : {}),
    ...(adapter.media?.suggest ? { mediaSuggestions: true } : {}),
    ...(adapter.media?.suggestFile ? { mediaUploadSuggestions: true } : {}),
    ...(adapter.mentions ? { mentions: true } : {}),
    ...(adapter.mentions?.reset ? { mentionReset: true } : {}),
    ...(adapter.schedules ? { scheduledUpdates: true } : {}),
    ...(options.store
      ? { replay: true, previewLinks: true, previewLinkHours: { max: PREVIEW_LINK_MAX_HOURS } }
      : {}),
    ...(options.store && options.hooks?.length ? { hooks: [...options.hooks] } : {}),
    ...(adapter.content.backlinks ? { backlinks: true } : {}),
    ...(adapter.content.setTranscript ? { contentTranscript: true } : {}),
    ...(adapter.renderVersion ? { render: { version: adapter.renderVersion } } : {}),
    ...(adapter.insight ? { insightNotFound: true } : {}),
  };
}

/** Trash and restore, and the delete that empties the trash. */
export function hasContentTrash(adapter: SiteAdapter): boolean {
  const { content } = adapter;
  return (
    content.trash !== undefined && content.restore !== undefined && content.delete !== undefined
  );
}

/** The list filters the site applies, in the contract's order. */
export function contentFiltersOf(adapter: SiteAdapter): ContentFilter[] {
  const offered = new Set<ContentFilter>(adapter.content.filters ?? []);
  if (hasContentTrash(adapter)) offered.add("trashed");
  return CONTENT_FILTERS.filter((f) => offered.has(f));
}

/**
 * A content version made from the fields that identify an item's own content: the first 32 hex
 * characters of the SHA-256 of their JSON. For a site with no version column; pass the same fields,
 * in the same order, on every read and write.
 */
export async function contentVersion(parts: readonly unknown[]): Promise<string> {
  return (await sha256Hex(JSON.stringify(parts))).slice(0, 32);
}

/**
 * A transcript's version: contentVersion of its text, so the site and Carrel name the same one without a
 * column. The package puts it on every read that carries a transcript; an adapter checks a transcript write against it.
 */
export function transcriptVersion(transcript: string): Promise<string> {
  return contentVersion(["transcript", transcript]);
}

/**
 * The page of a content list a site holds in memory: `rows` ordered as the contract's `sort` and `dir` ask (dates
 * newest first, titles A to Z, unless `dir` says otherwise), cut at `cursor` for `limit` rows. `keys` reads each sort's
 * value from a row. The answer carries what `ContentList` needs beside the items: `total`, `nextCursor` and `sorted`.
 */
export function orderAndPage<T>(
  rows: readonly T[],
  query: Pick<ListQuery, "sort" | "dir" | "cursor" | "limit">,
  keys: Record<ContentSort, (row: T) => string | number>,
): {
  page: T[];
  total: number;
  nextCursor: string | null;
  sorted: { sort: ContentSort; dir: "asc" | "desc" };
} {
  const sort = query.sort ?? "updated";
  const dir = query.dir ?? (sort === "title" ? "asc" : "desc");
  const key = keys[sort];
  const ordered = [...rows].sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    return (
      (typeof x === "string" ? x.localeCompare(y as string) : x - (y as number)) *
      (dir === "asc" ? 1 : -1)
    );
  });
  const start = Math.max(0, Number.parseInt(query.cursor ?? "0", 10) || 0);
  const next = start + query.limit;
  return {
    page: ordered.slice(start, next),
    total: ordered.length,
    nextCursor: next < ordered.length ? String(next) : null,
    sorted: { sort, dir },
  };
}

/** The expectedVersion on a write is not what the site holds. currentVersion null: no such id. */
export class VersionConflictError extends Error {
  constructor(
    readonly currentVersion: string | null,
    message = "The content changed since it was loaded.",
  ) {
    super(message);
    this.name = "VersionConflictError";
  }
}

export class NotFoundError extends Error {
  constructor(message = "No such content.") {
    super(message);
    this.name = "NotFoundError";
  }
}

/** The site's reference check found the file in use: the delete is refused, naming every use. */
export class MediaInUseError extends Error {
  constructor(
    readonly usedBy: MediaUse[],
    message?: string,
  ) {
    super(message ?? `The file is in use: ${describeUses(usedBy)}. Remove it from each first.`);
    this.name = "MediaInUseError";
  }
}

/** "Title (detail); Other (detail)", one entry per use, for the refusal a writer reads. */
export function describeUses(uses: MediaUse[]): string {
  return uses.map((u) => `${u.title || u.id} (${u.detail})`).join("; ");
}

/** The site's own rules refused the write, such as a render failure or a policy. Shown to the writer. */
export class RefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefusedError";
  }
}

export type { MediaAdapter, MediaReplace, MediaUpload, MediaUploaded } from "./adapter/media.js";
