// The site side: one handler for everything under /api/carrel/v1.
//
// Order is the guard: prefix, then rate limit, then key, then route. A request outside the prefix
// is never served, whatever key it carries; a request without the key learns nothing about routes.

import { safeEqual } from "@dustinedwards/site-runtime/compare";

import type { DueSchedule, SiteAdapter } from "./adapter.js";
import { PREFIX } from "./contract.js";
import { runHooks, type PublishAction, type PublishHook } from "./hooks.js";
import { contentRoutes } from "./server/content.js";
import { describeFailure, fail, type Route } from "./server/http.js";
import { mediaRoutes } from "./server/media.js";
import { mentionsRoutes } from "./server/mentions.js";

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
   * a hook that fails is logged, never answered, and the write stands.
   */
  hooks?: PublishHook[];
  /**
   * @deprecated v0.14.0: pass `hooks: [indexNowHook(...)]` instead. Still served: called with the changed page's path wherever `hooks` run. For a schedule, which has no
   * request, a GET of the page on the site's origin stands in for it. New sites pass `hooks: [indexNowHook(...)]`.
   */
  onPageChange?: (paths: string[], request: Request) => Promise<unknown> | void;
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
}

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
}

export const MIN_KEY_LENGTH = 32;

export function insidePrefix(pathname: string): boolean {
  return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

// The content writes that can change a public page; a schedule changes nothing until it fires.
const PAGE_WRITE = /^\/content\/([^/]+)(?:\/(draft|publish|unpublish|tags))?$/;

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer[ ]+(\S+)\s*$/i);
  return match ? match[1]! : null;
}

export function createSiteApi(config: SiteApiConfig): SiteApi {
  const { adapter, limiter } = config;
  const log = config.log ?? ((entry) => console.warn(JSON.stringify(entry)));
  const { media, mentions } = adapter;

  const routes: Route[] = [
    ...contentRoutes(adapter),
    ...(media ? mediaRoutes(media, log) : []),
    ...(mentions ? mentionsRoutes(mentions) : []),
  ];

  // Groups a site has not implemented. Media and mentions leave this list when the adapter has them.
  const LATER = new RegExp(
    `^/(${[...(media ? [] : ["media"]), ...(mentions ? [] : ["mentions"]), "inbox", "insight", "publications"].join("|")})(/|$)`,
  );

  const { onPageChange } = config;
  const hooks: PublishHook[] = [
    ...(config.hooks ?? []),
    ...(onPageChange
      ? [{ name: "onPageChange", run: async (e: { path: string; url: string; request?: Request }) => void (await onPageChange([e.path], e.request ?? new Request(e.url))) }]
      : []),
  ];

  // Which public page a content write changed: after the write, or for a delete from what was live before it, since a
  // deleted item leaves nothing to read. A draft that was never published has no page to tell about.
  async function pageOf(id: string): Promise<{ path: string | null; live: boolean }> {
    const doc = await adapter.content.get(id).catch(() => null);
    return { path: doc?.path ?? null, live: doc?.status === "published" };
  }

  const ACTION: Record<string, PublishAction> = { publish: "publish", unpublish: "unpublish", draft: "update", tags: "update", "": "delete" };

  async function tellPageChange(id: string, route: string, before: { path: string | null; live: boolean } | null, request: Request, response: Response) {
    const page = before ?? (await pageOf(id));
    const action = ACTION[route]!;
    if (!page.path || !(page.live || action === "unpublish")) return;
    const { changeId } = (await response.json()) as { changeId?: string };
    await runHooks(hooks, { action, id, path: page.path, url: new URL(page.path, adapter.site.origin).href, trigger: "request", changeId: changeId ?? null, request }, log);
  }

  async function runSchedules(options: { now?: Date; limit?: number } = {}): Promise<ScheduleRun> {
    const run: ScheduleRun = { applied: [], skipped: 0, failed: 0, more: false };
    const { schedules } = adapter;
    if (!schedules) return run;
    const now = options.now ?? new Date();
    const limit = options.limit ?? SCHEDULE_BATCH_LIMIT;
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
        if (page.path && page.live) {
          const url = new URL(page.path, adapter.site.origin).href;
          await runHooks(hooks, { action: item.kind, id: item.id, path: page.path, url, trigger: "schedule", changeId: item.changeId }, log);
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

    try {
      const write = hooks.length > 0 && request.method !== "GET" ? PAGE_WRITE.exec(path) : null;
      const id = write ? decodeURIComponent(write[1]!) : "";
      const before = write && request.method === "DELETE" ? await pageOf(id) : null;
      const response = await hit.route.run(hit.match, url, request);
      if (write && response.ok) {
        const told = tellPageChange(id, write[2] ?? "", before, request, response.clone()).catch((error) => log({ siteApi: "page-change-failed", error: String(error) }));
        if (ctx) ctx.waitUntil(told);
        else await told;
      }
      return response;
    } catch (error) {
      const failure = describeFailure(error, log);
      return fail(failure.code, failure.message, {
        ...(failure.currentVersion !== undefined ? { currentVersion: failure.currentVersion } : {}),
        ...(failure.usedBy ? { usedBy: failure.usedBy } : {}),
      });
    }
  }

  return {
    matches: (request) => insidePrefix(new URL(request.url).pathname),
    handle,
    runSchedules,
  };
}
