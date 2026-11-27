// What a content write or an applied schedule leaves behind, made durable. Before the write, the change is kept in the
// store (an outbox row in hook_retries under CHANGE_ROW); after it, the tombstone is kept and a row is queued for
// each hook that hears it, and only then is the change row dropped. A Worker that dies after the write but before
// that leaves the row, and the cron finishes it: it reads the item again, finishes the change if the item's version
// moved (the write happened), and drops it if not. A tombstone that cannot be kept is tried again on the same backoff
// as a hook, and one given up is logged as an error, which the site's error reporting sends on.

import type { SiteAdapter } from "../adapter.js";
import type { ContentStatus } from "../contract.js";
import {
  runHooks,
  hears,
  type PublishAction,
  type PublishEvent,
  type PublishHook,
} from "../hooks.js";
import type { HookRetry, SiteApiStore } from "../store.js";

type Log = (entry: Record<string, unknown>) => void;

export const MINUTE = 60 * 1000;

/** How long a failed hook waits before each retry, in minutes; after the last it is given up and logged. */
export const HOOK_BACKOFF_MINUTES = [1, 5, 30, 120, 720] as const;

/** The hook name a change's own row is kept under. No site hook can hear it: a hook's name never holds a colon. */
export const CHANGE_ROW = "site-api:change";

/** An item's public path, status and version, read before a write and after it. A draft never published has no page. */
export interface Page {
  path: string | null;
  status: ContentStatus | null;
  version: string | null;
}

/** One change as its row keeps it. `newId` is a rename's new id; `hooksKept` says only the tombstone is left. */
export interface Change {
  id: string;
  newId?: string;
  action: PublishAction;
  trigger: "request" | "schedule";
  changeId: string | null;
  before: Page;
  hooksKept?: boolean;
}

/** A queued or failed row's place in the backoff: `attempts` runs so far. */
type Row = { id: string; attempts: number };

export function pageChanges({
  adapter,
  store,
  hooks,
  log,
}: {
  adapter: SiteAdapter;
  store: SiteApiStore | undefined;
  hooks: PublishHook[];
  log: Log;
}) {
  const later = (now: number, minutes: number) => new Date(now + minutes * MINUTE).toISOString();

  async function pageOf(id: string): Promise<Page> {
    const doc = await adapter.content.get(id).catch(() => null);
    return { path: doc?.path ?? null, status: doc?.status ?? null, version: doc?.version ?? null };
  }

  // The event for one change, from the page before it and after it. A draft that was never published has no page,
  // so its writes tell no one, except a schedule or an unschedule, which a hook naming them hears with no path. A
  // schedule tells only of a page it put live.
  function eventOf(change: Change, after: Page | null, request?: Request): PublishEvent | null {
    const { before, action } = change;
    if (change.trigger === "schedule" && after?.status !== "published") return null;
    const path = after?.path ?? before.path;
    if (!path && action !== "schedule" && action !== "unschedule") return null;
    const moved =
      action === "rename" && before.path && path && before.path !== path ? before.path : null;
    return {
      action,
      id: change.newId ?? change.id,
      path,
      url: path ? new URL(path, adapter.site.origin).href : null,
      trigger: change.trigger,
      changeId: change.changeId,
      ...(request ? { request } : {}),
      ...(before.status ? { previousStatus: before.status } : {}),
      ...(after?.status ? { status: after.status } : {}),
      ...(moved
        ? { previousPath: moved, previousUrl: new URL(moved, adapter.site.origin).href }
        : {}),
    };
  }

  /**
   * The tombstones. A delete or a trash of a live item leaves its path answering 410; a publish there, or a
   * rename onto it, takes the tombstone away. The trash emptying itself keeps it. Throws when the store cannot.
   */
  async function keepTombstones(change: Change, after: Page | null): Promise<void> {
    if (!store?.markGone || !store.clearGone) return;
    const { action, before } = change;
    if ((action === "delete" || action === "trash") && before.status === "published" && before.path)
      await store.markGone(before.path, new Date().toISOString());
    if (
      (action === "publish" || action === "rename") &&
      after?.status === "published" &&
      after.path
    )
      await store.clearGone(after.path);
  }

  /** Keeps the change before its write runs. Null without a store. Throws when the store cannot keep it. */
  async function open(change: Change): Promise<Row | null> {
    if (!store) return null;
    const row = { id: crypto.randomUUID(), attempts: 0 };
    await store.putHookRetry({
      ...row,
      hook: CHANGE_ROW,
      event: JSON.stringify(change),
      nextAt: later(Date.now(), HOOK_BACKOFF_MINUTES[0]),
      lastError: "the write has not answered",
    });
    return row;
  }

  /** Drops the change: its write did not happen. */
  async function drop(row: Row | null): Promise<void> {
    if (row) await store!.dropHookRetry(row.id);
  }

  // Runs the hooks on their queued rows: one that works drops its row, one that fails waits on the backoff.
  function tell(event: PublishEvent, queued: Map<string, string>): Promise<void> {
    const { request: _r, ...kept } = event;
    return runHooks(
      hooks,
      event,
      log,
      async (hook, error) => {
        if (!store) return;
        await store.putHookRetry({
          id: queued.get(hook.name) ?? crypto.randomUUID(),
          hook: hook.name,
          event: JSON.stringify(kept),
          attempts: 1,
          nextAt: later(Date.now(), HOOK_BACKOFF_MINUTES[0]),
          lastError: error,
        });
      },
      async (hook, ok) => {
        const id = queued.get(hook.name);
        if (ok && id) await store!.dropHookRetry(id);
        if (store?.putHookRun && event.changeId)
          await store.putHookRun({
            changeId: event.changeId,
            hook: hook.name,
            ok,
            at: new Date().toISOString(),
          });
      },
    );
  }

  /**
   * Finishes a change whose write happened: keeps its tombstone, queues a row for each hook that hears it, drops the
   * change's row, and answers the hooks' run as `told`, null when no hook hears it (for the caller's waitUntil; an
   * async function answering a bare promise would wait on it). A tombstone that fails keeps the row for the
   * cron, marked so its hooks are not queued twice.
   */
  async function settle(
    row: Row | null,
    change: Change,
    after: Page | null,
    request?: Request,
  ): Promise<{ told: Promise<void> | null }> {
    let tombstoneError: string | null = null;
    try {
      await keepTombstones(change, after);
    } catch (error) {
      tombstoneError = String(error);
      log({ siteApi: "tombstone-failed", action: change.action, error: tombstoneError });
    }
    const event = change.hooksKept ? null : eventOf(change, after, request);
    const queued = new Map<string, string>();
    if (event && store) {
      const { request: _r, ...kept } = event;
      for (const hook of hooks.filter((h) => hears(h, event))) {
        const id = crypto.randomUUID();
        await store.putHookRetry({
          id,
          hook: hook.name,
          event: JSON.stringify(kept),
          attempts: 0,
          nextAt: later(Date.now(), HOOK_BACKOFF_MINUTES[0]),
          lastError: "the hook has not answered",
        });
        queued.set(hook.name, id);
      }
    }
    if (row && tombstoneError === null) await store!.dropHookRetry(row.id);
    else if (row) await backoff(row, { ...change, hooksKept: true }, tombstoneError!);
    return { told: event && hooks.length > 0 ? tell(event, queued) : null };
  }

  // The change's row again, later on the backoff; past the last, given up and reported as an error.
  async function backoff(row: Row, change: Change, error: string): Promise<void> {
    const wait = HOOK_BACKOFF_MINUTES[row.attempts];
    if (wait === undefined) {
      log({ siteApi: "change-gave-up", level: "error", ...change, attempts: row.attempts, error });
      await store!.dropHookRetry(row.id);
      return;
    }
    await store!.putHookRetry({
      id: row.id,
      hook: CHANGE_ROW,
      event: JSON.stringify(change),
      attempts: row.attempts + 1,
      nextAt: later(Date.now(), wait),
      lastError: error,
    });
  }

  /** The cron's half: finishes a change row a dying Worker left, or drops it when its write never happened. */
  async function resolve(retry: HookRetry): Promise<void> {
    const change = JSON.parse(retry.event) as Change;
    try {
      const after = await pageOf(change.newId ?? change.id);
      const gone = change.action === "delete" || change.action === "trash";
      if (change.hooksKept) {
        // Only the tombstone is left, and only while the item still stands as the change left it.
        const still = gone ? after.status !== "published" : after.status === "published";
        if (still) await keepTombstones(change, change.action === "delete" ? null : after);
        await store!.dropHookRetry(retry.id);
        return;
      }
      // A write moves the item's version (a delete leaves none, a rename a new id), so an unmoved one never ran.
      const moved = change.newId ? after.version !== null : after.version !== change.before.version;
      if (!moved) {
        await store!.dropHookRetry(retry.id);
        return;
      }
      log({ siteApi: "change-recovered", id: change.id, action: change.action });
      await (
        await settle(retry, change, change.action === "delete" ? null : after)
      ).told;
    } catch (error) {
      await backoff(retry, change, String(error)).catch((e) =>
        log({ siteApi: "change-retry-failed", error: String(e) }),
      );
    }
  }

  return { pageOf, open, drop, settle, resolve };
}
