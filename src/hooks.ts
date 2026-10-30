// Publish hooks (v0.10.0): what a site runs when a public page changes, whether a Carrel request changed it or a
// schedule did. A hook never decides anything: the write has already happened, so a hook that fails is logged and the
// write stands.

import type { ContentStatus } from "./contract.js";

/**
 * publish: the item went live (a first publish, a publish again, or a scheduled item at its time). update: a live
 * item's page changed (a save, a tag change, or its scheduled update at its time). unpublish: it left the site.
 * delete: it was deleted. v0.15.0: trash and restore (to and from the content trash), rename (a move to a new id, its
 * old path redirecting), schedule and unschedule (a schedule made or canceled, nothing changed yet).
 */
export type PublishAction = "publish" | "update" | "unpublish" | "delete" | "trash" | "restore" | "rename" | "schedule" | "unschedule";

export interface PublishEvent {
  action: PublishAction;
  id: string;
  /** The item's public path, such as /blog/some-post. */
  path: string;
  /** The site's origin and the path: the page that changed. */
  url: string;
  /** request: a Carrel write (or the site's own admin through localClient). schedule: `runSchedules`. */
  trigger: "request" | "schedule";
  changeId: string | null;
  /** The request that made the change; absent for a schedule, and for a hook's retry. */
  request?: Request;
  /** v0.15.0: the item's status before the write and after it (after a delete, absent). */
  previousStatus?: ContentStatus;
  status?: ContentStatus;
  /** v0.15.0, on a rename of an item that was ever published: its old path, which now redirects, and that page's address. */
  previousPath?: string;
  previousUrl?: string;
}

export interface PublishHook {
  /** Names the hook in the log, and in the store's retries. */
  name: string;
  /**
   * v0.15.0: the actions the hook hears. Absent: the ones that change a public page, as before (PAGE_ACTIONS): a publish,
   * a live item's update, an unpublish, and a delete, trash or rename of a live item.
   */
  on?: readonly PublishAction[];
  /** May return a promise. Throwing, or resolving to false, is a failure: logged, never answered, and the write stands. */
  run(event: PublishEvent): unknown;
}

/** What a hook with no `on` hears, each only when it changed a public page. */
export const PAGE_ACTIONS: readonly PublishAction[] = ["publish", "update", "unpublish", "delete", "trash", "rename"];

/** Whether a hook hears the event: one it names, or with no `on`, a page action that changed a public page. */
export function hears(hook: PublishHook, event: PublishEvent): boolean {
  if (hook.on) return hook.on.includes(event.action);
  if (!PAGE_ACTIONS.includes(event.action)) return false;
  const live = event.action === "publish" || event.action === "update" ? event.status : event.previousStatus;
  // An event that does not say (a site's own runHooks call before v0.15.0) is taken as a page change, as it was then.
  return live === undefined || live === "published";
}

/**
 * Runs every hook that hears the event at once, and logs each one that fails. Never throws. `failed` (v0.15.0) is told
 * each failure, so the package keeps it for a retry where the site has a store.
 */
export async function runHooks(
  hooks: readonly PublishHook[],
  event: PublishEvent,
  log: (entry: Record<string, unknown>) => void,
  failed?: (hook: PublishHook, error: string) => Promise<void>,
): Promise<void> {
  const { request: _r, ...logged } = event;
  await Promise.all(
    hooks.filter((hook) => hears(hook, event)).map(async (hook) => {
      let error: string | null;
      try {
        error = (await hook.run(event)) === false ? "the hook reported a failure" : null;
      } catch (thrown) {
        error = thrown instanceof Error ? thrown.message : String(thrown);
      }
      if (error === null) return;
      log({ siteApi: "hook-failed", hook: hook.name, ...logged, error });
      await failed?.(hook, error).catch((e) => log({ siteApi: "hook-retry-failed", hook: hook.name, error: String(e) }));
    }),
  );
}

/** The shape of Prelum's `submitIndexNow` (`@drdustinedwards/site-helpers/indexnow`), which the site passes in. */
export type SubmitIndexNow = (input: { origin: string; key: string; urls: string[]; from?: string }) => Promise<boolean>;

/**
 * The IndexNow hook: tells search engines the changed page, through Prelum's `submitIndexNow`. The site passes the
 * function in, so this package carries no copy of it and no dependency on Prelum. A request on another origin (a
 * preview, localhost) sends nothing and is not a failure; a schedule has no request, so it always sends. Prelum resolves
 * false when the engines refuse or cannot be reached, which the hook runner logs.
 */
export function indexNowHook(options: { submit: SubmitIndexNow; key: string; origin: string }): PublishHook {
  return {
    name: "indexnow",
    run: (event) => {
      // A preview is not a failure: it has nothing to tell.
      if (event.request && new URL(event.request.url).origin !== options.origin) return true;
      return options.submit({
        origin: options.origin,
        key: options.key,
        // A rename's old address now redirects: the engines hear both.
        urls: event.previousUrl ? [event.url, event.previousUrl] : [event.url],
        ...(event.request ? { from: event.request.url } : {}),
      });
    },
  };
}
