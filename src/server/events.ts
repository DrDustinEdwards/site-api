// The publish events a content write raises: which writes the hooks hear, the event for one, and the retry backoff.

import type { ContentStatus } from "../contract.js";
import type { Log } from "./http.js";
import type { SiteApiStore } from "../store.js";
import type { PublishAction, PublishEvent } from "../hooks.js";

export type Page = { path: string | null; status: ContentStatus | null };

// The content writes the publish hooks hear, and the action each is, by method and route.
export const PAGE_WRITE =
  /^\/content\/([^/]+)(?:\/(draft|publish|unpublish|tags|trash|restore|rename|schedule))?$/;
export const ACTION: Record<string, PublishAction> = {
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

/** How long a failed hook waits before each retry, in minutes; after the last it is given up and logged. */
export const HOOK_BACKOFF_MINUTES = [1, 5, 30, 120, 720] as const;

export const MINUTE = 60 * 1000;

export function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer[ ]+(\S+)\s*$/i);
  return match ? match[1]! : null;
}

// The event for one content write, from the page before it and after it. A draft that was never published has no page,
// so its writes tell no one, except a schedule or an unschedule, which a hook naming them hears with no path.
export function pageEvent(
  origin: string,
  id: string,
  action: PublishAction,
  before: Page,
  after: Page | null,
  written: { changeId?: string },
  request: Request,
): PublishEvent | null {
  const path = after?.path ?? before.path;
  if (!path && action !== "schedule" && action !== "unschedule") return null;
  const moved =
    action === "rename" && before.path && path && before.path !== path ? before.path : null;
  return {
    action,
    id,
    path,
    url: path ? new URL(path, origin).href : null,
    trigger: "request",
    changeId: written.changeId ?? null,
    request,
    ...(before.status ? { previousStatus: before.status } : {}),
    ...(after?.status ? { status: after.status } : {}),
    ...(moved ? { previousPath: moved, previousUrl: new URL(moved, origin).href } : {}),
  };
}

/**
 * The tombstones. A delete or a trash of a live item leaves its path answering 410; a publish there, or a
 * rename onto it, takes the tombstone away. The trash emptying itself keeps it. A store that cannot keep one is logged,
 * and the write stands.
 */
export async function keepTombstones(
  store: SiteApiStore | undefined,
  log: Log,
  action: PublishAction,
  before: Page,
  after: Page | null,
): Promise<void> {
  if (!store?.markGone || !store.clearGone) return;
  try {
    const at = new Date().toISOString();
    if ((action === "delete" || action === "trash") && before.status === "published" && before.path)
      await store.markGone(before.path, at);
    if (
      (action === "publish" || action === "rename") &&
      after?.status === "published" &&
      after.path
    )
      await store.clearGone(after.path);
  } catch (error) {
    log({ siteApi: "tombstone-failed", action, error: String(error) });
  }
}
