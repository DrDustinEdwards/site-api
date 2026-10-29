// What each site implements. The package owns the route, the key, the rate limit and the shape of
// every body; the adapter owns the site's storage, its rules and its render.

import type {
  Capabilities,
  ContentDoc,
  ContentList,
  ListQuery,
  MediaDetail,
  MediaItem,
  MediaList,
  MediaLens,
  MediaListQuery,
  MediaUploadLimits,
  MediaUse,
  MentionList,
  MentionListQuery,
  MentionStatus,
  PreviewInput,
  PublishInput,
  Revision,
  SaveDraftInput,
  ScheduleInput,
  ScheduledUpdate,
  SiteInfo,
  UnpublishInput,
  WriteResult,
} from "./contract.js";

export interface ContentAdapter {
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
   * Optional (v0.3.0): deletes the item. Throws VersionConflictError when expectedVersion is not
   * what the site holds, NotFoundError for a missing id, and RefusedError when the site's own rules
   * refuse. A site without it answers `DELETE /content/:id` with 501. The write and whatever the
   * site must do afterward (its cache purge, say) are one unit, so the site runs them together here.
   */
  delete?(id: string, input: { expectedVersion: string; changeId: string }): Promise<void>;
  /**
   * Optional (v0.6.0): sets the item's whole tag set, already unique, and returns the write like a
   * save does. Throws VersionConflictError, NotFoundError (checked first, for a missing id) or
   * RefusedError like the writes. A site without it answers `PUT /content/:id/tags` with 501.
   */
  setTags?(id: string, input: { tags: string[]; expectedVersion: string; changeId: string }): Promise<WriteResult>;
}

export interface PreviewAdapter {
  /** The full page HTML, from the site's own route and pipeline, exactly as it would publish. */
  render(input: PreviewInput): Promise<string>;
}

/** One upload, already checked by the package against the site's own limits and the file's bytes. */
export interface MediaUpload {
  bytes: Uint8Array;
  /** One of the site's declared types, without parameters. */
  contentType: string;
  filename: string;
  alt: string;
  changeId: string;
}

/**
 * The media group (v0.2.0). Files stay in the site's own storage and are served by the site; Carrel
 * only lists, uploads and asks for deletes. The site's reference check decides every delete.
 */
export interface MediaAdapter {
  /** What the site accepts. The package refuses any other type, and anything larger, unread. */
  limits: MediaUploadLimits;
  /**
   * Optional (v0.6.0): the lenses `list` answers. A site that names any also sorts by `sort` and `dir`
   * and says so in the answer's `sorted`. The package answers a lens not named here with 501.
   */
  lenses?: readonly MediaLens[];
  /**
   * Optional (v0.11.0): true when `replace` refuses new bytes whose picture is not the old one's size (RefusedError),
   * because the site's addresses or pages are sized by it. The package says so in capabilities.mediaReplaceKeepsSize.
   */
  replaceKeepsSize?: boolean;
  list(query: MediaListQuery): Promise<MediaList>;
  /** The file and every place it is used. null when the id does not exist. */
  get(id: string): Promise<MediaDetail | null>;
  upload(input: MediaUpload): Promise<MediaItem>;
  /**
   * Deletes the file. Throws MediaInUseError naming each use when the site's reference check finds
   * one, NotFoundError for a missing id, and RefusedError when the check could not run: a delete the
   * site could not check is never made.
   */
  delete(id: string, input: { changeId: string }): Promise<void>;
  /**
   * Optional (v0.4.0), each answering 501 when absent. Every one throws VersionConflictError when
   * expectedVersion is not what the site holds, NotFoundError for a missing id and RefusedError when
   * the site's own rules refuse, and returns the file's version after the write. A file's version
   * identifies its editable metadata, so each write here moves it. The write and whatever must
   * follow it (a cache purge) are one unit, run together in the method.
   */
  setAlt?(id: string, input: { alt: string; expectedVersion: string; changeId: string }): Promise<{ version: string }>;
  /** `tags` is the whole set after the write, already in the contract's spelling. */
  setTags?(id: string, input: { tags: string[]; expectedVersion: string; changeId: string }): Promise<{ version: string }>;
  /** Soft delete: hides the file from list and removes nothing. Both trash and restore, or neither. */
  trash?(id: string, input: { expectedVersion: string; changeId: string }): Promise<{ version: string }>;
  restore?(id: string, input: { expectedVersion: string; changeId: string }): Promise<{ version: string }>;
  /**
   * Optional (v0.10.0), each answering 501 when absent, and each throwing and moving the version like the writes above.
   * `focus` is already in the form site-runtime's ./image writes (`focusOf`), or null to clear it; a site on R2 keeps it
   * as the object's customMetadata `focus` (FOCUS_METADATA), which `writeFocus` from `@dustinedwards/site-api/r2` does.
   * Every item the site answers then carries `focus`.
   */
  setFocus?(id: string, input: { focus: string | null; expectedVersion: string; changeId: string }): Promise<{ version: string }>;
  /** Every item the site answers then carries `caption` ("" for none). */
  setCaption?(id: string, input: { caption: string; expectedVersion: string; changeId: string }): Promise<{ version: string }>;
  /**
   * Optional (v0.10.0): replaces the file's bytes under the same id and address, so every page that uses it shows the
   * new one. The package has already checked the bytes against the site's limits, that the file exists, that its version
   * is `expectedVersion`, that it is `deletable` (the site's own static assets are never replaced) and that `contentType`
   * is the file's own type. The site keeps alt, caption and tags, clears the focal point (it named a place in the old
   * picture), measures the new picture, moves the version, and answers the item. `sizesNeedPurge` says whether its cache
   * may still serve sizes made from the old bytes: false when its image route keys the cache by the object's etag
   * (site-runtime ./image 0.27.0 and later), or when it purged them as part of the write. On R2, `replaceObject` from
   * `@dustinedwards/site-api/r2` writes the bytes and keeps the object's metadata.
   */
  replace?(id: string, input: MediaReplace): Promise<{ item: MediaItem; sizesNeedPurge: boolean }>;
}

/** One replace (v0.10.0), already checked by the package. */
export interface MediaReplace {
  bytes: Uint8Array;
  /** The file's own type, without parameters. */
  contentType: string;
  /** The name the new file was sent with. */
  filename: string;
  expectedVersion: string;
  changeId: string;
}

/**
 * The mentions group (v0.5.0), optional per site. Every write throws VersionConflictError when
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
   * Optional (v0.6.0): takes an approved or rejected mention back to pending, as it was before the
   * decision, so a decision can be undone. Refuse (RefusedError) any other status. Absent: a reset answers 501.
   */
  reset?(
    id: string,
    input: { expectedVersion: string; changeId: string },
  ): Promise<{ status: MentionStatus; version: string; purged: boolean | null }>;
  /** Removes the only copy of what a stranger sent. */
  delete(id: string, input: { expectedVersion: string; changeId: string }): Promise<{ purged: boolean | null }>;
  /** Removes failed and rejected mentions past the site's retention windows, and reports how many. */
  sweep(input: { changeId: string }): Promise<{ failed: number; rejected: number }>;
}

/** One schedule whose time has come (v0.10.0): a scheduled item to publish, or a live item's update to apply. */
export interface DueSchedule {
  id: string;
  /** publish: a scheduled item that was not live goes live. update: a live item's scheduled update replaces it. */
  kind: "publish" | "update";
  publishAt: string;
  /** The change that made the schedule; the publish is recorded under it. */
  changeId: string;
}

/**
 * Scheduled updates (v0.10.0), optional per site: a live item carries one waiting update with its own source and time.
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
  update(id: string, input: { source: string; publishAt: string; expectedVersion: string; changeId: string }): Promise<WriteResult>;
  /**
   * Cancels the schedule. A live item drops its waiting update and stays live; a scheduled item that was never live
   * returns to draft. Throws NotFoundError for a missing id (checked first), and RefusedError for an item with nothing
   * scheduled.
   */
  cancel(id: string, input: { expectedVersion: string; changeId: string }): Promise<WriteResult>;
  /** Every schedule due at `now`, scheduled items and live items' updates alike, oldest first, at most `limit`. */
  due(input: { now: Date; limit: number }): Promise<DueSchedule[]>;
  /**
   * Runs one due schedule as one unit: publishes the scheduled item, or puts the update's source live and drops the
   * update. Only when what the site holds still matches (the same kind, time and change id, and the time has come);
   * otherwise it changes nothing and returns null, since a cancel, a reschedule or an unpublish got there first. A
   * scheduled item's first publication records `publishAt` as its `publishedAt`, not the time the cron ran.
   */
  apply(id: string, input: DueSchedule & { now: Date }): Promise<WriteResult | null>;
}

export interface SiteAdapter {
  site: SiteInfo;
  content: ContentAdapter;
  preview: PreviewAdapter;
  /** Absent on a site with no media manager: the media routes then answer 501, as in v0.1.0. */
  media?: MediaAdapter;
  /** Absent on a site that does not receive webmentions: the mentions routes then answer 501. */
  mentions?: MentionsAdapter;
  /**
   * Absent on a site with no scheduled updates (v0.10.0): reading and canceling a schedule answer 501, and a schedule on
   * a live item is refused, since the site's own schedule would take it off the site until the time.
   */
  schedules?: SchedulesAdapter;
}

/**
 * Stage 2 implemented content and preview; v0.2.0 adds media for a site whose adapter has it. The
 * other groups answer 501 until their stage.
 */
export function capabilitiesOf(adapter: SiteAdapter): Capabilities {
  return {
    content: true,
    preview: true,
    media: Boolean(adapter.media),
    inbox: false,
    insight: false,
    publications: false,
    ...(adapter.media ? { mediaUpload: adapter.media.limits } : {}),
    ...(adapter.content.delete ? { contentDelete: true } : {}),
    ...(adapter.content.setTags ? { contentTags: true } : {}),
    ...(adapter.media?.setAlt ? { mediaAlt: true } : {}),
    ...(adapter.media?.lenses?.length ? { mediaLenses: [...adapter.media.lenses] } : {}),
    ...(adapter.media?.setTags ? { mediaTags: true } : {}),
    ...(adapter.media?.trash && adapter.media.restore ? { mediaTrash: true } : {}),
    ...(adapter.media?.setFocus ? { mediaFocus: true } : {}),
    ...(adapter.media?.setCaption ? { mediaCaption: true } : {}),
    ...(adapter.media?.replace ? { mediaReplace: true } : {}),
    ...(adapter.media?.replace && adapter.media.replaceKeepsSize ? { mediaReplaceKeepsSize: true } : {}),
    ...(adapter.mentions ? { mentions: true } : {}),
    ...(adapter.mentions?.reset ? { mentionReset: true } : {}),
    ...(adapter.schedules ? { scheduledUpdates: true } : {}),
  };
}

/** @deprecated Since v0.2.0 capabilities depend on the adapter: use capabilitiesOf(adapter). */
export const CAPABILITIES: Capabilities = {
  content: true,
  preview: true,
  media: false,
  inbox: false,
  insight: false,
  publications: false,
};

/**
 * A content version made from the fields that identify an item's own content: the first 32 hex
 * characters of the SHA-256 of their JSON. For a site with no version column; pass the same fields,
 * in the same order, on every read and write.
 */
export async function contentVersion(parts: readonly unknown[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** The expectedVersion on a write is not what the site holds. currentVersion null: no such id. */
export class VersionConflictError extends Error {
  constructor(readonly currentVersion: string | null, message = "The content changed since it was loaded.") {
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
  constructor(readonly usedBy: MediaUse[], message?: string) {
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
