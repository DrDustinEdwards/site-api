// The contract between Carrel and a site: every request and response body, as zod schemas.
//
// A site and Carrel agree when their schema hashes match. The hash covers these schemas and the
// route table, so any change to either is a new contract, and Carrel's health check sees it.

import { z } from "zod";
import { POST_FIELDS, SEARCH_FIELDS } from "./frontmatter.js";

export { POST_FIELDS, SEARCH_FIELDS, type PostField, type SearchField } from "./frontmatter.js";

export {
  Actor,
  ActorName,
  ChangeId,
  ContentId,
  SiteInfo,
  SortDir,
  Version,
} from "./contract/base.js";
export { ROUTES } from "./contract/routes.js";
export * from "./contract/content.js";
export * from "./contract/media.js";
export * from "./contract/media/writes.js";
export * from "./contract/mentions.js";
export * from "./contract/insight.js";
import { SiteInfo, Version } from "./contract/base.js";
import { SCHEMA_HASH } from "./schema-hash.js";
import {
  BacklinkList,
  HookRunList,
  HookRunsQuery,
  CONTENT_FILTERS,
  ContentDeleteQuery,
  ContentDeleteResult,
  ContentDoc,
  ContentList,
  ContentSummary,
  ContentTagsInput,
  ContentTrashInput,
  Diff,
  DiffQuery,
  ListQuery,
  PreviewInput,
  PreviewLink,
  PreviewLinkInput,
  PreviewLinkList,
  PreviewLinkListQuery,
  PreviewLinkRevokeQuery,
  PreviewLinkRevokeResult,
  PublishInput,
  RenameInput,
  RenameResult,
  Revision,
  RevisionList,
  RevisionSource,
  SaveDraftInput,
  ScheduleCancelQuery,
  ScheduleInput,
  ScheduledUpdate,
  TranscriptInput,
  TranscriptWriteResult,
  UnpublishInput,
  WriteResult,
} from "./contract/content.js";
import {
  MediaDetail,
  MediaItem,
  MediaLens,
  MediaList,
  MediaListQuery,
  MediaUploadLimits,
  MediaUploadQuery,
  MediaUploadResult,
  MediaUse,
} from "./contract/media.js";
import {
  MediaAltInput,
  MediaBulkInput,
  MediaBulkResult,
  MediaCaptionInput,
  MediaCreditInput,
  MediaDeleteQuery,
  MediaDeleteResult,
  MediaFocusInput,
  MediaHistory,
  MediaImportInput,
  MediaReplaceQuery,
  MediaReplaceResult,
  MediaResize,
  MediaResizePassInput,
  MediaResizePassResult,
  MediaRevertInput,
  MediaSuggestions,
  MediaFileSuggestQuery,
  MediaFileSuggestions,
  MediaTagsInput,
  MediaTransformInput,
  MediaTransformResult,
  MediaTrashEmptyInput,
  MediaTrashEmptyResult,
  MediaTrashInput,
  MediaWriteResult,
} from "./contract/media/writes.js";
import {
  MentionDecideInput,
  MentionDeleteQuery,
  MentionDeleteResult,
  MentionItem,
  MentionList,
  MentionListQuery,
  MentionSweepInput,
  MentionSweepResult,
  MentionWriteResult,
} from "./contract/mentions.js";
import { NotFoundQuery, NotFoundReport } from "./contract/insight.js";

export const PACKAGE_VERSION = "0.49.0";
export const PREFIX = "/api/carrel/v1";

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
  /**
   * True when a live item can carry a scheduled update (v0.10.0): `GET` and `DELETE /content/:id/schedule`, and a
   * schedule on a live item that keeps it live until the update replaces it. Absent or false: those routes answer 501,
   * and a schedule on a live item is refused rather than hiding it.
   */
  scheduledUpdates: z.boolean().optional(),
  /** The search fields the site renders from a post's frontmatter (v0.17.0), each under its shared name. Absent: none. */
  searchFields: z.array(z.enum(SEARCH_FIELDS)).optional(),
  /** True when the site keeps a focal point on files (v0.10.0), `PUT /media/:id/focus`. Absent or false: that route answers 501. */
  mediaFocus: z.boolean().optional(),
  /** True when the site keeps a caption on files (v0.10.0), `PUT /media/:id/caption`. Absent or false: that route answers 501. */
  mediaCaption: z.boolean().optional(),
  /** True when the site replaces a file's bytes under the same id and address (v0.10.0), `PUT /media/:id/file`. Absent or false: that route answers 501. */
  mediaReplace: z.boolean().optional(),
  /**
   * True when the site refuses a replace whose picture is not the size of the one it replaces (v0.11.0): its addresses
   * or its pages are sized by the file's own width and height. Present only beside `mediaReplace`. A screen then asks
   * for a file of the same size, and saves a crop as a new file rather than in place. Absent: any size is taken.
   */
  mediaReplaceKeepsSize: z.boolean().optional(),
  // ---------- v0.13.0, each optional per site; absent or false, the route or the query answers 501 and the field is absent
  /** True when an upload or import whose bytes match a stored file's answers that file with `duplicateOf`, and details carry `twins`. */
  mediaDuplicates: z.boolean().optional(),
  /** True when items carry `usedCount` and the list sorts by `used`. */
  mediaUsage: z.boolean().optional(),
  /** True when the list takes `orientation` and `kind`. */
  mediaFilters: z.boolean().optional(),
  /** True when the site fetches a file from an https address into its own storage, `POST /media/import`. */
  mediaImport: z.boolean().optional(),
  /** True when the site keeps credit, license, source and license end on files, `PUT /media/:id/credit`. */
  mediaCredit: z.boolean().optional(),
  /** True when the site turns and mirrors pictures keeping the old bytes, `POST /media/:id/transform`. */
  mediaTransform: z.boolean().optional(),
  /** True when the site keeps a file's earlier bytes and puts them back, `GET /media/:id/history` and `POST /media/:id/revert`. */
  mediaHistory: z.boolean().optional(),
  /** True when the list answers a `changeCursor` and takes `changedSince`, so a screen polls for what others changed. */
  mediaChanges: z.boolean().optional(),
  /** What the site shrinks large pictures to at upload, unless the upload says `resize=no`. Absent: it keeps every upload's size. */
  mediaResize: MediaResize.optional(),
  /** True when the site shrinks stored pictures to `mediaResize`, `POST /media/resize-pass`. Present only beside `mediaResize`. */
  mediaResizePass: z.boolean().optional(),
  /** True when the site fills empty credit, license, caption and taken date from a file's embedded metadata at upload. */
  mediaEmbedded: z.boolean().optional(),
  /** True when the site's model suggests tags and alt text for a file, `GET /media/:id/suggestions`. */
  mediaSuggestions: z.boolean().optional(),
  /** True when the site's model suggests alt text and tags for a file before it is stored (v0.19.0), `POST /media/suggestions`. */
  mediaUploadSuggestions: z.boolean().optional(),
  // ---------- v0.17.0, each optional per site
  /**
   * True when every write is safe to retry under its change id: the same request again answers what the first one did,
   * with `Idempotent-Replayed: true`, and never runs twice. Preview links are the exception: their answer holds the
   * token, which is never stored, so a retried create makes a second link. Absent: a retry runs again, as before.
   */
  replay: z.boolean().optional(),
  /** True when an item moves to a new id, `POST /content/:id/rename`, its old path redirecting to the new one. */
  contentRename: z.boolean().optional(),
  /**
   * True when items go to a trash and come back, `POST /content/:id/trash` and `/restore`, and `trashed=true` lists the
   * trash. A trashed item is deleted for good after TRASH_DAYS by the site's cron.
   */
  contentTrash: z.boolean().optional(),
  /** The list filters the site applies; any other answers 501. `trashed` comes with `contentTrash`. Absent: none. */
  contentFilters: z.array(z.enum(CONTENT_FILTERS)).optional(),
  /** True when the site makes shareable preview links, `/preview-links`, served keyless under `/preview/`. */
  previewLinks: z.boolean().optional(),
  /** True when a publish takes `publishedAt`, the date it is published under. */
  contentPublishedAt: z.boolean().optional(),
  /** v0.22.0: items carry `hasDraft`, and a `draft` list also lists a live item with a pending draft. */
  contentHasDraft: z.boolean().optional(),
  /** The post fields the site renders from a post's frontmatter, each under its shared name. Absent: none. */
  postFields: z.array(z.enum(POST_FIELDS)).optional(),
  /** The Prelum RENDER_VERSION the site's stored HTML was rendered with (v0.17.0); a site re-renders when it is behind. Absent: the site does not say. */
  render: z.object({ version: z.string() }).optional(),
  /** True when the site counts its 404s and reports them (v0.16.0), `GET /insight/not-found`. Absent: that route answers 501. */
  insightNotFound: z.boolean().optional(),
  // ---------- v0.22.0, each optional per site
  /** True when the site lists the posts that link to one, `GET /content/:id/backlinks`. Absent: that route answers 501. */
  backlinks: z.boolean().optional(),
  /** Beside `previewLinks`: the most hours `expiresInHours` takes. Absent: a v0.17.0 site, which takes `hours` up to 168. */
  previewLinkHours: z.object({ max: z.number().int().min(1) }).optional(),
  /**
   * With a store: the publish hooks that hear a publish of a live page, by name. Each run is kept under its change id and
   * answered at `GET /hooks/recent?changeId=`, so a check can see that each one ran. Absent: the site keeps no hook runs.
   */
  hooks: z.array(z.string().min(1).max(200)).optional(),
  /**
   * v0.36.0: true when the site replaces an item's transcript, `PUT /content/:id/transcript`, and a read carries
   * `transcriptVersion` beside `transcript`. Absent: that route answers 501 and the transcript stays read only.
   */
  contentTranscript: z.boolean().optional(),
});

export const Meta = z.object({
  api: z.literal("carrel-site-api"),
  packageVersion: z.string(),
  schemaHash: z.string().regex(/^[0-9a-f]{64}$/),
  site: SiteInfo,
  capabilities: Capabilities,
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
  /** v0.17.0: a write under this change id is still running; send it again once that one has answered. */
  "in-progress",
  /** v0.22.0: the body or the query has a field the contract does not name; `field` names it. */
  "unknown-field",
]);

/**
 * Every error answer, sent as `application/problem+json` (RFC 9457) from v0.17.0: `type`, `title`, `status` and
 * `detail` (the message again) are the standard's fields, optional so an earlier site's answer still parses.
 */
export const ErrorBody = z.object({
  error: ErrorCode,
  message: z.string(),
  type: z.url().optional(),
  title: z.string().optional(),
  status: z.number().int().optional(),
  detail: z.string().optional(),
  /** On version-conflict only: what the site holds now, or null when the id does not exist. */
  currentVersion: Version.nullable().optional(),
  /** On a refused media delete only (v0.2.0): every place the file is used. */
  usedBy: z.array(MediaUse).optional(),
  /** On unknown-field only (v0.22.0): the first field the contract does not name. */
  field: z.string().optional(),
});

export type Capabilities = z.infer<typeof Capabilities>;
export type Meta = z.infer<typeof Meta>;
export type ErrorCode = z.infer<typeof ErrorCode>;
export type ErrorBody = z.infer<typeof ErrorBody>;

export const HASHED = {
  Meta,
  ContentSummary,
  ContentDoc,
  ListQuery,
  ContentList,
  SaveDraftInput,
  PublishInput,
  ScheduleInput,
  UnpublishInput,
  WriteResult,
  Revision,
  RevisionList,
  DiffQuery,
  Diff,
  PreviewInput,
  ErrorBody,
  MediaItem,
  MediaDetail,
  MediaListQuery,
  MediaList,
  MediaUploadQuery,
  MediaDeleteQuery,
  MediaDeleteResult,
  RevisionSource,
  ContentDeleteQuery,
  ContentDeleteResult,
  MediaAltInput,
  MediaTagsInput,
  MediaTrashInput,
  MediaWriteResult,
  MediaBulkInput,
  MediaBulkResult,
  MediaTrashEmptyInput,
  MediaTrashEmptyResult,
  MentionItem,
  MentionListQuery,
  MentionList,
  MentionDecideInput,
  MentionWriteResult,
  MentionDeleteQuery,
  MentionDeleteResult,
  MentionSweepInput,
  MentionSweepResult,
  ContentTagsInput,
  ScheduledUpdate,
  ScheduleCancelQuery,
  MediaFocusInput,
  MediaCaptionInput,
  MediaReplaceQuery,
  MediaReplaceResult,
  MediaUploadResult,
  MediaImportInput,
  MediaCreditInput,
  MediaTransformInput,
  MediaTransformResult,
  MediaHistory,
  MediaRevertInput,
  MediaResizePassInput,
  MediaResizePassResult,
  MediaSuggestions,
  RenameInput,
  RenameResult,
  ContentTrashInput,
  PreviewLinkInput,
  PreviewLink,
  PreviewLinkListQuery,
  PreviewLinkList,
  PreviewLinkRevokeQuery,
  PreviewLinkRevokeResult,
  NotFoundQuery,
  NotFoundReport,
  MediaFileSuggestQuery,
  MediaFileSuggestions,
  BacklinkList,
  HookRunsQuery,
  HookRunList,
  TranscriptInput,
  TranscriptWriteResult,
};

/**
 * The SHA-256 of the contract: every schema as JSON Schema, plus the route table. Recorded in
 * schema-hash.ts so no Worker builds every JSON Schema to learn it; test/schema-hash.test.ts
 * recomputes it and fails when the record is stale.
 */
export function schemaHash(): Promise<string> {
  return Promise.resolve(SCHEMA_HASH);
}
