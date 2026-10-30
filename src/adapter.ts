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
  MediaEmbeddedField,
  MediaResize,
  MediaRevision,
  MediaTransformOp,
  MediaUploadLimits,
  MediaUse,
  MentionList,
  MentionListQuery,
  MentionStatus,
  PostField,
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
  UnpublishInput,
  WriteResult,
} from "./contract.js";

export interface ContentAdapter {
  /**
   * Optional (v0.15.0): true when `publish` takes `publishedAt` and publishes under that date, a first publish backdated
   * or a live item re-dated (capabilities.contentPublishedAt). Absent: a publish carrying it answers 501.
   */
  publishedAtSettable?: boolean;
  /**
   * Optional (v0.15.0): the search and post fields the site renders from a post's frontmatter (capabilities.searchFields,
   * capabilities.postFields), each under its shared name in `@dustinedwards/site-api/frontmatter`. Absent: none.
   */
  searchFields?: readonly SearchField[];
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
  /**
   * Optional (v0.15.0): moves the item to `newId`, its history with it, and, when it was ever published, keeps a permanent
   * (301) redirect from its old path to the new one; answers that old path as `previousPath` (null when never published).
   * Throws NotFoundError (checked first), VersionConflictError, or RefusedError for a `newId` already taken. The move and
   * the redirect are one unit. A site without it answers `POST /content/:id/rename` with 501.
   */
  rename?(id: string, input: RenameInput): Promise<RenameResult>;
  /**
   * Optional (v0.15.0), both or neither, and only beside `delete` (capabilities.contentTrash): `trash` sets `trashedAt`
   * and takes a live item off the site first, as one unit; `restore` clears it and always answers a draft, never a live
   * item. Each throws like the writes. `list` then never lists a trashed item unless `trashed` is true, and then only
   * those. The package's `runSchedules` deletes items trashed more than TRASH_DAYS ago, through `delete`.
   */
  trash?(id: string, input: { expectedVersion: string; changeId: string }): Promise<WriteResult>;
  restore?(id: string, input: { expectedVersion: string; changeId: string }): Promise<WriteResult>;
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
  /**
   * v0.13.0: the SHA-256 of the bytes as lower case hex, which the site keeps to find duplicates (findByHash, the duplicates
   * lens, twins). The package always sends it; optional only so a site's own code can call upload without it.
   */
  sha256?: string;
  /** v0.13.0: true when the site shrinks the picture to its `resize`; false or absent when it has none or the upload said `resize=no`. */
  resize?: boolean;
  /** v0.13.0: on an import, the address it was fetched from, for the file's `sourceUrl`. */
  sourceUrl?: string;
}

/** What an upload answers (v0.13.0): the stored file, and, where they apply, what the site did with it. */
export type MediaUploaded = MediaItem & {
  /** The fields the site filled from the file's embedded metadata (IPTC, EXIF), each only where it was empty. */
  embedded?: MediaEmbeddedField[];
  /** The picture's size before the site shrank it. */
  resizedFrom?: { width: number; height: number; bytes: number };
};

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
  /**
   * Optional (v0.13.0): true when items carry `usedCount` from the site's reference check and `list` sorts by `used`
   * (capabilities.mediaUsage). Absent: `sort=used` answers 501.
   */
  usage?: boolean;
  /** Optional (v0.13.0): true when `list` applies `orientation` and `kind` (capabilities.mediaFilters). Absent: either answers 501. */
  filters?: boolean;
  /**
   * Optional (v0.13.0): what the site shrinks large pictures to (capabilities.mediaResize). `upload` gets `resize: true` and
   * shrinks a picture whose longer edge is over `maxEdge`, keeping its proportions, and answers `resizedFrom`.
   */
  resize?: MediaResize;
  /** Optional (v0.13.0): true when `upload` fills empty credit, license, caption and takenAt from embedded metadata and names them in `embedded`. */
  readsEmbedded?: boolean;
  /**
   * Optional (v0.13.0): the fetch the package imports with (capabilities.mediaImport), such as the Worker's own `fetch`. The
   * package checks the address, fetches it, checks the answer as an upload, and hands the bytes to `upload` with `sourceUrl`.
   */
  importFetch?: typeof fetch;
  list(query: MediaListQuery): Promise<MediaList>;
  /** The file and every place it is used. null when the id does not exist. */
  get(id: string): Promise<MediaDetail | null>;
  upload(input: MediaUpload): Promise<MediaUploaded>;
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

  // ---------- v0.13.0, each optional, answering 501 when absent

  /**
   * The stored file whose bytes have this SHA-256 (capabilities.mediaDuplicates), trashed or not; null when none. The package
   * asks before every upload and import, and answers a match with that file and `duplicateOf`, so `upload` never runs for
   * bytes the site already holds. A site with it also answers the `duplicates` lens and `twins` on a detail.
   */
  findByHash?(sha256: string): Promise<MediaItem | null>;
  /** Sets the file's credit, license, source and license end as one write, moving the version like the writes above. */
  setCredit?(
    id: string,
    input: { credit: string; license: string; sourceUrl: string | null; licenseExpires: string | null; expectedVersion: string; changeId: string },
  ): Promise<{ version: string }>;
  /**
   * Turns or mirrors the picture (capabilities.mediaTransform). The package has checked that the file exists, is at
   * `expectedVersion`, is `deletable` and is an image. In place (`asNewFile: false`): the same id and address, the old
   * bytes kept in the file's history, the focal point moved with the picture (`transformFocus`), and a new version. With
   * `asNewFile: true`, which the package sends for a quarter turn of a picture that is not square on a site whose
   * `replaceKeepsSize`, the site stores the turned picture as a new file (alt, caption, tags and credit copied) and leaves
   * the old one as it was. Throws RefusedError for a picture it cannot turn, such as an SVG.
   */
  transform?(
    id: string,
    input: { op: MediaTransformOp; asNewFile: boolean; expectedVersion: string; changeId: string },
  ): Promise<{ item: MediaItem; sizesNeedPurge: boolean }>;
  /** The file's byte history, newest first, exactly one `current` (capabilities.mediaHistory, with `revert`). null when the id does not exist. */
  history?(id: string): Promise<MediaRevision[] | null>;
  /**
   * Puts earlier bytes back under the same id and address, as a new revision (so a revert is itself undone by another).
   * The package has checked the file and its version, that `to` is in the history and is not current, and, on a site whose
   * `replaceKeepsSize`, that its size is the current one's. Alt, caption, tags and credit stay; the focal point is cleared.
   */
  revert?(id: string, input: { to: string; expectedVersion: string; changeId: string }): Promise<{ item: MediaItem; sizesNeedPurge: boolean }>;
  /**
   * Every file changed since `since`, a `changeCursor` the site answered on a list (capabilities.mediaChanges: with it,
   * every `list` answer carries `changeCursor`). A change is any write that moves a file's version or bytes, an upload,
   * and a delete for good (`removed`). Each file once, as it is now, trashed ones included; at most `limit` files and
   * removed ids together, the oldest changes first, `more` when others wait. `cursor` is where the next poll starts.
   * Throws RefusedError for a cursor it can no longer answer from, and the screen reloads its page.
   */
  changes?(input: { since: string; limit: number }): Promise<{ items: MediaItem[]; removed: string[]; cursor: string; more: boolean }>;
  /**
   * Shrinks one stored picture to `resize` (capabilities.mediaResizePass), in place, keeping the old bytes where the site
   * keeps history. Throws VersionConflictError, NotFoundError or RefusedError like the writes; `resized: false` and the
   * same version for a picture already within the size. Not offered on a site whose `replaceKeepsSize`.
   */
  shrink?(id: string, input: { expectedVersion: string; changeId: string }): Promise<{ resized: boolean; item: MediaItem }>;
  /**
   * What the site's model suggests for the file (capabilities.mediaSuggestions): tags and alt text, never applied. The
   * model is the site's choice (on Dustin's sites, Workers AI through Cloudflare AI Gateway). null when the id does not
   * exist. The package keeps the tags that are tags in the contract's spelling, at most 12.
   */
  suggest?(id: string): Promise<{ tags: string[]; alt: string | null; model: string } | null>;
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
  /** Optional (v0.15.0): the Prelum `RENDER_VERSION` the site's stored HTML was rendered with (capabilities.render). */
  renderVersion?: string;
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
 * other groups answer 501 until their stage. `store` (v0.15.0): the site gave createSiteApi a store.
 */
export function capabilitiesOf(adapter: SiteAdapter, options: { store?: boolean } = {}): Capabilities {
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
    ...(adapter.content.publishedAtSettable ? { contentPublishedAt: true } : {}),
    ...(adapter.content.rename ? { contentRename: true } : {}),
    ...(hasContentTrash(adapter) ? { contentTrash: true } : {}),
    ...(adapter.content.searchFields?.length ? { searchFields: [...adapter.content.searchFields] } : {}),
    ...(adapter.content.postFields?.length ? { postFields: [...adapter.content.postFields] } : {}),
    ...(adapter.media?.setAlt ? { mediaAlt: true } : {}),
    ...(adapter.media?.lenses?.length ? { mediaLenses: [...adapter.media.lenses] } : {}),
    ...(adapter.media?.setTags ? { mediaTags: true } : {}),
    ...(adapter.media?.trash && adapter.media.restore ? { mediaTrash: true } : {}),
    ...(adapter.media?.setFocus ? { mediaFocus: true } : {}),
    ...(adapter.media?.setCaption ? { mediaCaption: true } : {}),
    ...(adapter.media?.replace ? { mediaReplace: true } : {}),
    ...(adapter.media?.replace && adapter.media.replaceKeepsSize ? { mediaReplaceKeepsSize: true } : {}),
    ...(adapter.media?.findByHash ? { mediaDuplicates: true } : {}),
    ...(adapter.media?.usage ? { mediaUsage: true } : {}),
    ...(adapter.media?.filters ? { mediaFilters: true } : {}),
    ...(adapter.media?.importFetch ? { mediaImport: true } : {}),
    ...(adapter.media?.setCredit ? { mediaCredit: true } : {}),
    ...(adapter.media?.transform ? { mediaTransform: true } : {}),
    ...(adapter.media?.history && adapter.media.revert ? { mediaHistory: true } : {}),
    ...(adapter.media?.changes ? { mediaChanges: true } : {}),
    ...(adapter.media?.resize ? { mediaResize: { ...adapter.media.resize } } : {}),
    ...(adapter.media?.resize && adapter.media.shrink && !adapter.media.replaceKeepsSize ? { mediaResizePass: true } : {}),
    ...(adapter.media?.readsEmbedded ? { mediaEmbedded: true } : {}),
    ...(adapter.media?.suggest ? { mediaSuggestions: true } : {}),
    ...(adapter.mentions ? { mentions: true } : {}),
    ...(adapter.mentions?.reset ? { mentionReset: true } : {}),
    ...(adapter.schedules ? { scheduledUpdates: true } : {}),
    ...(options.store ? { replay: true } : {}),
    ...(adapter.renderVersion ? { render: { version: adapter.renderVersion } } : {}),
  };
}

/** Trash and restore, and the delete that empties the trash (v0.15.0). */
export function hasContentTrash(adapter: SiteAdapter): boolean {
  const { content } = adapter;
  return content.trash !== undefined && content.restore !== undefined && content.delete !== undefined;
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
