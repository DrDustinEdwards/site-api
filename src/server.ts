// The site side: one handler for everything under /api/carrel/v1.
//
// Order is the guard: prefix, then rate limit, then key, then route. A request outside the prefix
// is never served, whatever key it carries; a request without the key learns nothing about routes.

import { clientIp, jsonResponse } from "@dustinedwards/site-runtime/http";
import { safeEqual } from "@dustinedwards/site-runtime/compare";
import { isDatabaseDown } from "@dustinedwards/site-runtime/log";

import type { DueSchedule } from "./adapter.js";
import { PREFIX } from "./contract.js";
import { hears, type PublishAction, type PublishEvent, type PublishHook } from "./hooks.js";
import { pageChanges, type Change } from "./server/changes.js";
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
import { emptyTrash, retryHooks } from "./server/maintenance.js";
import { pruneStore } from "./server/prune.js";
import { claim, REPLAYED } from "./server/replay.js";
import { siteApiLog } from "./log.js";
import {
  SCHEDULE_BATCH_LIMIT,
  type ScheduleRun,
  type SiteApi,
  type SiteApiConfig,
  type WaitUntil,
} from "./server/types.js";

export type {
  D1SiteApiStore,
  HookRetry,
  PreviewLinkRow,
  SiteApiStore,
  StoredWrite,
} from "./store.js";
export { tombstoneResponse, gonePath, tombstoned } from "./store.js";
export { HOOK_BACKOFF_MINUTES } from "./server/changes.js";
export { PREVIEW_LINK_PATH } from "./server/preview-links.js";

export type {
  RateLimiter,
  SiteApiSecrets,
  SiteApiConfig,
  ScheduleRun,
  WaitUntil,
  SiteApi,
} from "./server/types.js";
export { TRASH_DAYS, SCHEDULE_BATCH_LIMIT } from "./server/types.js";

export const MIN_KEY_LENGTH = 32;

/** True for a request the site API or a preview link answers (or refuses): the only ones that need it built. */
export function isSiteApiRequest(url: URL): boolean {
  return insidePrefix(url.pathname) || url.pathname.startsWith(PREVIEW_LINK_PATH);
}

export function insidePrefix(pathname: string): boolean {
  return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

// The content writes the publish hooks hear, and the action each is, by method and route.
const PAGE_WRITE =
  /^\/content\/([^/]+)(?:\/(draft|publish|unpublish|tags|trash|restore|rename|schedule))?$/;
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

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer[ ]+(\S+)\s*$/i);
  return match ? match[1]! : null;
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

  const changes = pageChanges({ adapter, store, hooks, log });

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
    run.emptied = await emptyTrash({ adapter, log }, now, limit);
    run.retried = await retryHooks({ store, hooks, log, resolve: changes.resolve }, now, limit);
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
        const change: Change = {
          id: item.id,
          action: item.kind,
          trigger: "schedule",
          changeId: item.changeId,
          before: await changes.pageOf(item.id),
        };
        const row = await changes.open(change);
        const written = await schedules.apply(item.id, { ...item, now });
        if (!written) {
          run.skipped++;
          await changes.drop(row);
          continue;
        }
        run.applied.push({ ...item, version: written.version });
        await (
          await changes.settle(row, change, await changes.pageOf(item.id))
        ).told;
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
      const key = holdsKey ? "site-key" : `ip:${clientIp(request)}`;
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
      // The change is kept before the write runs, so a Worker that dies after it leaves it for the cron to finish.
      let change: Change | null = null;
      let row: Awaited<ReturnType<typeof changes.open>> = null;
      if (action) {
        const sent = (await run
          .clone()
          .json()
          .catch(() => ({}))) as { changeId?: unknown; newId?: unknown };
        const changeId = url.searchParams.get("changeId") ?? sent.changeId;
        change = {
          id,
          ...(action === "rename" && typeof sent.newId === "string" ? { newId: sent.newId } : {}),
          action,
          trigger: "request",
          changeId: typeof changeId === "string" ? changeId : null,
          before: await changes.pageOf(id),
        };
        row = await changes.open(change);
      }
      response = await hit.route.run(hit.match, url, run);
      if (change && response.ok) {
        // A rename answers the item under its new id.
        const written = (await response.clone().json()) as { id?: string; changeId?: string };
        if (written.id && written.id !== id) change.newId = written.id;
        if (written.changeId) change.changeId = written.changeId;
        const after = action === "delete" ? null : await changes.pageOf(change.newId ?? id);
        // The tombstone is part of the write, so a 404 handler asked the moment it answers already says 410. The write
        // stands whatever happens after it: a change that cannot be finished now is left in its row for the cron.
        const failed = (error: unknown) =>
          log({ siteApi: "page-change-failed", error: String(error) });
        const { told } = await changes.settle(row, change, after, request).then(
          (settled) => ({ told: settled.told?.catch(failed) }),
          (error) => (failed(error), { told: undefined }),
        );
        if (told && ctx) ctx.waitUntil(told);
        else await told;
      } else if (row && response.status < 500) {
        // Refused: nothing was written. A site failure is left for the cron, which reads whether it was.
        await changes.drop(row);
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
      if (!(await limiter.limit({ key: `ip:${clientIp(request)}` })).success)
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
