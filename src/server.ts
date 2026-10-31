// The site side: one handler for everything under /api/carrel/v1.
//
// Order is the guard: prefix, then rate limit, then key, then route. A request outside the prefix
// is never served, whatever key it carries; a request without the key learns nothing about routes.

import { safeEqual } from "@dustinedwards/site-runtime/compare";

import { hasContentTrash, type DueSchedule, type SiteAdapter } from "./adapter.js";
import { PREFIX } from "./contract.js";
import { Timestamp } from "./contract/base.js";
import type { ContentStatus } from "./contract.js";
import { runHooks, type PublishAction, type PublishEvent, type PublishHook } from "./hooks.js";
import { contentRoutes } from "./server/content.js";
import { describeFailure, fail, MAX_BODY_BYTES, type Route } from "./server/http.js";
import { insightRoutes } from "./server/insight.js";
import { mediaRoutes } from "./server/media.js";
import { mentionsRoutes } from "./server/mentions.js";
import { page, PREVIEW_LINK_PATH, previewLinkRoutes, servePreviewLink } from "./server/preview-links.js";
import { claim, REPLAY_DAYS, REPLAYED } from "./server/replay.js";
import type { SiteApiStore } from "./store.js";

export type { HookRetry, PreviewLinkRow, SiteApiStore, StoredWrite } from "./store.js";
export { PREVIEW_LINK_PATH } from "./server/preview-links.js";

/** The shape of Cloudflare's `ratelimit` binding, so a site passes its binding straight in. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * The secrets a site holds for the API (v0.14.0), for its Env: `CARREL_SITE_KEY`, set with `wrangler secret put
 * CARREL_SITE_KEY` and passed to `createSiteApi` as `key`.
 */
export interface SiteApiSecrets {
  CARREL_SITE_KEY: string;
}

export interface SiteApiConfig {
  adapter: SiteAdapter;
  /** The site's Carrel key, from its secrets. Shorter than 32 characters refuses every request. */
  key: string | undefined;
  limiter: RateLimiter;
  /** Where refusals and adapter failures are logged. Defaults to console. */
  log?: (entry: Record<string, unknown>) => void;
  /**
   * Run when a public page changes (v0.10.0): a publish, an unpublish, a delete of a live item, a save or tag change to
   * a live item, and each schedule `runSchedules` applies. The first is `indexNowHook`, over Prelum's `submitIndexNow`.
   * After a request they run under its `waitUntil` when `handle` is given one, so Carrel's answer never waits on them;
   * a hook that fails is logged, never answered, and the write stands. v0.17.0: a hook may name the actions it hears
   * (`on`), and with a `store` a failed one is kept and `runSchedules` runs it again (HOOK_BACKOFF_MINUTES).
   */
  hooks?: PublishHook[];
  /**
   * @deprecated v0.14.0: pass `hooks: [indexNowHook(...)]` instead. Still served: called with the changed page's path wherever `hooks` run. For a schedule, which has no
   * request, a GET of the page on the site's origin stands in for it. New sites pass `hooks: [indexNowHook(...)]`.
   */
  onPageChange?: (paths: string[], request: Request) => Promise<unknown> | void;
  /**
   * Where the package keeps what it needs between requests (v0.17.0): on D1, `d1SiteApiStore(env.DB)` from
   * `@dustinedwards/site-api/store`, with `SITE_API_STORE_SQL` as a migration. With it, every write is safe to retry
   * under its change id (capabilities.replay). Absent: everything works as in v0.14.0.
   */
  store?: SiteApiStore;
}

/** What one `runSchedules` pass did. */
export interface ScheduleRun {
  applied: Array<DueSchedule & { version: string }>;
  /** Due when listed, but canceled, rescheduled or unpublished before it ran: left as the site holds it. */
  skipped: number;
  /** Threw: logged, and listed again on the next pass. */
  failed: number;
  /** The pass hit its limit, so more may be due now. */
  more: boolean;
  /** v0.17.0: items deleted for good from the content trash, TRASH_DAYS after they went there. */
  emptied: number;
  /** v0.17.0: failed publish hooks run again, where the site has a store. */
  retried: number;
}

/** How long an item stays in the content trash (v0.17.0) before `runSchedules` deletes it for good. */
export const TRASH_DAYS = 30;

/** How many schedules one pass applies at most, so a backlog drains over several passes within a Worker's limits. */
export const SCHEDULE_BATCH_LIMIT = 50;

/** The part of a Worker's ExecutionContext the handler uses. */
export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

export interface SiteApi {
  /** True when the request's path is inside the prefix. Mount the handler only where this holds. */
  matches(request: Request): boolean;
  handle(request: Request, ctx?: WaitUntil): Promise<Response>;
  /**
   * Applies every schedule due at `now` (v0.10.0) and runs the hooks for each: call it from the site's cron
   * (`scheduled()`, under `ctx.waitUntil`). Safe to run as often as wanted: an applied schedule is gone, so a second
   * pass finds nothing. A site whose adapter has no `schedules` applies nothing.
   */
  runSchedules(options?: { now?: Date; limit?: number }): Promise<ScheduleRun>;
  /** v0.17.0: true for a GET under PREVIEW_LINK_PATH, outside the prefix. Mount `servePreviewLink` where this holds. */
  matchesPreviewLink(request: Request): boolean;
  /**
   * Serves a shareable preview link with no key (v0.17.0): the item's current source through the site's preview, never
   * indexed, cached or sent on as a referrer. An expired or revoked link answers 410, any other 404, and a site with no
   * store answers every link 404. Rate limited like the API.
   */
  servePreviewLink(request: Request): Promise<Response>;
}

export const MIN_KEY_LENGTH = 32;

const DAY = 24 * 60 * 60 * 1000;

export function insidePrefix(pathname: string): boolean {
  return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

// The content writes the publish hooks hear, and the action each is, by method and route.
const PAGE_WRITE = /^\/content\/([^/]+)(?:\/(draft|publish|unpublish|tags|trash|restore|rename|schedule))?$/;
const ACTION: Record<string, PublishAction> = {
  "PUT draft": "update",
  "PUT tags": "update",
  "POST publish": "publish",
  "POST unpublish": "unpublish",
  "DELETE ": "delete",
  "POST trash": "trash",
  "POST restore": "restore",
  "POST rename": "rename",
  "POST schedule": "schedule",
  "DELETE schedule": "unschedule",
};

/** How long a failed hook waits before each retry (v0.17.0), in minutes; after the last it is given up and logged. */
export const HOOK_BACKOFF_MINUTES = [1, 5, 30, 120, 720] as const;

const MINUTE = 60 * 1000;

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer[ ]+(\S+)\s*$/i);
  return match ? match[1]! : null;
}

export function createSiteApi(config: SiteApiConfig): SiteApi {
  const { adapter, limiter } = config;
  const log = config.log ?? ((entry) => console.warn(JSON.stringify(entry)));
  const { media, mentions, insight } = adapter;
  const { store } = config;

  const routes: Route[] = [
    ...contentRoutes(adapter, { store: Boolean(store) }),
    ...(media ? mediaRoutes(media, log) : []),
    ...(mentions ? mentionsRoutes(mentions) : []),
    ...(store ? previewLinkRoutes(adapter, store) : []),
    ...(insight ? insightRoutes(insight) : []),
  ];

  // Groups a site has not implemented. Media, mentions and insight leave this list when the adapter has them, preview
  // links when the site has a store.
  const LATER = new RegExp(
    `^/(${[...(media ? [] : ["media"]), ...(mentions ? [] : ["mentions"]), ...(insight ? [] : ["insight"]), ...(store ? [] : ["preview-links"]), "inbox", "publications"].join("|")})(/|$)`,
  );

  const { onPageChange } = config;
  const hooks: PublishHook[] = [
    ...(config.hooks ?? []),
    ...(onPageChange
      ? [{ name: "onPageChange", run: async (e: { path: string; url: string; request?: Request }) => void (await onPageChange([e.path], e.request ?? new Request(e.url))) }]
      : []),
  ];

  type Page = { path: string | null; status: ContentStatus | null };

  // The item's public path and status, read before a write and after it. A draft that was never published has no page.
  async function pageOf(id: string): Promise<Page> {
    const doc = await adapter.content.get(id).catch(() => null);
    return { path: doc?.path ?? null, status: doc?.status ?? null };
  }

  async function tellPageChange(id: string, action: PublishAction, before: Page, request: Request, response: Response) {
    // A rename answers the item under its new id.
    const written = (await response.json()) as { id?: string; changeId?: string };
    const now = written.id ?? id;
    const after = action === "delete" ? null : await pageOf(now);
    const path = after?.path ?? before.path;
    if (!path) return;
    const moved = action === "rename" && before.path && before.path !== path ? before.path : null;
    await tell({
      action,
      id: now,
      path,
      url: new URL(path, adapter.site.origin).href,
      trigger: "request",
      changeId: written.changeId ?? null,
      request,
      ...(before.status ? { previousStatus: before.status } : {}),
      ...(after?.status ? { status: after.status } : {}),
      ...(moved ? { previousPath: moved, previousUrl: new URL(moved, adapter.site.origin).href } : {}),
    });
  }

  // v0.17.0: a hook that fails is kept for the cron to try again, where the site has a store.
  const tell = (event: PublishEvent) =>
    runHooks(hooks, event, log, async (hook, error) => {
      if (!store) return;
      const { request: _r, ...kept } = event;
      const nextAt = new Date(Date.now() + HOOK_BACKOFF_MINUTES[0]! * MINUTE).toISOString();
      await store.putHookRetry({ id: crypto.randomUUID(), hook: hook.name, event: JSON.stringify(kept), attempts: 1, nextAt, lastError: error });
    });

  // Each kept failure is run again when due, on its own hook only, until it works or has been tried after every backoff.
  async function retryHooks(now: Date, limit: number): Promise<number> {
    if (!store) return 0;
    let retried = 0;
    try {
      for (const retry of await store.dueHookRetries(now.toISOString(), limit)) {
        retried++;
        const hook = hooks.find((h) => h.name === retry.hook);
        let error: string | null = hook ? null : "the site no longer has this hook";
        if (hook) {
          try {
            if ((await hook.run(JSON.parse(retry.event) as PublishEvent)) === false) error = "the hook reported a failure";
          } catch (thrown) {
            error = thrown instanceof Error ? thrown.message : String(thrown);
          }
        }
        const wait = HOOK_BACKOFF_MINUTES[retry.attempts];
        if (error === null || wait === undefined || !hook) {
          if (error !== null) log({ siteApi: "hook-gave-up", hook: retry.hook, attempts: retry.attempts, error });
          await store.dropHookRetry(retry.id);
        } else {
          await store.putHookRetry({ ...retry, attempts: retry.attempts + 1, nextAt: new Date(now.getTime() + wait * MINUTE).toISOString(), lastError: error });
        }
      }
    } catch (error) {
      log({ siteApi: "hook-retry-failed", error: String(error) });
    }
    return retried;
  }

  // The content trash's own end (v0.17.0): items trashed more than TRASH_DAYS ago go for good, through the adapter's
  // delete with the version listed, so one changed since is refused and left. Each on its own, like a schedule.
  async function emptyTrash(now: Date, limit: number): Promise<number> {
    const { content } = adapter;
    if (!hasContentTrash(adapter)) return 0;
    const before = now.getTime() - TRASH_DAYS * DAY;
    let emptied = 0;
    let cursor: string | undefined;
    try {
      do {
        const page = await content.list({ trashed: true, limit: 200, ...(cursor ? { cursor } : {}) });
        for (const item of page.items) {
          if (emptied >= limit) return emptied;
          // Only a contract timestamp past 30 days deletes: Date.parse reads "1 Oct" as 2001, so it is never asked alone.
          if (!Timestamp.safeParse(item.trashedAt).success || Date.parse(item.trashedAt!) > before) continue;
          if (!item.version) {
            log({ siteApi: "trash-empty-skipped", id: item.id, reason: "the list gives no version" });
            continue;
          }
          const changeId = `trash-expired-${item.id}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 128);
          try {
            await content.delete!(item.id, { expectedVersion: item.version, changeId });
            emptied++;
          } catch (error) {
            log({ siteApi: "trash-empty-failed", id: item.id, error: error instanceof Error ? error.message : String(error) });
          }
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    } catch (error) {
      log({ siteApi: "trash-empty-failed", error: String(error) });
    }
    return emptied;
  }

  async function runSchedules(options: { now?: Date; limit?: number } = {}): Promise<ScheduleRun> {
    const run: ScheduleRun = { applied: [], skipped: 0, failed: 0, more: false, emptied: 0, retried: 0 };
    const now = options.now ?? new Date();
    if (store) {
      await store.pruneWrites(new Date(now.getTime() - REPLAY_DAYS * DAY).toISOString()).catch((error) => log({ siteApi: "replay-store-failed", error: String(error) }));
    }
    const limit = options.limit ?? SCHEDULE_BATCH_LIMIT;
    run.emptied = await emptyTrash(now, limit);
    run.retried = await retryHooks(now, limit);
    const { schedules } = adapter;
    if (!schedules) return run;
    let due: DueSchedule[];
    try {
      due = await schedules.due({ now, limit });
    } catch (error) {
      log({ siteApi: "schedule-failed", error: String(error) });
      return { ...run, failed: 1 };
    }
    // One at a time and each on its own: one failing never stops the rest, and is listed again next pass.
    for (const item of due) {
      try {
        const written = await schedules.apply(item.id, { ...item, now });
        if (!written) {
          run.skipped++;
          continue;
        }
        run.applied.push({ ...item, version: written.version });
        const page = await pageOf(item.id);
        if (page.path && page.status === "published") {
          const url = new URL(page.path, adapter.site.origin).href;
          const previousStatus = item.kind === "publish" ? "scheduled" : "published";
          await tell({ action: item.kind, id: item.id, path: page.path, url, trigger: "schedule", changeId: item.changeId, previousStatus, status: "published" });
        }
      } catch (error) {
        run.failed++;
        log({ siteApi: "schedule-failed", id: item.id, kind: item.kind, error: error instanceof Error ? error.message : String(error) });
      }
    }
    run.more = due.length >= limit;
    return run;
  }

  async function handle(request: Request, ctx?: WaitUntil): Promise<Response> {
    const url = new URL(request.url);
    // The URL parser has already resolved dot segments, so /api/carrel/v1/../admin arrives as /admin.
    if (!insidePrefix(url.pathname)) return fail("not-found", "Not found.");

    try {
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      if (!(await limiter.limit({ key: ip })).success) {
        log({ siteApi: "refused", reason: "rate-limited" });
        return fail("rate-limited", "Too many requests.");
      }
    } catch (error) {
      log({ siteApi: "refused", reason: "limiter-failed", error: String(error) });
      return fail("unavailable", "The site API is unavailable.");
    }

    const expected = config.key?.trim() ?? "";
    if (expected.length < MIN_KEY_LENGTH) {
      log({ siteApi: "refused", reason: "not-configured" });
      return fail("not-configured", "The site API is not configured.");
    }
    const presented = bearer(request);
    if (!presented || !(await safeEqual(presented, expected))) {
      log({ siteApi: "refused", reason: presented ? "wrong-key" : "no-key" });
      return fail("unauthorized", "Unauthorized.");
    }

    const path = url.pathname.slice(PREFIX.length) || "/";
    if (LATER.test(path)) return fail("not-implemented", "This group arrives in a later stage.");

    const candidates = routes
      .map((route) => ({ route, match: path.match(route.pattern) }))
      .filter((c): c is { route: Route; match: RegExpMatchArray } => c.match !== null);
    if (candidates.length === 0) return fail("not-found", "No such route.");
    const hit = candidates.find((c) => c.route.method === request.method);
    if (!hit) return fail("method-not-allowed", "Method not allowed.");

    const write = hooks.length > 0 && request.method !== "GET" ? PAGE_WRITE.exec(path) : null;
    const action = write ? ACTION[`${request.method} ${write[2] ?? ""}`] : undefined;
    const id = write ? decodeURIComponent(write[1]!) : "";
    let finish: ((response: Response) => Promise<void>) | undefined;
    let response: Response;
    try {
      let run = request;
      if (store && request.method !== "GET" && REPLAYED.test(path)) {
        const claimed = await claim(store, request, path, Math.max(MAX_BODY_BYTES, media?.limits.maxBytes ?? 0), log);
        // A replayed answer has run its hooks already, the first time.
        if ("answer" in claimed) return claimed.answer;
        ({ request: run, finish } = claimed);
      }
      const before = action ? await pageOf(id) : null;
      response = await hit.route.run(hit.match, url, run);
      if (action && before && response.ok) {
        const told = tellPageChange(id, action, before, request, response.clone()).catch((error) => log({ siteApi: "page-change-failed", error: String(error) }));
        if (ctx) ctx.waitUntil(told);
        else await told;
      }
    } catch (error) {
      const failure = describeFailure(error, log);
      response = fail(failure.code, failure.message, {
        ...(failure.currentVersion !== undefined ? { currentVersion: failure.currentVersion } : {}),
        ...(failure.usedBy ? { usedBy: failure.usedBy } : {}),
      });
    }
    await finish?.(response);
    return response;
  }

  async function servePreview(request: Request): Promise<Response> {
    try {
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      if (!(await limiter.limit({ key: ip })).success) return page(429, "Too many requests.");
      return await servePreviewLink(adapter, store, new URL(request.url).pathname);
    } catch (error) {
      log({ siteApi: "preview-link-failed", error: error instanceof Error ? error.message : String(error) });
      return page(503, "This preview is unavailable.");
    }
  }

  return {
    matches: (request) => insidePrefix(new URL(request.url).pathname),
    handle,
    runSchedules,
    matchesPreviewLink: (request) => request.method === "GET" && new URL(request.url).pathname.startsWith(PREVIEW_LINK_PATH),
    servePreviewLink: servePreview,
  };
}
