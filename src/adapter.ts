// What each site implements. The package owns the route, the key, the rate limit and the shape of
// every body; the adapter owns the site's storage, its rules and its render.

import type {
  Capabilities,
  ContentDoc,
  ContentList,
  ListQuery,
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
  /** Unpublish returns the item to draft. Deleting stays in the site's own history, never here. */
  unpublish(id: string, input: UnpublishInput): Promise<WriteResult>;
  /** Newest first. null when the id does not exist. */
  revisions(id: string): Promise<Revision[] | null>;
  /** The source as it was at a version; null when the id or the version does not exist. */
  revisionSource(id: string, version: string): Promise<string | null>;
}

export interface PreviewAdapter {
  /** The full page HTML, from the site's own route and pipeline, exactly as it would publish. */
  render(input: PreviewInput): Promise<string>;
}

export interface SiteAdapter {
  site: SiteInfo;
  content: ContentAdapter;
  preview: PreviewAdapter;
}

/** Stage 2 implements content and preview; the other groups answer 501 until their stage. */
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

/** The site's own rules refused the write, such as a render failure or a policy. Shown to the writer. */
export class RefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefusedError";
  }
}
