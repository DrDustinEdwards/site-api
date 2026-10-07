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
  MediaListQuery,
  MediaUploadLimits,
  MediaUse,
  PreviewInput,
  PublishInput,
  Revision,
  SaveDraftInput,
  ScheduleInput,
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
}

export interface SiteAdapter {
  site: SiteInfo;
  content: ContentAdapter;
  preview: PreviewAdapter;
  /** Absent on a site with no media manager: the media routes then answer 501, as in v0.1.0. */
  media?: MediaAdapter;
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
