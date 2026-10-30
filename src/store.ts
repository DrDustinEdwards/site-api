// What the package keeps for itself on a site that gives it a store (v0.15.0): the answers to writes, so a retry under
// the same change id is answered rather than run twice. A D1 site passes `d1SiteApiStore(env.DB)` as `store` and adds
// `SITE_API_STORE_SQL` as its next migration. Exported as `@dustinedwards/site-api/store`.

import type { D1Like } from "./schedules.js";

/** One write as the store holds it: claimed and running, or done with the answer it gave. */
export interface StoredWrite {
  route: string;
  requestHash: string;
  state: "running" | "done";
  status: number | null;
  response: string | null;
}

export interface SiteApiStore {
  /**
   * Claims a change id for a write about to run. Answers null when the claim is this request's: the id was free, or its
   * earlier claim was the same request and is still `running` from before `staleBefore`, so that request died before it
   * answered. Otherwise answers the row that holds the id, and claims nothing.
   */
  claimWrite(changeId: string, claim: { route: string; requestHash: string; at: string; staleBefore: string }): Promise<StoredWrite | null>;
  /** Keeps the answer the write gave, for every retry of it. */
  finishWrite(changeId: string, answer: { status: number; response: string }): Promise<void>;
  /** Drops a claim whose write failed, so a retry runs it again. */
  releaseWrite(changeId: string): Promise<void>;
  /** Drops every write claimed before `before`. */
  pruneWrites(before: string): Promise<void>;
}

/** The migration: a D1 site adds it as its next file under `migrations/`. Every time is UTC ISO text. */
export const SITE_API_STORE_SQL = `CREATE TABLE IF NOT EXISTS site_api_writes (
  change_id TEXT PRIMARY KEY,
  route TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status INTEGER,
  response TEXT,
  state TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS site_api_writes_at ON site_api_writes (at);
`;

interface WriteRow {
  route: string;
  request_hash: string;
  state: "running" | "done";
  status: number | null;
  response: string | null;
}

export function d1SiteApiStore(db: D1Like): SiteApiStore {
  const claimWrite: SiteApiStore["claimWrite"] = async (changeId, claim) => {
    // One statement, so two requests racing for an id cannot both win: the insert, or the takeover of the same
    // request's stale claim, returns the row only when it was this request's.
    const won = await db
      .prepare(
        `INSERT INTO site_api_writes (change_id, route, request_hash, status, response, state, at) VALUES (?, ?, ?, NULL, NULL, 'running', ?)
         ON CONFLICT (change_id) DO UPDATE SET at = excluded.at
         WHERE site_api_writes.state = 'running' AND site_api_writes.at < ?
           AND site_api_writes.route = excluded.route AND site_api_writes.request_hash = excluded.request_hash
         RETURNING change_id`,
      )
      .bind(changeId, claim.route, claim.requestHash, claim.at, claim.staleBefore)
      .first();
    if (won) return null;
    const row = await db.prepare("SELECT route, request_hash, state, status, response FROM site_api_writes WHERE change_id = ?").bind(changeId).first<WriteRow>();
    // Released between the two statements: the id is free again, so claim it once more.
    if (!row) return claimWrite(changeId, claim);
    return { route: row.route, requestHash: row.request_hash, state: row.state, status: row.status, response: row.response };
  };

  return {
    claimWrite,
    async finishWrite(changeId, answer) {
      await db.prepare("UPDATE site_api_writes SET state = 'done', status = ?, response = ? WHERE change_id = ?").bind(answer.status, answer.response, changeId).run();
    },
    async releaseWrite(changeId) {
      await db.prepare("DELETE FROM site_api_writes WHERE change_id = ? AND state = 'running'").bind(changeId).run();
    },
    async pruneWrites(before) {
      await db.prepare("DELETE FROM site_api_writes WHERE at < ?").bind(before).run();
    },
  };
}
