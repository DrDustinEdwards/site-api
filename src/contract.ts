// The contract between Carrel and a site: every request and response body, as zod schemas.
//
// A site and Carrel agree when their schema hashes match. The hash covers these schemas and the
// route table, so any change to either is a new contract, and Carrel's health check sees it.

import { z } from "zod";

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
  Revision,
  RevisionList,
  RevisionSource,
  SaveDraftInput,
  ScheduleInput,
  UnpublishInput,
  WriteResult,
} from "./contract/content.js";
import {
  MediaAltInput,
  MediaBulkInput,
  MediaBulkResult,
  MediaDeleteQuery,
  MediaDeleteResult,
  MediaDetail,
  MediaItem,
  MediaLens,
  MediaList,
  MediaListQuery,
  MediaTagsInput,
  MediaTrashEmptyInput,
  MediaTrashEmptyResult,
  MediaTrashInput,
  MediaUploadLimits,
  MediaUploadQuery,
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

export const PACKAGE_VERSION = "0.8.0";
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
]);

export const ErrorBody = z.object({
  error: ErrorCode,
  message: z.string(),
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
 * adapter has no `mentions`.
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
  { group: "preview", method: "POST", path: "/preview", request: "PreviewInput", response: "text/html" },
  { group: "media", method: "GET", path: "/media", query: "MediaListQuery", response: "MediaList" },
  { group: "media", method: "POST", path: "/media", query: "MediaUploadQuery", request: "the file's bytes", response: "MediaItem" },
  { group: "media", method: "GET", path: "/media/:id", response: "MediaDetail" },
  { group: "media", method: "DELETE", path: "/media/:id", query: "MediaDeleteQuery", response: "MediaDeleteResult" },
  { group: "media", method: "PUT", path: "/media/:id/alt", request: "MediaAltInput", response: "MediaWriteResult" },
  { group: "media", method: "PUT", path: "/media/:id/tags", request: "MediaTagsInput", response: "MediaWriteResult" },
  { group: "media", method: "POST", path: "/media/:id/trash", request: "MediaTrashInput", response: "MediaWriteResult" },
  { group: "media", method: "POST", path: "/media/:id/restore", request: "MediaTrashInput", response: "MediaWriteResult" },
  { group: "media", method: "POST", path: "/media/trash/empty", request: "MediaTrashEmptyInput", response: "MediaTrashEmptyResult" },
  { group: "media", method: "POST", path: "/media/bulk", request: "MediaBulkInput", response: "MediaBulkResult" },
  { group: "mentions", method: "GET", path: "/mentions", query: "MentionListQuery", response: "MentionList" },
  { group: "mentions", method: "POST", path: "/mentions/sweep", request: "MentionSweepInput", response: "MentionSweepResult" },
  { group: "mentions", method: "POST", path: "/mentions/:id/decide", request: "MentionDecideInput", response: "MentionWriteResult" },
  { group: "mentions", method: "DELETE", path: "/mentions/:id", query: "MentionDeleteQuery", response: "MentionDeleteResult" },
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
