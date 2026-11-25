// The site side: one handler for everything under /api/carrel/v1.
//
// Order is the guard: prefix, then rate limit, then key, then route. A request outside the prefix
// is never served, whatever key it carries; a request without the key learns nothing about routes.

import { jsonResponse } from "@dustinedwards/site-runtime/http";
import { safeEqual } from "@dustinedwards/site-runtime/compare";
import { isDatabaseDown } from "@dustinedwards/site-runtime/log";

import { hasContentTrash, type DueSchedule } from "./adapter.js";
import { PREFIX } from "./contract.js";
import { Timestamp } from "./contract/base.js";
import type { ContentSummary } from "./contract.js";
import { hears, runHooks, type PublishEvent, type PublishHook } from "./hooks.js";
import {
  ACTION,
  HOOK_BACKOFF_MINUTES,
  MINUTE,
  PAGE_WRITE,
  bearer,
  keepTombstones,
  pageEvent,
  type Page,
} from "./server/events.js";
import { contentRoutes } from "./server/content.js";
import { HookRunList, HookRunsQuery } from "./contract.js";
import {
  BASE_HEADERS,
  describeFailure,
  fail,
  checked,
  MAX_BODY_BYTES,
  readQuery,
  refuseAnyQuery,
  type Route,
} from "./server/http.js";
import { insightRoutes } from "./server/insight.js";
import { mediaRoutes } from "./server/media.js";
import { mentionsRoutes } from "./server/mentions.js";
import {
  page,
  PREVIEW_LINK_PATH,
  previewLinkRoutes,
  servePreviewLink,
} from "./server/preview-links.js";
import { pruneStore } from "./server/prune.js";
import { claim, REPLAYED } from "./server/replay.js";
import { siteApiLog } from "./log.js";

export type {
  D1SiteApiStore,
  HookRetry,
  PreviewLinkRow,
  SiteApiStore,
  StoredWrite,
} from "./store.js";
export { tombstoneResponse, gonePath, tombstoned } from "./store.js";
export { PREVIEW_LINK_PATH } from "./server/preview-links.js";

import {
  SCHEDULE_BATCH_LIMIT,
  TRASH_DAYS,
  type ScheduleRun,
  type SiteApi,
  type SiteApiConfig,
  type WaitUntil,
} from "./server/config.js";

export * from "./server/config.js";
export { HOOK_BACKOFF_MINUTES } from "./server/events.js";

export const MIN_KEY_LENGTH = 32;

const DAY = 24 * 60 * 60 * 1000;

/** True for a request the site API or a preview link answers (or refuses): the only ones that need it built. */
export function isSiteApiRequest(url: URL): boolean {
  return insidePrefix(url.pathname) || url.pathname.startsWith(PREVIEW_LINK_PATH);
}

export function insidePrefix(pathname: string): boolean {
  return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

export function createSiteApi(config: SiteApiConfig): SiteApi {
  const { adapter, limiter } = config;
  const log = config.log ?? siteApiLog;
  const { media, mentions, insight } = adapter;
  const { store } = config;

  const hooks: PublishHook[] = config.hooks ?? [];
  // The hooks a publish of a live page runs, by name, for capabilities.hooks and the conformance probe.
  const probe: PublishEvent = {
    action: "publish",
    id: "",
    path: "/",
    url: adapter.site.origin,
    trigger: "request",
    changeId: null,
    status: "published",
  };
  const publishHooks = hooks.filter((h) => hears(h, probe)).map((h) => h.name);

  const hookRuns: Route[] = store?.hookRuns
    ? [
        {
          method: "GET",
          query: true,
          pattern: /^\/hooks\/recent$/,
          run: async (_m, url) => {
            const { changeId } = readQuery(url, HookRunsQuery);
            return jsonResponse(
              checked(HookRunList, { items: await store.hookRuns!(changeId) }, "hook runs"),
              200,
              BASE_HEADERS,
            );
          },
        },
      ]
    : [];

  const routes: Route[] = [
    ...contentRoutes(adapter, { store: Boolean(store), hooks: publishHooks }),
    ...hookRuns,
    ...(media ? mediaRoutes(media, log, store) : []),
    ...(mentions ? mentionsRoutes(mentions) : []),
    ...(store ? previewLinkRoutes(adapter, store) : []),
    ...(insight ? insightRoutes(insight) : []),
  ];

  // Groups a site has not implemented. Media, mentions and insight leave this list when the adapter has them, preview
  // links when the site has a store.
  const LATER = new RegExp(
    `^/(${[...(media ? [] : ["media"]), ...(mentions ? [] : ["mentions"]), ...(insight ? [] : ["insight"]), ...(store ? [] : ["preview-links"]), ...(hookRuns.length ? [] : ["hooks"]), "inbox", "publications"].join("|")})(/|$)`,
  );

  // The item's public path and status, read before a write and after it. A draft that was never published has no page.
  async function pageOf(id: string): Promise<Page> {
    const doc = await adapter.content.get(id).catch(() => null);
    return { path: doc?.path ?? null, status: doc?.status ?? null };
  }

  // A hook that fails is kept for the cron to try again, where the site has a store.
  // Each run is kept under its change id, where the store keeps hook runs, for `GET /hooks/recent`.
  const tell = (event: PublishEvent) =>
    runHooks(
      hooks,
      event,
      log,
      async (hook, error) => {
        if (!store) return;
        const { request: _r, ...kept } = event;
        const nextAt = new Date(Date.now() + HOOK_BACKOFF_MINUTES[0]! * MINUTE).toISOString();
        await store.putHookRetry({
          id: crypto.randomUUID(),
          hook: hook.name,
          event: JSON.stringify(kept),
          attempts: 1,
          nextAt,
          lastError: error,
        });
      },
      async (hook, ok) => {
        if (store?.putHookRun && event.changeId)
          await store.putHookRun({
            changeId: event.changeId,
            hook: hook.name,
            ok,
            at: new Date().toISOString(),
          });
      },
    );

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
            if ((await hook.run(JSON.parse(retry.event) as PublishEvent)) === false)
              error = "the hook reported a failure";
          } catch (thrown) {
            error = thrown instanceof Error ? thrown.message : String(thrown);
          }
        }
        const wait = HOOK_BACKOFF_MINUTES[retry.attempts];
        if (error === null || wait === undefined || !hook) {
          if (error !== null)
            log({ siteApi: "hook-gave-up", hook: retry.hook, attempts: retry.attempts, error });
          await store.dropHookRetry(retry.id);
        } else {
          await store.putHookRetry({
            ...retry,
            attempts: retry.attempts + 1,
            nextAt: new Date(now.getTime() + wait * MINUTE).toISOString(),
            lastError: error,
          });
        }
      }
    } catch (error) {
      log({ siteApi: "hook-retry-failed", error: String(error) });
    }
    return retried;
  }

  // The content trash's own end: items trashed more than TRASH_DAYS ago go for good, through the adapter's
  // delete with the version listed, so one changed since is refused and left. Each on its own, like a schedule.
  async function emptyTrash(now: Date, limit: number): Promise<number> {
    const { content } = adapter;
    if (!hasContentTrash(adapter)) return 0;
    const before = now.getTime() - TRASH_DAYS * DAY;
    let emptied = 0;
    try {
      // Gathered before any delete: a cursor into a list that is shrinking would skip items.
      const expired: ContentSummary[] = [];
      let cursor: string | undefined;
      do {
        const page = await content.list({
          trashed: true,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        for (const item of page.items) {
          // Only a contract timestamp past 30 days deletes: Date.parse reads "1 Oct" as 2001, so it is never asked alone.
          if (Timestamp.safeParse(item.trashedAt).success && Date.parse(item.trashedAt!) <= before)
            expired.push(item);
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      for (const item of expired) {
        if (emptied >= limit) return emptied;
        if (!item.version) {
          log({ siteApi: "trash-empty-skipped", id: item.id, reason: "the list gives no version" });
          continue;
        }
        const changeId = `trash-expired-${item.id}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 128);
        try {
          await content.delete!(item.id, { expectedVersion: item.version, changeId });
          emptied++;
        } catch (error) {
          log({
            siteApi: "trash-empty-failed",
            id: item.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      log({ siteApi: "trash-empty-failed", error: String(error) });
    }
    return emptied;
  }

  // What each run's failed schedules threw, so runSchedulesOrThrow can tell a database that was down from a real fault.
  const failures = new WeakMap<ScheduleRun, unknown[]>();

  async function runSchedules(options: { now?: Date; limit?: number } = {}): Promise<ScheduleRun> {
    const errors: unknown[] = [];
    const run: ScheduleRun = {
      applied: [],
      skipped: 0,
      failed: 0,
      more: false,
      emptied: 0,
      retried: 0,
    };
    const now = options.now ?? new Date();
    if (store) await pruneStore(store, now, log);
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
      const failed = { ...run, failed: 1 };
      failures.set(failed, [error]);
      return failed;
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
        if (item.kind === "publish")
          await keepTombstones(store, log, "publish", { path: null, status: "scheduled" }, page);
        if (page.path && page.status === "published") {
          const url = new URL(page.path, adapter.site.origin).href;
          const previousStatus = item.kind === "publish" ? "scheduled" : "published";
          await tell({
            action: item.kind,
            id: item.id,
            path: page.path,
            url,
            trigger: "schedule",
            changeId: item.changeId,
            previousStatus,
            status: "published",
          });
        }
      } catch (error) {
        run.failed++;
        errors.push(error);
        log({
          siteApi: "schedule-failed",
          id: item.id,
          kind: item.kind,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    run.more = due.length >= limit;
    failures.set(run, errors);
    return run;
  }

  async function handle(request: Request, ctx?: WaitUntil): Promise<Response> {
    const url = new URL(request.url);
    // The URL parser has already resolved dot segments, so /api/carrel/v1/../admin arrives as /admin.
    if (!insidePrefix(url.pathname)) return fail("not-found", "Not found.");

    // The key is checked before the limit so the limit can follow the caller, not its address. A Worker's subrequest
    // from another zone carries CF-Connecting-IP 2a06:98c0:3600::103, the same for every Worker on Cloudflare
    // (developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip-in-worker-subrequests), and
    // the Rate Limiting docs advise an API key over an IP (workers/runtime-apis/bindings/rate-limit/#best-practices).
    // So the key holder has its own counter and only a request without the key is counted by its address.
    const expected = config.key?.trim() ?? "";
    const presented = bearer(request);
    const holdsKey =
      expected.length >= MIN_KEY_LENGTH &&
      presented !== null &&
      (await safeEqual(presented, expected));
    try {
      const key = holdsKey
        ? "site-key"
        : `ip:${request.headers.get("cf-connecting-ip") ?? "unknown"}`;
      if (!(await limiter.limit({ key })).success) {
        log({ siteApi: "refused", reason: "rate-limited" });
        return fail("rate-limited", "Too many requests.");
      }
    } catch (error) {
      log({ siteApi: "refused", reason: "limiter-failed", error: String(error) });
      return fail("unavailable", "The site API is unavailable.");
    }

    if (expected.length < MIN_KEY_LENGTH) {
      log({ siteApi: "refused", reason: "not-configured" });
      return fail("not-configured", "The site API is not configured.");
    }
    if (!holdsKey) {
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

    // A route that takes no query refuses one, before anything runs.
    if (!hit.route.query) {
      try {
        refuseAnyQuery(url);
      } catch (error) {
        const failure = describeFailure(error, log);
        return fail(
          failure.code,
          failure.message,
          failure.field !== undefined ? { field: failure.field } : {},
        );
      }
    }

    const write =
      (hooks.length > 0 || store?.markGone) && request.method !== "GET"
        ? PAGE_WRITE.exec(path)
        : null;
    // A malformed escape in the id is the route's to refuse (400 invalid); decoding it here would throw out of the handler.
    let id = "";
    try {
      id = write ? decodeURIComponent(write[1]!) : "";
    } catch {
      id = "";
    }
    const action = write && id ? ACTION[`${request.method} ${write[2] ?? ""}`] : undefined;
    let finish: ((response: Response) => Promise<void>) | undefined;
    let response: Response;
    try {
      let run = request;
      if (store && request.method !== "GET" && REPLAYED.test(path)) {
        const claimed = await claim(
          store,
          request,
          path,
          Math.max(MAX_BODY_BYTES, media?.limits.maxBytes ?? 0),
          log,
        );
        // A replayed answer has run its hooks already, the first time.
        if ("answer" in claimed) return claimed.answer;
        ({ request: run, finish } = claimed);
      }
      const before = action ? await pageOf(id) : null;
      response = await hit.route.run(hit.match, url, run);
      if (action && before && response.ok) {
        // A rename answers the item under its new id.
        const written = (await response.clone().json()) as { id?: string; changeId?: string };
        const now = written.id ?? id;
        const after = action === "delete" ? null : await pageOf(now);
        // The tombstone is part of the write, so a 404 handler asked the moment it answers already says 410.
        await keepTombstones(store, log, action, before, after);
        const event = pageEvent(adapter.site.origin, now, action, before, after, written, request);
        if (event && hooks.length > 0) {
          const told = tell(event).catch((error) =>
            log({ siteApi: "page-change-failed", error: String(error) }),
          );
          if (ctx) ctx.waitUntil(told);
          else await told;
        }
      }
    } catch (error) {
      const failure = describeFailure(error, log);
      response = fail(failure.code, failure.message, {
        ...(failure.currentVersion !== undefined ? { currentVersion: failure.currentVersion } : {}),
        ...(failure.usedBy ? { usedBy: failure.usedBy } : {}),
        ...(failure.field !== undefined ? { field: failure.field } : {}),
      });
    }
    await finish?.(response);
    return response;
  }

  async function servePreview(request: Request): Promise<Response> {
    try {
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      if (!(await limiter.limit({ key: `ip:${ip}` })).success)
        return page(429, "Too many requests.");
      const answer = await servePreviewLink(adapter, store, new URL(request.url).pathname);
      return request.method === "HEAD"
        ? new Response(null, { status: answer.status, headers: answer.headers })
        : answer;
    } catch (error) {
      log({
        siteApi: "preview-link-failed",
        error: error instanceof Error ? error.message : String(error),
      });
      return page(503, "This preview is unavailable.");
    }
  }

  return {
    matches: (request) => insidePrefix(new URL(request.url).pathname),
    handle,
    runSchedules,
    async runSchedulesOrThrow(options) {
      const run = await runSchedules(options);
      if (run.failed > 0) {
        const errors = failures.get(run) ?? [];
        // When every failure was the database being down, the cause carries its message, so site-runtime's runJobs
        // records the job failed for /health as a warning, not an error report; each schedule is tried again next pass.
        const down = errors.length === run.failed && errors.every(isDatabaseDown);
        throw new Error(
          `${run.failed} site API schedule(s) failed`,
          down ? { cause: errors[0] } : undefined,
        );
      }
      return run;
    },
    // HEAD as well, so a link checker's HEAD meets the same noindex answer as a browser's GET.
    matchesPreviewLink: (request) =>
      (request.method === "GET" || request.method === "HEAD") &&
      new URL(request.url).pathname.startsWith(PREVIEW_LINK_PATH),
    servePreviewLink: servePreview,
  };
}
