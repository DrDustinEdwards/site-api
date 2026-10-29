// Where a D1 site keeps the updates scheduled on its live items (v0.10.0): one table beside the site's own content
// table, so each D1 site's `schedules` adapter is a few lines over this instead of its own copy. A site that keeps its
// content elsewhere (dustinedwards.info keeps files in git) implements `SchedulesAdapter` its own way.
//
// The writes return statements, not results, so the site runs each in one `db.batch` with its own row's version move:
// the update and the item's version change together or not at all.

import type { ScheduledUpdate } from "./contract.js";

/** The part of a D1 prepared statement this uses, so a site passes its binding straight in. */
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<unknown>;
}

/** The part of a D1 database binding this uses. */
export interface D1Like {
  prepare(sql: string): D1StatementLike;
}

/**
 * The migration: a D1 site adds it as its next file under `migrations/`. `publish_at` holds UTC ISO text, so the due
 * scan is a text comparison on its index.
 */
export const SCHEDULED_UPDATES_SQL = `CREATE TABLE IF NOT EXISTS scheduled_updates (
  content_id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  publish_at TEXT NOT NULL,
  change_id TEXT NOT NULL,
  scheduled_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scheduled_updates_due ON scheduled_updates (publish_at);
`;

interface Row {
  content_id: string;
  source: string;
  publish_at: string;
  change_id: string;
  scheduled_at: string;
}

/** UTC ISO text, so every stored time compares as text and a time written with an offset matches itself. */
export function utc(time: string | Date): string {
  return new Date(time).toISOString();
}

export function d1ScheduledUpdates(db: D1Like) {
  const toUpdate = (row: Row): ScheduledUpdate => ({
    id: row.content_id,
    source: row.source,
    publishAt: row.publish_at,
    changeId: row.change_id,
    scheduledAt: row.scheduled_at,
  });

  return {
    /** The update waiting on an item, or null. */
    async get(id: string): Promise<ScheduledUpdate | null> {
      const row = await db.prepare("SELECT * FROM scheduled_updates WHERE content_id = ?").bind(id).first<Row>();
      return row ? toUpdate(row) : null;
    },
    /** Stores the update, replacing any already waiting (a reschedule). Run it in a batch with the item's version move. */
    put(id: string, input: { source: string; publishAt: string; changeId: string; scheduledAt?: Date }): D1StatementLike {
      return db
        .prepare(
          `INSERT INTO scheduled_updates (content_id, source, publish_at, change_id, scheduled_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (content_id) DO UPDATE SET source = excluded.source, publish_at = excluded.publish_at,
             change_id = excluded.change_id, scheduled_at = excluded.scheduled_at`,
        )
        .bind(id, input.source, utc(input.publishAt), input.changeId, utc(input.scheduledAt ?? new Date()));
    },
    /**
     * Drops the update: on a cancel, an unpublish, a publish now or a delete with no `match`; when a schedule applies,
     * with the `match` it was listed with, so a reschedule made in between is kept.
     */
    remove(id: string, match?: { publishAt: string; changeId: string }): D1StatementLike {
      return match
        ? db.prepare("DELETE FROM scheduled_updates WHERE content_id = ? AND publish_at = ? AND change_id = ?").bind(id, utc(match.publishAt), match.changeId)
        : db.prepare("DELETE FROM scheduled_updates WHERE content_id = ?").bind(id);
    },
    /** The updates due at `now`, oldest first, at most `limit`, as `SchedulesAdapter.due` lists them. */
    async due(now: Date, limit: number): Promise<Array<{ id: string; kind: "update"; publishAt: string; changeId: string }>> {
      const { results } = await db
        .prepare("SELECT content_id, publish_at, change_id FROM scheduled_updates WHERE publish_at <= ? ORDER BY publish_at, content_id LIMIT ?")
        .bind(utc(now), limit)
        .all<Row>();
      return results.map((row) => ({ id: row.content_id, kind: "update" as const, publishAt: row.publish_at, changeId: row.change_id }));
    },
  };
}

export type D1ScheduledUpdates = ReturnType<typeof d1ScheduledUpdates>;
