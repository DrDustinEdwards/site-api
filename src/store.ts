// What the package keeps for itself on a site that gives it a store (v0.17.0): the answers to writes, so a retry under
// the same change id is answered rather than run twice, the publish hooks that failed, so the cron tries them again, and
// the shareable preview links and the webmentions each page last sent. A D1 site passes `d1SiteApiStore(env.DB)` as `store` and adds
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
  /** Keeps a failed hook's event for a retry at `nextAt`, replacing the row with the same id. */
  putHookRetry(retry: HookRetry): Promise<void>;
  /** The retries due at `now`, the oldest due first, at most `limit`. */
  dueHookRetries(now: string, limit: number): Promise<HookRetry[]>;
  dropHookRetry(id: string): Promise<void>;
  /** Keeps a new preview link: only the SHA-256 of its token, never the token. */
  putPreviewLink(link: PreviewLinkRow): Promise<void>;
  /** The link whose token has this hash, revoked or expired included; null when none. */
  previewLink(tokenHash: string): Promise<PreviewLinkRow | null>;
  /** One item's links not revoked and not expired at `now`, the newest first. */
  activePreviewLinks(contentId: string, now: string): Promise<PreviewLinkRow[]>;
  /** Revokes the unrevoked link whose hash starts with `prefix` (its id); false when none. */
  revokePreviewLink(prefix: string, at: string): Promise<boolean>;
  /** The targets the webmention hook last sent for a source page (v0.17.0); [] when none. */
  webmentionTargets(source: string): Promise<string[]>;
  /** Replaces a source's targets with the ones it links to now, and drops the row when there are none. */
  putWebmentionTargets(source: string, targets: string[], sentAt: string): Promise<void>;
  // ---------- v0.19.0, optional so a site's own store from v0.17.0 still fits; d1SiteApiStore has them all
  /** Keeps a tombstone for a path whose live item was deleted or trashed, so the site answers it 410 (goneResponse). */
  markGone?(path: string, at: string): Promise<void>;
  /** Drops the tombstone: something is live at the path again. */
  clearGone?(path: string): Promise<void>;
  /** True when the path holds a tombstone. A site calls it from its not-found handler. */
  isGone?(path: string): Promise<boolean>;
  /** Keeps one publish hook's run under its change id, for `GET /hooks/recent`. */
  putHookRun?(run: { changeId: string; hook: string; ok: boolean; at: string }): Promise<void>;
  /** The hook runs kept under a change id, the oldest first. */
  hookRuns?(changeId: string): Promise<Array<{ hook: string; ok: boolean; at: string }>>;
  /** Drops every hook run kept before `before`. */
  pruneHookRuns?(before: string): Promise<void>;
}

/** The D1 store, with every method of v0.19.0. */
export type D1SiteApiStore = Required<SiteApiStore>;

/**
 * A path as a tombstone keys it: no query or fragment, and no trailing slash but the root's, so /blog/a/ and /blog/a are
 * one page.
 */
export function gonePath(path: string): string {
  const bare = path.split(/[?#]/)[0] || "/";
  return bare.length > 1 ? bare.replace(/\/+$/, "") || "/" : bare;
}

/**
 * The answer for a path that holds a tombstone (v0.19.0, F5): 410 Gone, never cached, never indexed. problem+json when
 * the request asks for JSON over HTML, a small HTML page otherwise. A site's not-found handler answers it when
 * `store.isGone(url.pathname)`:
 *
 *     if (await store.isGone(url.pathname)) return goneResponse(request);
 */
export function goneResponse(request?: Request): Response {
  const headers = { "cache-control": "no-store", "x-robots-tag": "noindex", "x-content-type-options": "nosniff" };
  const accept = request?.headers.get("accept") ?? "";
  const wantsJson = /application\/(problem\+)?json/i.test(accept) && !/text\/html/i.test(accept);
  if (request?.method === "HEAD") return new Response(null, { status: 410, headers: { ...headers, "content-type": wantsJson ? "application/problem+json; charset=utf-8" : "text/html; charset=utf-8" } });
  if (wantsJson) {
    const body = { type: "https://github.com/DrDustinEdwards/site-api/blob/main/README.md#gone", title: "Gone", status: 410, detail: "This page was removed." };
    return new Response(JSON.stringify(body), { status: 410, headers: { ...headers, "content-type": "application/problem+json; charset=utf-8" } });
  }
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Gone</title></head><body><h1>Gone</h1><p>This page was removed.</p></body></html>`;
  return new Response(html, { status: 410, headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
}

/** One shareable preview link (v0.17.0). Times are UTC ISO text; `revokedAt` null while it works. */
export interface PreviewLinkRow {
  tokenHash: string;
  contentId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  changeId: string;
}

/** One failed hook run, kept for another try. `event` is the PublishEvent as JSON, without its request. */
export interface HookRetry {
  id: string;
  hook: string;
  event: string;
  attempts: number;
  nextAt: string;
  lastError: string;
}

/**
 * v0.19.0's tables, additive: a site that applied SITE_API_STORE_SQL before v0.19.0 adds this as its next migration
 * (SITE_API_STORE_SQL holds it too, for a new site). `gone_paths` keeps the tombstones, `hook_runs` each hook's run.
 */
export const SITE_API_STORE_SQL_V0_19 = `CREATE TABLE IF NOT EXISTS gone_paths (
  path TEXT PRIMARY KEY,
  gone_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hook_runs (
  change_id TEXT NOT NULL,
  hook TEXT NOT NULL,
  ok INTEGER NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS hook_runs_change ON hook_runs (change_id);
CREATE INDEX IF NOT EXISTS hook_runs_at ON hook_runs (at);
`;

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
CREATE TABLE IF NOT EXISTS hook_retries (
  id TEXT PRIMARY KEY,
  hook TEXT NOT NULL,
  event TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  next_at TEXT NOT NULL,
  last_error TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS hook_retries_due ON hook_retries (next_at);
CREATE TABLE IF NOT EXISTS preview_links (
  token_hash TEXT PRIMARY KEY,
  content_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  change_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS preview_links_content ON preview_links (content_id, expires_at);
CREATE TABLE IF NOT EXISTS webmention_targets (
  source TEXT PRIMARY KEY,
  targets TEXT NOT NULL,
  sent_at TEXT NOT NULL
);
${SITE_API_STORE_SQL_V0_19}`;

interface WriteRow {
  route: string;
  request_hash: string;
  state: "running" | "done";
  status: number | null;
  response: string | null;
}

interface LinkRow {
  token_hash: string;
  content_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  change_id: string;
}

const toLink = (r: LinkRow): PreviewLinkRow => ({
  tokenHash: r.token_hash,
  contentId: r.content_id,
  createdAt: r.created_at,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at,
  changeId: r.change_id,
});

export function d1SiteApiStore(db: D1Like): D1SiteApiStore {
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
    async putHookRetry(r) {
      await db
        .prepare(
          `INSERT INTO hook_retries (id, hook, event, attempts, next_at, last_error) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET attempts = excluded.attempts, next_at = excluded.next_at, last_error = excluded.last_error`,
        )
        .bind(r.id, r.hook, r.event, r.attempts, r.nextAt, r.lastError)
        .run();
    },
    async dueHookRetries(now, limit) {
      const { results } = await db
        .prepare("SELECT id, hook, event, attempts, next_at, last_error FROM hook_retries WHERE next_at <= ? ORDER BY next_at, id LIMIT ?")
        .bind(now, limit)
        .all<{ id: string; hook: string; event: string; attempts: number; next_at: string; last_error: string }>();
      return results.map((r) => ({ id: r.id, hook: r.hook, event: r.event, attempts: r.attempts, nextAt: r.next_at, lastError: r.last_error }));
    },
    async dropHookRetry(id) {
      await db.prepare("DELETE FROM hook_retries WHERE id = ?").bind(id).run();
    },
    async putPreviewLink(l) {
      await db
        .prepare("INSERT INTO preview_links (token_hash, content_id, created_at, expires_at, revoked_at, change_id) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(l.tokenHash, l.contentId, l.createdAt, l.expiresAt, l.revokedAt, l.changeId)
        .run();
    },
    async previewLink(tokenHash) {
      const row = await db.prepare("SELECT * FROM preview_links WHERE token_hash = ?").bind(tokenHash).first<LinkRow>();
      return row ? toLink(row) : null;
    },
    async activePreviewLinks(contentId, now) {
      const { results } = await db
        .prepare("SELECT * FROM preview_links WHERE content_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC")
        .bind(contentId, now)
        .all<LinkRow>();
      return results.map(toLink);
    },
    async revokePreviewLink(prefix, at) {
      // The prefix is hex the package checked, so it is safe inside LIKE.
      const row = await db
        .prepare("UPDATE preview_links SET revoked_at = ? WHERE token_hash LIKE ? AND revoked_at IS NULL RETURNING token_hash")
        .bind(at, `${prefix}%`)
        .first();
      return row !== null;
    },
    async webmentionTargets(source) {
      const row = await db.prepare("SELECT targets FROM webmention_targets WHERE source = ?").bind(source).first<{ targets: string }>();
      return row ? (JSON.parse(row.targets) as string[]) : [];
    },
    async putWebmentionTargets(source, targets, sentAt) {
      await (targets.length === 0
        ? db.prepare("DELETE FROM webmention_targets WHERE source = ?").bind(source)
        : db
            .prepare("INSERT INTO webmention_targets (source, targets, sent_at) VALUES (?, ?, ?) ON CONFLICT (source) DO UPDATE SET targets = excluded.targets, sent_at = excluded.sent_at")
            .bind(source, JSON.stringify(targets), sentAt)
      ).run();
    },
    async markGone(path, at) {
      await db.prepare("INSERT INTO gone_paths (path, gone_at) VALUES (?, ?) ON CONFLICT (path) DO UPDATE SET gone_at = excluded.gone_at").bind(gonePath(path), at).run();
    },
    async clearGone(path) {
      await db.prepare("DELETE FROM gone_paths WHERE path = ?").bind(gonePath(path)).run();
    },
    async isGone(path) {
      // A not-found page must never fail on the store: a site that has not run the v0.19.0 migration yet answers 404.
      try {
        return (await db.prepare("SELECT 1 AS gone FROM gone_paths WHERE path = ?").bind(gonePath(path)).first()) !== null;
      } catch (error) {
        console.warn(JSON.stringify({ siteApi: "gone-check-failed", error: String(error) }));
        return false;
      }
    },
    async putHookRun(r) {
      await db.prepare("INSERT INTO hook_runs (change_id, hook, ok, at) VALUES (?, ?, ?, ?)").bind(r.changeId, r.hook, r.ok ? 1 : 0, r.at).run();
    },
    async hookRuns(changeId) {
      const { results } = await db.prepare("SELECT hook, ok, at FROM hook_runs WHERE change_id = ? ORDER BY at, hook").bind(changeId).all<{ hook: string; ok: number; at: string }>();
      return results.map((r) => ({ hook: r.hook, ok: r.ok === 1, at: r.at }));
    },
    async pruneHookRuns(before) {
      await db.prepare("DELETE FROM hook_runs WHERE at < ?").bind(before).run();
    },
  };
}
