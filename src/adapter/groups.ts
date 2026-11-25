import type {
  Actor,
  MentionList,
  MentionListQuery,
  MentionStatus,
  NotFoundRow,
  ScheduledUpdate,
  WriteResult,
} from "../contract.js";

/**
 * The mentions group (v0.5.0), optional per site. Every write throws VersionConflictError when
 * expectedVersion is not what the site holds, NotFoundError for a missing id and RefusedError when
 * the site's own rules refuse. The write and the cache purge it needs are one unit, run together in
 * the method, and the method reports whether the purge worked.
 */
export interface MentionsAdapter {
  /** Newest first. `counts` and `expiring` cover the whole queue, not the page. */
  list(query: MentionListQuery): Promise<MentionList>;
  /** Approve or reject. Refuse (RefusedError) a mention that is not yet verified or that failed verification. */
  decide(
    id: string,
    input: { decision: "approve" | "reject"; expectedVersion: string; changeId: string },
  ): Promise<{ status: MentionStatus; version: string; purged: boolean | null }>;
  /**
   * Optional (v0.6.0): takes an approved or rejected mention back to pending, as it was before the
   * decision, so a decision can be undone. Refuse (RefusedError) any other status. Absent: a reset answers 501.
   */
  reset?(
    id: string,
    input: { expectedVersion: string; changeId: string },
  ): Promise<{ status: MentionStatus; version: string; purged: boolean | null }>;
  /** Removes the only copy of what a stranger sent. */
  delete(
    id: string,
    input: { expectedVersion: string; changeId: string },
  ): Promise<{ purged: boolean | null }>;
  /** Removes failed and rejected mentions past the site's retention windows, and reports how many. */
  sweep(input: { changeId: string }): Promise<{ failed: number; rejected: number }>;
}

/** One schedule whose time has come (v0.10.0): a scheduled item to publish, or a live item's update to apply. */
export interface DueSchedule {
  id: string;
  /** publish: a scheduled item that was not live goes live. update: a live item's scheduled update replaces it. */
  kind: "publish" | "update";
  publishAt: string;
  /** The change that made the schedule; the publish is recorded under it. */
  changeId: string;
}

/**
 * Scheduled updates (v0.10.0), optional per site: a live item carries one waiting update with its own source and time.
 * The live version stays served until then, and at that time the update replaces it. The site stores the update beside
 * the live item (D1 sites: `d1ScheduledUpdates` from `@dustinedwards/site-api/schedules`). With this group, the site's
 * cron calls `api.runSchedules()`, which publishes scheduled items as well, and the publish hooks run for each.
 *
 * Every write here moves the item's version, since the update is part of what the item is, and throws
 * VersionConflictError, NotFoundError or RefusedError like the content writes. Elsewhere in the adapter: a publish or an
 * unpublish of the item drops its waiting update, as does a delete; a save or a tag change to the live item leaves it
 * waiting, and the update's own source replaces the live one when it runs.
 */
export interface SchedulesAdapter {
  /** The update waiting on a live item, with its source; null when the id does not exist or nothing waits. */
  get(id: string): Promise<ScheduledUpdate | null>;
  /**
   * Stores the update on a live item, replacing any update already waiting (a reschedule). The item stays live and
   * unchanged. Refuse (RefusedError) an item that is not live: the package sends only live items here.
   */
  update(
    id: string,
    input: {
      source: string;
      publishAt: string;
      expectedVersion: string;
      changeId: string;
      actor?: Actor;
    },
  ): Promise<WriteResult>;
  /**
   * Cancels the schedule. A live item drops its waiting update and stays live; a scheduled item that was never live
   * returns to draft. Throws NotFoundError for a missing id (checked first), and RefusedError for an item with nothing
   * scheduled.
   */
  cancel(
    id: string,
    input: { expectedVersion: string; changeId: string; actor?: Actor },
  ): Promise<WriteResult>;
  /** Every schedule due at `now`, scheduled items and live items' updates alike, oldest first, at most `limit`. */
  due(input: { now: Date; limit: number }): Promise<DueSchedule[]>;
  /**
   * Runs one due schedule as one unit: publishes the scheduled item, or puts the update's source live and drops the
   * update. Only when what the site holds still matches (the same kind, time and change id, and the time has come);
   * otherwise it changes nothing and returns null, since a cancel, a reschedule or an unpublish got there first. A
   * scheduled item's first publication records `publishAt` as its `publishedAt`, not the time the cron ran.
   *
   * v0.17.0: a site whose scheduled item goes live by time alone, with no write (its pages compare `publishAt` with the
   * clock), still lists it in `due` as kind "publish", and `apply` answers its WriteResult without writing anything, so
   * the publish hooks hear it go live. Once applied it must leave `due`, or the hooks would hear it on every pass.
   */
  apply(id: string, input: DueSchedule & { now: Date }): Promise<WriteResult | null>;
}

/** What a 404 report is asked for (v0.16.0): site-runtime's `notFoundReport` options, checked and filled in. */
export interface NotFoundOptions {
  days: number;
  limit: number;
  includeProbes: boolean;
}

/** The insight group (v0.16.0), optional per site: what the site counted about its own pages. Read only. */
export interface InsightAdapter {
  /**
   * The most-hit missing paths of the last `days` UTC days, at most `limit`, probes only with `includeProbes`. A site
   * that counts its 404s with site-runtime's `./not-found` answers `(options) => notFoundReport(env.DB, options)`.
   */
  notFound(options: NotFoundOptions): Promise<NotFoundRow[]>;
}
