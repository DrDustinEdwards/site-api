// The configuration a site hands createSiteApi, and the handle it gets back.

import { type DueSchedule, type SiteAdapter } from "../adapter.js";
import { type PublishHook } from "../hooks.js";
import type { SiteApiStore } from "../store.js";

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
  /** Where refusals and adapter failures are logged. Defaults to `siteApiLog`: site-runtime's scrubbed logger, a refused request named in the OWASP vocabulary. */
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
   * Where the package keeps what it needs between requests (v0.17.0): on D1, `d1SiteApiStore(env.DB)` from
   * `@dustinedwards/site-api/store`, with `SITE_API_STORE_SQL` as a migration. With it, every write is safe to retry
   * under its change id (capabilities.replay). Absent: nothing is kept between requests.
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
  /**
   * `runSchedules` for a cron's job: the same pass, and it throws when a schedule failed, so the job is reported as failed
   * and the schedule is listed again next pass. Returns the run when none failed.
   */
  runSchedulesOrThrow(options?: { now?: Date; limit?: number }): Promise<ScheduleRun>;
  /** v0.17.0: true for a GET (v0.22.0: or a HEAD) under PREVIEW_LINK_PATH, outside the prefix. Mount `servePreviewLink` where this holds. */
  matchesPreviewLink(request: Request): boolean;
  /**
   * Serves a shareable preview link with no key (v0.17.0): the item's current source through the site's preview, never
   * indexed, cached or sent on as a referrer. An expired link answers 410; a revoked one (v0.22.0) and any other 404, and a
   * site with no store answers every link 404. A HEAD gets the GET's status and headers, no body. Rate limited like the API.
   */
  servePreviewLink(request: Request): Promise<Response>;
}
