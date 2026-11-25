import { hasContentTrash, type SiteAdapter } from "../adapter.js";
import { Timestamp } from "../contract/base.js";
import type { ContentSummary } from "../contract.js";
import type { PublishEvent, PublishHook } from "../hooks.js";
import type { SiteApiStore } from "../store.js";
import { TRASH_DAYS } from "./types.js";

type Log = (entry: Record<string, unknown>) => void;

const DAY = 24 * 60 * 60 * 1000;
export const MINUTE = 60 * 1000;

/** How long a failed hook waits before each retry (v0.17.0), in minutes; after the last it is given up and logged. */
export const HOOK_BACKOFF_MINUTES = [1, 5, 30, 120, 720] as const;

// Each kept failure is run again when due, on its own hook only, until it works or has been tried after every backoff.
export async function retryHooks(
  { store, hooks, log }: { store: SiteApiStore | undefined; hooks: PublishHook[]; log: Log },
  now: Date,
  limit: number,
): Promise<number> {
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

// The content trash's own end (v0.17.0): items trashed more than TRASH_DAYS ago go for good, through the adapter's
// delete with the version listed, so one changed since is refused and left. Each on its own, like a schedule.
export async function emptyTrash(
  { adapter, log }: { adapter: SiteAdapter; log: Log },
  now: Date,
  limit: number,
): Promise<number> {
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
