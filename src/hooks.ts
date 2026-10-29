// Publish hooks (v0.10.0): what a site runs when a public page changes, whether a Carrel request changed it or a
// schedule did. A hook never decides anything: the write has already happened, so a hook that fails is logged and the
// write stands.

/**
 * publish: the item went live (a first publish, a publish again, or a scheduled item at its time). update: a live
 * item's page changed (a save, a tag change, or its scheduled update at its time). unpublish: it left the site.
 * delete: a live item was deleted.
 */
export type PublishAction = "publish" | "update" | "unpublish" | "delete";

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
  /** The request that made the change; absent for a schedule. */
  request?: Request;
}

export interface PublishHook {
  /** Names the hook in the log. */
  name: string;
  /** May return a promise. Throwing, or resolving to false, is a failure: logged, never answered, and the write stands. */
  run(event: PublishEvent): unknown;
}

/** Runs every hook on the event at once, and logs each one that fails. Never throws. */
export async function runHooks(hooks: readonly PublishHook[], event: PublishEvent, log: (entry: Record<string, unknown>) => void): Promise<void> {
  const { request: _r, ...logged } = event;
  await Promise.all(
    hooks.map(async (hook) => {
      try {
        if ((await hook.run(event)) === false) log({ siteApi: "hook-failed", hook: hook.name, ...logged, error: "the hook reported a failure" });
      } catch (error) {
        log({ siteApi: "hook-failed", hook: hook.name, ...logged, error: error instanceof Error ? error.message : String(error) });
      }
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
        urls: [event.url],
        ...(event.request ? { from: event.request.url } : {}),
      });
    },
  };
}
