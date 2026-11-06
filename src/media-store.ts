// The media library's store on D1 (v0.24.0), over the network's standard tables: `media`, `media_revisions` and the
// trigger-kept `media_changes` (MEDIA_LIBRARY_SQL). A site on these tables passes `d1MediaStore(env.DB)` to
// `mediaLibrary` and keeps no store of its own; a site whose tables differ writes a MediaLibraryStore over its own.

import type { MediaLibraryStore, MediaRecord, MediaRecordFields, MediaRevisionRecord, MediaRecordWrite } from "./media-library.js";
import type { D1Like, D1StatementLike } from "./schedules.js";

/** The D1 binding as the store uses it: a statement, and a batch that runs several in one transaction. */
export interface D1BatchLike extends D1Like {
  batch(statements: D1StatementLike[]): Promise<unknown[]>;
}

/**
 * The migration for a site new to the library. Times are ISO 8601 UTC; `rev` is the file's version; `tags` a JSON array
 * in the contract's spelling; `focus` "XxY". Each earlier set of a file's bytes is a `media_revisions` row naming its copy
 * (`copy_key`). The triggers log every insert, update and delete of a row, so no write path can forget to.
 */
export const MEDIA_LIBRARY_SQL = `CREATE TABLE media (
  key TEXT PRIMARY KEY NOT NULL,
  filename TEXT,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  sha256 TEXT NOT NULL,
  alt TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '[]',
  focus TEXT,
  credit TEXT NOT NULL DEFAULT '',
  license TEXT NOT NULL DEFAULT '',
  source_url TEXT,
  license_expires TEXT,
  taken_at TEXT,
  uploaded_at TEXT NOT NULL,
  trashed_at TEXT,
  rev INTEGER NOT NULL DEFAULT 0,
  placeholder TEXT,
  color TEXT
);
CREATE INDEX media_sha256 ON media (sha256);
CREATE TABLE media_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_key TEXT NOT NULL,
  at TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  reason TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  copy_key TEXT
);
CREATE INDEX media_revisions_key ON media_revisions (media_key, id);
CREATE TABLE media_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  media_key TEXT NOT NULL
);
CREATE TRIGGER media_changes_insert AFTER INSERT ON media BEGIN
  INSERT INTO media_changes (media_key) VALUES (NEW.key);
END;
CREATE TRIGGER media_changes_update AFTER UPDATE ON media BEGIN
  INSERT INTO media_changes (media_key) VALUES (NEW.key);
END;
CREATE TRIGGER media_changes_delete AFTER DELETE ON media BEGIN
  INSERT INTO media_changes (media_key) VALUES (OLD.key);
END;
`;

/** Each record field and its column. */
const COLUMNS = {
  filename: "filename",
  contentType: "content_type",
  bytes: "bytes",
  width: "width",
  height: "height",
  sha256: "sha256",
  alt: "alt",
  caption: "caption",
  tags: "tags",
  focus: "focus",
  credit: "credit",
  license: "license",
  sourceUrl: "source_url",
  licenseExpires: "license_expires",
  takenAt: "taken_at",
  uploadedAt: "uploaded_at",
  trashedAt: "trashed_at",
  placeholder: "placeholder",
  color: "color",
} as const satisfies Partial<Record<keyof MediaRecord, string>>;

type Column = keyof typeof COLUMNS;

/** D1 binds at most 100 values to one statement. */
const CHUNK = 90;

interface Row {
  key: string;
  rev: number;
  filename: string | null;
  content_type: string;
  bytes: number;
  width: number | null;
  height: number | null;
  sha256: string;
  alt: string;
  caption: string;
  tags: string;
  focus: string | null;
  credit: string;
  license: string;
  source_url: string | null;
  license_expires: string | null;
  taken_at: string | null;
  uploaded_at: string;
  trashed_at: string | null;
  placeholder: string | null;
  color: string | null;
}

interface RevisionRow {
  id: number;
  at: string;
  bytes: number;
  width: number | null;
  height: number | null;
  reason: MediaRevisionRecord["reason"];
  sha256: string | null;
  copy_key: string | null;
}

/** A stored tag set, read defensively: anything but an array of strings is no tags. */
function tagsOf(raw: string): string[] {
  try {
    const tags: unknown = JSON.parse(raw);
    return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

function recordOf(row: Row): MediaRecord {
  return {
    key: row.key,
    rev: row.rev,
    filename: row.filename,
    contentType: row.content_type,
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    sha256: row.sha256,
    alt: row.alt,
    caption: row.caption,
    tags: tagsOf(row.tags),
    focus: row.focus,
    credit: row.credit,
    license: row.license,
    sourceUrl: row.source_url,
    licenseExpires: row.license_expires,
    takenAt: row.taken_at,
    uploadedAt: row.uploaded_at,
    trashedAt: row.trashed_at,
    placeholder: row.placeholder,
    color: row.color,
  };
}

function revisionOf(row: RevisionRow): MediaRevisionRecord {
  return { id: row.id, at: row.at, bytes: row.bytes, width: row.width, height: row.height, reason: row.reason, sha256: row.sha256, copyKey: row.copy_key };
}

/** The columns a write sets, and their values, in the store's order. Fields with no column here are dropped. */
function assignments(fields: MediaRecordFields): { sql: string[]; values: unknown[] } {
  const sql: string[] = [];
  const values: unknown[] = [];
  for (const field of Object.keys(COLUMNS) as Column[]) {
    if (!(field in fields)) continue;
    const value = fields[field];
    if (value === undefined) continue;
    sql.push(`${COLUMNS[field]} = ?`);
    values.push(field === "tags" ? JSON.stringify(value) : value);
  }
  return { sql, values };
}

export interface D1MediaStoreOptions {
  /**
   * The site's own check that a file is still used, as a SQL condition on `?` (bound to the file's key) over its own
   * tables, such as `EXISTS (SELECT 1 FROM posts WHERE instr(body, '/media/' || ?) > 0)`. The row is then removed only
   * while it is false, in the same statement, so a page saved during a delete never loses its file.
   */
  inUse?: string;
}

/** The library's store over MEDIA_LIBRARY_SQL's tables. */
export function d1MediaStore(db: D1BatchLike, options: D1MediaStoreOptions = {}): MediaLibraryStore {
  const one = async (key: string) => {
    const row = await db.prepare("SELECT * FROM media WHERE key = ?").bind(key).first<Row>();
    return row ? recordOf(row) : null;
  };

  return {
    record: one,

    async records(keys) {
      const out: MediaRecord[] = [];
      for (let n = 0; n < keys.length; n += CHUNK) {
        const chunk = keys.slice(n, n + CHUNK);
        const { results } = await db
          .prepare(`SELECT * FROM media WHERE key IN (${chunk.map(() => "?").join(", ")})`)
          .bind(...chunk)
          .all<Row>();
        out.push(...results.map(recordOf));
      }
      return out;
    },

    async all() {
      const { results } = await db.prepare("SELECT * FROM media ORDER BY uploaded_at DESC, key ASC").all<Row>();
      return results.map(recordOf);
    },

    async byHash(sha256) {
      const current = await db.prepare("SELECT * FROM media WHERE sha256 = ? ORDER BY uploaded_at ASC, key ASC LIMIT 1").bind(sha256).first<Row>();
      if (current) return recordOf(current);
      const original = await db
        .prepare("SELECT m.* FROM media_revisions r JOIN media m ON m.key = r.media_key WHERE r.sha256 = ? AND r.reason IN ('upload', 'import') ORDER BY r.id ASC LIMIT 1")
        .bind(sha256)
        .first<Row>();
      return original ? recordOf(original) : null;
    },

    async insert(record) {
      const { sql, values } = assignments(record);
      const columns = sql.map((s) => s.slice(0, -4));
      await db
        .prepare(`INSERT INTO media (key, ${columns.join(", ")}) VALUES (?, ${columns.map(() => "?").join(", ")})`)
        .bind(record.key, ...values)
        .run();
    },

    async writeAtRev(key, fields, expectedRev): Promise<MediaRecordWrite> {
      const { sql, values } = assignments(fields);
      const row = await db
        .prepare(`UPDATE media SET ${[...sql, "rev = rev + 1"].join(", ")} WHERE key = ? AND rev = ? RETURNING *`)
        .bind(...values, key, expectedRev)
        .first<Row>();
      if (row) return { ok: true, record: recordOf(row) };
      const now = await one(key);
      return now ? { ok: false, reason: "stale", rev: now.rev } : { ok: false, reason: "missing" };
    },

    async follow(key, fields) {
      const { sql, values } = assignments(fields);
      const row =
        sql.length === 0
          ? await db.prepare("SELECT * FROM media WHERE key = ?").bind(key).first<Row>()
          : await db
              .prepare(`UPDATE media SET ${sql.join(", ")} WHERE key = ? RETURNING *`)
              .bind(...values, key)
              .first<Row>();
      if (!row) throw new Error(`${key} changed its bytes, but its row is gone`);
      return recordOf(row);
    },

    async addRevision(key, revision) {
      const row = await db
        .prepare("INSERT INTO media_revisions (media_key, at, bytes, width, height, reason, sha256, copy_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id")
        .bind(key, revision.at, revision.bytes, revision.width, revision.height, revision.reason, revision.sha256 ?? "", revision.copyKey)
        .first<{ id: number }>();
      if (!row) throw new Error(`${key}'s revision was not recorded`);
      return row.id;
    },

    async revisions(key, limit = 100) {
      const { results } = await db.prepare("SELECT * FROM media_revisions WHERE media_key = ? ORDER BY id DESC LIMIT ?").bind(key, limit).all<RevisionRow>();
      return results.map(revisionOf);
    },

    async keepCopy(revisionId, copyKey) {
      await db.prepare("UPDATE media_revisions SET copy_key = ? WHERE id = ?").bind(copyKey, revisionId).run();
    },

    async remove(key, rev) {
      const now = await one(key);
      if (!now) return "missing";
      if (now.rev !== rev) return "stale";
      const guard = options.inUse ? ` AND NOT (${options.inUse})` : "";
      const guardBinds = options.inUse ? Array.from({ length: (options.inUse.match(/\?/g) ?? []).length }, () => key) : [];
      const [deleted] = (await db.batch([
        db.prepare(`DELETE FROM media WHERE key = ? AND rev = ?${guard} RETURNING key`).bind(key, rev, ...guardBinds),
        db.prepare("DELETE FROM media_revisions WHERE media_key = ? AND NOT EXISTS (SELECT 1 FROM media WHERE key = ?)").bind(key, key),
      ])) as Array<{ results?: unknown[] }>;
      if ((deleted?.results?.length ?? 0) > 0) return "removed";
      const after = await one(key);
      return !after ? "missing" : after.rev !== rev ? "stale" : "in-use";
    },

    async changeCursor() {
      const row = await db.prepare("SELECT max(seq) AS seq FROM media_changes").first<{ seq: number | null }>();
      return row?.seq ?? 0;
    },

    async changedSince(from, head, limit) {
      const { results } = await db
        .prepare("SELECT media_key AS key, max(seq) AS seq FROM media_changes WHERE seq > ? AND seq <= ? GROUP BY media_key ORDER BY max(seq) ASC LIMIT ?")
        .bind(from, head, limit + 1)
        .all<{ key: string; seq: number }>();
      return results;
    },
  };
}
