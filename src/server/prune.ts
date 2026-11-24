// What a site's pass (runSchedules) deletes from the store, each by its own age.
import type { SiteApiStore } from "../store.js";
import { REPLAY_DAYS } from "./replay.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** A preview link keeps its page (410 expired, 404 revoked) this long, then its row goes. */
const PREVIEW_LINK_KEEP_DAYS = 30;
/** When this isolate last ran the daily prunes: they scan whole tables, so once a day, not every minute's pass. */
let lastDaily = 0;

export async function pruneStore(
  store: SiteApiStore,
  now: Date,
  log: (entry: Record<string, unknown>) => void,
): Promise<void> {
  const before = new Date(now.getTime() - REPLAY_DAYS * DAY).toISOString();
  await store
    .pruneWrites(before)
    .catch((error) => log({ siteApi: "replay-store-failed", error: String(error) }));
  await store
    .pruneHookRuns?.(before)
    .catch((error) => log({ siteApi: "hook-runs-prune-failed", error: String(error) }));
  // The probe's own 410 marker has done its job once the probe verified it; it never outlives the hour.
  await store
    .pruneProbeGone?.(new Date(now.getTime() - HOUR).toISOString())
    .catch((error) => log({ siteApi: "probe-gone-prune-failed", error: String(error) }));
  if (now.getTime() - lastDaily < DAY) return;
  lastDaily = now.getTime();
  await store
    .prunePreviewLinks?.(new Date(now.getTime() - PREVIEW_LINK_KEEP_DAYS * DAY).toISOString())
    .catch((error) => log({ siteApi: "preview-links-prune-failed", error: String(error) }));
  await store
    .compactMediaChanges?.()
    .catch((error) => log({ siteApi: "media-changes-compact-failed", error: String(error) }));
}
