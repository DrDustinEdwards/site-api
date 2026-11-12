/**
 * Drizzle mirrors of the tables site-api creates with its own SQL, for a site whose schema drizzle-kit reads: the
 * schema re-exports these (`export { media, mediaRevisions, mediaChanges } from "@dustinedwards/site-api/drizzle"`), so
 * drizzle-kit knows each table and never writes a migration that drops or reshapes it, and no site keeps a hand copy
 * that can drift from the SQL. Times are UTC ISO text, as the SQL writes them. test/drizzle.test.ts holds each one to
 * its SQL with site-runtime's ./drizzle-check. The triggers on `media` that fill `media_changes` are the SQL's alone:
 * drizzle-kit neither knows nor drops them.
 */
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** ./media-store MEDIA_LIBRARY_SQL: one row per file, written only by d1MediaStore. `tags` is a JSON array of strings. */
export const media = sqliteTable(
  "media",
  {
    key: text("key").primaryKey(),
    filename: text("filename"),
    contentType: text("content_type").notNull(),
    bytes: integer("bytes").notNull(),
    width: integer("width"),
    height: integer("height"),
    sha256: text("sha256").notNull(),
    alt: text("alt").notNull().default(""),
    caption: text("caption").notNull().default(""),
    tags: text("tags", { mode: "json" }).$type<string[]>().notNull().default([]),
    focus: text("focus"),
    credit: text("credit").notNull().default(""),
    license: text("license").notNull().default(""),
    sourceUrl: text("source_url"),
    licenseExpires: text("license_expires"),
    takenAt: text("taken_at"),
    uploadedAt: text("uploaded_at").notNull(),
    trashedAt: text("trashed_at"),
    rev: integer("rev").notNull().default(0),
    placeholder: text("placeholder"),
    color: text("color"),
  },
  (t) => [index("media_sha256").on(t.sha256)],
);

/** MEDIA_LIBRARY_SQL: every set of bytes a file has had; an earlier set is kept under `copy_key`. */
export const mediaRevisions = sqliteTable(
  "media_revisions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    mediaKey: text("media_key").notNull(),
    at: text("at").notNull(),
    bytes: integer("bytes").notNull(),
    width: integer("width"),
    height: integer("height"),
    reason: text("reason").notNull(),
    sha256: text("sha256").notNull(),
    copyKey: text("copy_key"),
  },
  (t) => [index("media_revisions_key").on(t.mediaKey, t.id)],
);

/** MEDIA_LIBRARY_SQL: one row per insert, update or delete of a `media` row, written by its triggers. */
export const mediaChanges = sqliteTable("media_changes", {
  seq: integer("seq").primaryKey({ autoIncrement: true }),
  mediaKey: text("media_key").notNull(),
});

/** ./store SITE_API_STORE_SQL: each Carrel write's answer under its change id, so a retry answers the same. */
export const siteApiWrites = sqliteTable(
  "site_api_writes",
  {
    changeId: text("change_id").primaryKey(),
    route: text("route").notNull(),
    requestHash: text("request_hash").notNull(),
    status: integer("status"),
    response: text("response"),
    state: text("state").notNull(),
    at: text("at").notNull(),
  },
  (t) => [index("site_api_writes_at").on(t.at)],
);

/** SITE_API_STORE_SQL: the publish hooks that failed, for the cron to run again. */
export const hookRetries = sqliteTable(
  "hook_retries",
  {
    id: text("id").primaryKey(),
    hook: text("hook").notNull(),
    event: text("event").notNull(),
    attempts: integer("attempts").notNull(),
    nextAt: text("next_at").notNull(),
    lastError: text("last_error").notNull(),
  },
  (t) => [index("hook_retries_due").on(t.nextAt)],
);

/** SITE_API_STORE_SQL: only the SHA-256 of each preview link's token. */
export const previewLinks = sqliteTable(
  "preview_links",
  {
    tokenHash: text("token_hash").primaryKey(),
    contentId: text("content_id").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
    changeId: text("change_id").notNull(),
  },
  (t) => [index("preview_links_content").on(t.contentId, t.expiresAt)],
);

/** SITE_API_STORE_SQL: the pages each page last sent webmentions to. */
export const webmentionTargets = sqliteTable("webmention_targets", {
  source: text("source").primaryKey(),
  targets: text("targets").notNull(),
  sentAt: text("sent_at").notNull(),
});

/** SITE_API_STORE_SQL (v0.21.0): the media file each upload's duplicates key became. */
export const mediaUploads = sqliteTable("media_uploads", {
  sha256: text("sha256").primaryKey(),
  mediaId: text("media_id").notNull(),
  at: text("at").notNull(),
});

/** SITE_API_STORE_SQL (v0.22.0): the public path of each live item Carrel deleted or trashed, answered 410. */
export const gonePaths = sqliteTable("gone_paths", {
  path: text("path").primaryKey(),
  goneAt: text("gone_at").notNull(),
});

/** SITE_API_STORE_SQL (v0.22.0): each publish hook's run, for GET /hooks/recent. */
export const hookRuns = sqliteTable(
  "hook_runs",
  {
    changeId: text("change_id").notNull(),
    hook: text("hook").notNull(),
    ok: integer("ok").notNull(),
    at: text("at").notNull(),
  },
  (t) => [index("hook_runs_change").on(t.changeId), index("hook_runs_at").on(t.at)],
);

/** ./schedules SCHEDULED_UPDATES_SQL: an update Carrel scheduled on a live item, one per item. */
export const scheduledUpdates = sqliteTable(
  "scheduled_updates",
  {
    contentId: text("content_id").primaryKey(),
    source: text("source").notNull(),
    publishAt: text("publish_at").notNull(),
    changeId: text("change_id").notNull(),
    scheduledAt: text("scheduled_at").notNull(),
  },
  (t) => [index("scheduled_updates_due").on(t.publishAt)],
);
