// The site API as every site mounts it (v0.37.0): one standard set of publish hooks, and one gateway step for
// site-runtime ./worker. Seven sites each wrote the same twenty lines (lib/carrel/handler.server.ts and the Carrel branch
// of workers/app.ts), and bsw had no purge, no IndexNow and no webmentions.
import { submitIndexNow } from "@drdustinedwards/site-helpers/indexnow";
import { schedulePurgeHook } from "@dustinedwards/site-runtime/edge-cache";
import { indexNowHook, type PublishHook } from "./hooks.js";
import {
  createSiteApi,
  isSiteApiRequest,
  type SiteApi,
  type SiteApiConfig,
  type WaitUntil,
} from "./server.js";
import type { D1Like } from "./schedules.js";
import { d1SiteApiStore } from "./store.js";
import { webmentionHook } from "./webmention.js";

/** The standard hooks, by name, for a site that adapts one (a one-page site sends its webmentions as the page). */
export interface StandardHooks {
  /** Tells IndexNow a page changed; absent for a site with no IndexNow key yet. */
  indexNow?: PublishHook;
  /** Purges the stored pages after a schedule puts a change live (site-runtime ./edge-cache). */
  purge: PublishHook;
  /** Sends the webmentions a changed page's links are owed. */
  webmention: PublishHook;
}

export interface StandardSiteApiOptions extends Pick<SiteApiConfig, "adapter" | "key" | "limiter"> {
  /** The site's D1: the replay store, preview links, failed hooks' retries and the webmentions sent. */
  db: D1Like;
  /** The production origin and the site's IndexNow key (Prelum's submitIndexNow sends nothing from another origin). */
  indexNow?: { origin: string; key: string };
  /** The hooks to run, from the standard ones (an absent one is left out); default IndexNow, the purge and webmentions. */
  hooks?: (standard: StandardHooks) => (PublishHook | undefined)[];
}

/** createSiteApi with the network's store and hooks. */
export function standardSiteApi(options: StandardSiteApiOptions): SiteApi {
  const store = d1SiteApiStore(options.db);
  const standard: StandardHooks = {
    ...(options.indexNow
      ? { indexNow: indexNowHook({ submit: submitIndexNow, ...options.indexNow }) }
      : {}),
    purge: schedulePurgeHook(),
    webmention: webmentionHook({ store }),
  };
  const hooks = (
    options.hooks?.(standard) ?? [standard.indexNow, standard.purge, standard.webmention]
  ).filter((hook): hook is PublishHook => hook !== undefined);
  return createSiteApi({
    adapter: options.adapter,
    key: options.key,
    limiter: options.limiter,
    store,
    hooks,
  });
}

/** What site-runtime ./worker hands a step (its GatewayKit), as far as this step reads it. */
export interface StepKit {
  url: URL;
  stylesheets(): Promise<string[]>;
  purgeAfterWrite(request: Request, response: Response, why: string): void;
}

/**
 * The gateway step for site-runtime ./worker: a preview link (/preview/<token>) answers first, then the API under
 * /api/carrel/v1, and every write it accepts purges the stored pages. The API is built only for those paths, so a
 * page request never loads the adapter.
 */
export function siteApiStep<E>(
  make: (env: E, kit: StepKit) => SiteApi | Promise<SiteApi>,
): (request: Request, env: E, ctx: WaitUntil, kit: StepKit) => Promise<Response | undefined> {
  return async (request, env, ctx, kit) => {
    if (!isSiteApiRequest(kit.url)) return undefined;
    const api = await make(env, kit);
    if (api.matchesPreviewLink(request)) return api.servePreviewLink(request);
    if (!api.matches(request)) return undefined;
    const response = await api.handle(request, ctx);
    kit.purgeAfterWrite(request, response, `carrel ${request.method} ${kit.url.pathname}`);
    return response;
  };
}
