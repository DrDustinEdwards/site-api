// The contract between Carrel and a site: every request and response body, as zod schemas.
//
// A site and Carrel agree when their schema hashes match. The hash covers these schemas and the
// route table, so any change to either is a new contract, and Carrel's health check sees it.

import { z } from "zod";
import { POST_FIELDS, SEARCH_FIELDS } from "./frontmatter.js";

export { POST_FIELDS, SEARCH_FIELDS, type PostField, type SearchField } from "./frontmatter.js";

export { ChangeId, ContentId, SiteInfo, SortDir, Version } from "./contract/base.js";
export * from "./contract/content.js";
export * from "./contract/media.js";
export * from "./contract/mentions.js";
import { SiteInfo, Version } from "./contract/base.js";
import {
  ContentDeleteQuery,
  ContentDeleteResult,
  ContentDoc,
  ContentList,
  ContentSummary,
  ContentTagsInput,
  Diff,
  DiffQuery,
  ListQuery,
  PreviewInput,
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
  UnpublishInput,
  WriteResult,
} from "./contract/content.js";
import {
  MediaAltInput,
  MediaBulkInput,
  MediaBulkResult,
  MediaCaptionInput,
  MediaCreditInput,
  MediaDeleteQuery,
  MediaDeleteResult,
  MediaDetail,
  MediaFocusInput,
  MediaHistory,
  MediaImportInput,
  MediaItem,
  MediaLens,
  MediaList,
  MediaListQuery,
  MediaReplaceQuery,
  MediaReplaceResult,
  MediaResize,
  MediaResizePassInput,
  MediaResizePassResult,
  MediaRevertInput,
  MediaSuggestions,
  MediaTagsInput,
  MediaTransformInput,
  MediaTransformResult,
  MediaTrashEmptyInput,
  MediaTrashEmptyResult,
  MediaTrashInput,
  MediaUploadLimits,
  MediaUploadQuery,
  MediaUploadResult,
  MediaUse,
  MediaWriteResult,
} from "./contract/media.js";
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

export const PACKAGE_VERSION = "0.15.0";
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
  /** The search fields the site renders from a post's frontmatter (v0.15.0), each under its shared name. Absent: none. */
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
  // ---------- v0.15.0, each optional per site
  /**
   * True when every write is safe to retry under its change id: the same request again answers what the first one did,
   * with `Idempotent-Replayed: true`, and never runs twice. Absent: a retry runs again, as before.
   */
  replay: z.boolean().optional(),
  /** True when an item moves to a new id, `POST /content/:id/rename`, its old path redirecting to the new one. */
  contentRename: z.boolean().optional(),
  /** True when a publish takes `publishedAt`, the date it is published under. */
  contentPublishedAt: z.boolean().optional(),
  /** The post fields the site renders from a post's frontmatter, each under its shared name. Absent: none. */
  postFields: z.array(z.enum(POST_FIELDS)).optional(),
  /** The Prelum RENDER_VERSION the site's stored HTML was rendered with (v0.15.0); a site re-renders when it is behind. Absent: the site does not say. */
  render: z.object({ version: z.string() }).optional(),
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
  /** v0.15.0: a write under this change id is still running; send it again once that one has answered. */
  "in-progress",
]);

/**
 * Every error answer, sent as `application/problem+json` (RFC 9457) from v0.15.0: `type`, `title`, `status` and
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
});

export type Capabilities = z.infer<typeof Capabilities>;
export type Meta = z.infer<typeof Meta>;
export type ErrorCode = z.infer<typeof ErrorCode>;
export type ErrorBody = z.infer<typeof ErrorBody>;

/**
 * Every route, relative to PREFIX. Groups declared for later stages answer 501 until a site
 * implements them, so a route's existence is part of the contract even before its body is. The
 * media group arrived in v0.2.0; a site whose adapter has no `media` still answers it 501. v0.3.0
 * adds the source at a revision and an optional content delete (501 when the adapter has none).
 * v0.4.0 adds media writes, each optional per site (501 when the adapter lacks the method): alt
 * text, tags, trash, restore and empty-trash, and one bulk route that applies any of them to many files.
 * v0.5.0 adds the mentions group: list, decide, delete and sweep, answering 501 for a site whose
 * adapter has no `mentions`. v0.10.0 adds reading and canceling a schedule, 501 for a site whose adapter
 * has no `schedules`, and a file's focal point, caption and replace, each 501 where the adapter lacks it. v0.13.0 adds
 * import, credit, transform, history, revert, suggestions and the resize pass, each 501 where the adapter lacks it, and
 * the upload answers MediaUploadResult, a MediaItem with three optional properties more. v0.15.0 adds rename, trash and
 * restore of content and the preview links, each 501 where the adapter or the store is absent.
 */
export const ROUTES = [
  { group: "meta", method: "GET", path: "/meta", response: "Meta" },
  { group: "content", method: "GET", path: "/content", query: "ListQuery", response: "ContentList" },
  { group: "content", method: "GET", path: "/content/:id", response: "ContentDoc" },
  { group: "content", method: "PUT", path: "/content/:id/draft", request: "SaveDraftInput", response: "WriteResult" },
  { group: "content", method: "POST", path: "/content/:id/publish", request: "PublishInput", response: "WriteResult" },
  { group: "content", method: "POST", path: "/content/:id/schedule", request: "ScheduleInput", response: "WriteResult" },
  { group: "content", method: "POST", path: "/content/:id/unpublish", request: "UnpublishInput", response: "WriteResult" },
  { group: "content", method: "GET", path: "/content/:id/revisions", response: "RevisionList" },
  { group: "content", method: "GET", path: "/content/:id/diff", query: "DiffQuery", response: "Diff" },
  { group: "content", method: "GET", path: "/content/:id/revisions/:version", response: "RevisionSource" },
  { group: "content", method: "DELETE", path: "/content/:id", query: "ContentDeleteQuery", response: "ContentDeleteResult" },
  { group: "content", method: "PUT", path: "/content/:id/tags", request: "ContentTagsInput", response: "WriteResult" },
  { group: "content", method: "GET", path: "/content/:id/schedule", response: "ScheduledUpdate" },
  { group: "content", method: "DELETE", path: "/content/:id/schedule", query: "ScheduleCancelQuery", response: "WriteResult" },
  { group: "preview", method: "POST", path: "/preview", request: "PreviewInput", response: "text/html" },
  { group: "media", method: "GET", path: "/media", query: "MediaListQuery", response: "MediaList" },
  { group: "media", method: "POST", path: "/media", query: "MediaUploadQuery", request: "the file's bytes", response: "MediaUploadResult" },
  { group: "media", method: "POST", path: "/media/import", request: "MediaImportInput", response: "MediaUploadResult" },
  { group: "media", method: "GET", path: "/media/:id", response: "MediaDetail" },
  { group: "media", method: "DELETE", path: "/media/:id", query: "MediaDeleteQuery", response: "MediaDeleteResult" },
  { group: "media", method: "PUT", path: "/media/:id/alt", request: "MediaAltInput", response: "MediaWriteResult" },
  { group: "media", method: "PUT", path: "/media/:id/tags", request: "MediaTagsInput", response: "MediaWriteResult" },
  { group: "media", method: "PUT", path: "/media/:id/focus", request: "MediaFocusInput", response: "MediaWriteResult" },
  { group: "media", method: "PUT", path: "/media/:id/caption", request: "MediaCaptionInput", response: "MediaWriteResult" },
  { group: "media", method: "PUT", path: "/media/:id/file", query: "MediaReplaceQuery", request: "the file's bytes", response: "MediaReplaceResult" },
  { group: "media", method: "PUT", path: "/media/:id/credit", request: "MediaCreditInput", response: "MediaWriteResult" },
  { group: "media", method: "POST", path: "/media/:id/transform", request: "MediaTransformInput", response: "MediaTransformResult" },
  { group: "media", method: "GET", path: "/media/:id/history", response: "MediaHistory" },
  { group: "media", method: "POST", path: "/media/:id/revert", request: "MediaRevertInput", response: "MediaTransformResult" },
  { group: "media", method: "GET", path: "/media/:id/suggestions", response: "MediaSuggestions" },
  { group: "media", method: "POST", path: "/media/:id/trash", request: "MediaTrashInput", response: "MediaWriteResult" },
  { group: "media", method: "POST", path: "/media/:id/restore", request: "MediaTrashInput", response: "MediaWriteResult" },
  { group: "media", method: "POST", path: "/media/trash/empty", request: "MediaTrashEmptyInput", response: "MediaTrashEmptyResult" },
  { group: "media", method: "POST", path: "/media/bulk", request: "MediaBulkInput", response: "MediaBulkResult" },
  { group: "media", method: "POST", path: "/media/resize-pass", request: "MediaResizePassInput", response: "MediaResizePassResult" },
  { group: "mentions", method: "GET", path: "/mentions", query: "MentionListQuery", response: "MentionList" },
  { group: "mentions", method: "POST", path: "/mentions/sweep", request: "MentionSweepInput", response: "MentionSweepResult" },
  { group: "mentions", method: "POST", path: "/mentions/:id/decide", request: "MentionDecideInput", response: "MentionWriteResult" },
  { group: "mentions", method: "DELETE", path: "/mentions/:id", query: "MentionDeleteQuery", response: "MentionDeleteResult" },
  // v0.15.0, each 501 where the adapter lacks it.
  { group: "content", method: "POST", path: "/content/:id/rename", request: "RenameInput", response: "RenameResult" },
  { group: "inbox", method: "*", path: "/inbox/*", response: "not-implemented" },
  { group: "insight", method: "*", path: "/insight/*", response: "not-implemented" },
  { group: "publications", method: "*", path: "/publications/*", response: "not-implemented" },
] as const;

const HASHED = {
  Meta, ContentSummary, ContentDoc, ListQuery, ContentList, SaveDraftInput, PublishInput,
  ScheduleInput, UnpublishInput, WriteResult, Revision, RevisionList, DiffQuery, Diff,
  PreviewInput, ErrorBody, MediaItem, MediaDetail, MediaListQuery, MediaList, MediaUploadQuery,
  MediaDeleteQuery, MediaDeleteResult, RevisionSource, ContentDeleteQuery, ContentDeleteResult,
  MediaAltInput, MediaTagsInput, MediaTrashInput, MediaWriteResult, MediaBulkInput, MediaBulkResult,
  MediaTrashEmptyInput, MediaTrashEmptyResult,
  MentionItem, MentionListQuery, MentionList, MentionDecideInput, MentionWriteResult, MentionDeleteQuery,
  MentionDeleteResult, MentionSweepInput, MentionSweepResult,
  ContentTagsInput,
  ScheduledUpdate, ScheduleCancelQuery,
  MediaFocusInput, MediaCaptionInput, MediaReplaceQuery, MediaReplaceResult,
  MediaUploadResult, MediaImportInput, MediaCreditInput, MediaTransformInput, MediaTransformResult, MediaHistory,
  MediaRevertInput, MediaResizePassInput, MediaResizePassResult, MediaSuggestions,
  RenameInput, RenameResult,
};

/** JSON with sorted keys, so the hash depends on the contract and not on property order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

let cachedHash: Promise<string> | undefined;

/** The SHA-256 of the contract: every schema as JSON Schema, plus the route table. */
export function schemaHash(): Promise<string> {
  cachedHash ??= (async () => {
    const schemas = Object.fromEntries(
      Object.entries(HASHED).map(([name, schema]) => [name, z.toJSONSchema(schema, { io: "input" })]),
    );
    const bytes = new TextEncoder().encode(canonical({ prefix: PREFIX, routes: ROUTES, schemas }));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  })();
  return cachedHash;
}
