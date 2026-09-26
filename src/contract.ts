// The contract between Carrel and a site: every request and response body, as zod schemas.
//
// A site and Carrel agree when their schema hashes match. The hash covers these schemas and the
// route table, so any change to either is a new contract, and Carrel's health check sees it.

import { z } from "zod";

export const PACKAGE_VERSION = "0.1.0";
export const PREFIX = "/api/carrel/v1";

/** Opaque to Carrel: each site decides what a version is (dustinedwards.info uses the head commit). */
export const Version = z.string().min(1).max(200);

/** Carrel's id for one change, carried into the site's commit or row so the two records join. */
export const ChangeId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

/** A site's id for one piece of content: a slug, or a row id. Never a path. */
export const ContentId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);

const Timestamp = z.iso.datetime({ offset: true });

/** Two million characters: far above any article, far below a Worker's memory. */
const Source = z.string().max(2_000_000);

export const ContentStatus = z.enum(["draft", "scheduled", "published"]);

export const SiteInfo = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,64}$/),
  name: z.string().min(1).max(200),
  origin: z.url(),
});

export const Capabilities = z.object({
  content: z.boolean(),
  preview: z.boolean(),
  media: z.boolean(),
  inbox: z.boolean(),
  insight: z.boolean(),
  publications: z.boolean(),
});

export const Meta = z.object({
  api: z.literal("carrel-site-api"),
  packageVersion: z.string(),
  schemaHash: z.string().regex(/^[0-9a-f]{64}$/),
  site: SiteInfo,
  capabilities: Capabilities,
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
});

export const ContentDoc = ContentSummary.extend({
  format: z.literal("markdown"),
  source: Source,
  version: Version,
});

export const ListQuery = z.object({
  status: ContentStatus.optional(),
  q: z.string().max(200).optional(),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const ContentList = z.object({
  items: z.array(ContentSummary),
  nextCursor: z.string().nullable(),
});

/** expectedVersion null means "this id must not exist yet": the create case. */
export const SaveDraftInput = z.object({
  source: Source,
  expectedVersion: Version.nullable(),
  changeId: ChangeId,
});

/** source, when sent, is saved and published in one write. */
export const PublishInput = z.object({
  expectedVersion: Version,
  changeId: ChangeId,
  source: Source.optional(),
});

export const ScheduleInput = PublishInput.extend({
  publishAt: Timestamp,
});

export const UnpublishInput = z.object({
  expectedVersion: Version,
  changeId: ChangeId,
});

export const WriteResult = z.object({
  id: ContentId,
  version: Version,
  status: ContentStatus,
  changeId: ChangeId,
});

export const Revision = z.object({
  version: Version,
  at: Timestamp,
  author: z.string().max(200),
  message: z.string().max(2000),
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

/** id, when sent, lets the site render the draft at that item's own route. */
export const PreviewInput = z.object({
  id: ContentId.optional(),
  source: Source,
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
});

export type SiteInfo = z.infer<typeof SiteInfo>;
export type Capabilities = z.infer<typeof Capabilities>;
export type Meta = z.infer<typeof Meta>;
export type ContentStatus = z.infer<typeof ContentStatus>;
export type ContentSummary = z.infer<typeof ContentSummary>;
export type ContentDoc = z.infer<typeof ContentDoc>;
export type ListQuery = z.infer<typeof ListQuery>;
export type ContentList = z.infer<typeof ContentList>;
export type SaveDraftInput = z.infer<typeof SaveDraftInput>;
export type PublishInput = z.infer<typeof PublishInput>;
export type ScheduleInput = z.infer<typeof ScheduleInput>;
export type UnpublishInput = z.infer<typeof UnpublishInput>;
export type WriteResult = z.infer<typeof WriteResult>;
export type Revision = z.infer<typeof Revision>;
export type RevisionList = z.infer<typeof RevisionList>;
export type Diff = z.infer<typeof Diff>;
export type PreviewInput = z.infer<typeof PreviewInput>;
export type ErrorCode = z.infer<typeof ErrorCode>;
export type ErrorBody = z.infer<typeof ErrorBody>;

/**
 * Every route, relative to PREFIX. Groups declared for later stages answer 501 until a site
 * implements them, so a route's existence is part of the contract even before its body is.
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
  { group: "preview", method: "POST", path: "/preview", request: "PreviewInput", response: "text/html" },
  { group: "media", method: "*", path: "/media/*", response: "not-implemented" },
  { group: "inbox", method: "*", path: "/inbox/*", response: "not-implemented" },
  { group: "insight", method: "*", path: "/insight/*", response: "not-implemented" },
  { group: "publications", method: "*", path: "/publications/*", response: "not-implemented" },
] as const;

const HASHED = {
  Meta, ContentSummary, ContentDoc, ListQuery, ContentList, SaveDraftInput, PublishInput,
  ScheduleInput, UnpublishInput, WriteResult, Revision, RevisionList, DiffQuery, Diff,
  PreviewInput, ErrorBody,
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
