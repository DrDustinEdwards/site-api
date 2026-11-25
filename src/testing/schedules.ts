import {
  NotFoundError,
  RefusedError,
  type DueSchedule,
  type SchedulesAdapter,
} from "../adapter.js";
import type { WriteResult } from "../contract.js";
import { at, type Stored, type WriteChanges } from "./shared.js";

/** The in-memory scheduled-updates group, over the content store and its commit. */
export function memorySchedules(ctx: {
  store: Map<string, Stored>;
  now: () => Date;
  existing: (id: string, expectedVersion: string) => Stored;
  commit: (
    id: string,
    previous: Stored | undefined,
    changes: WriteChanges,
    changeId: string,
    message: string,
    actor?: { name: string },
  ) => WriteResult;
}): SchedulesAdapter {
  const { store, now, existing, commit } = ctx;
  return {
    async get(id) {
      return store.get(id)?.pending ?? null;
    },
    async update(id, input) {
      const previous = existing(id, input.expectedVersion);
      if (previous.doc.status !== "published")
        throw new RefusedError("Only a live post takes a scheduled update.");
      const pending = {
        id,
        source: input.source,
        publishAt: input.publishAt,
        changeId: input.changeId,
        scheduledAt: now().toISOString(),
      };
      return commit(
        id,
        previous,
        { status: "published", pending },
        input.changeId,
        "Schedule update",
        input.actor,
      );
    },
    async cancel(id, input) {
      if (!store.has(id)) throw new NotFoundError();
      const previous = existing(id, input.expectedVersion);
      if (previous.pending)
        return commit(
          id,
          previous,
          { status: "published", pending: null },
          input.changeId,
          "Cancel scheduled update",
          input.actor,
        );
      if (previous.doc.status === "scheduled")
        return commit(id, previous, { status: "draft" }, input.changeId, "Unschedule", input.actor);
      throw new RefusedError("Nothing is scheduled for this post.");
    },
    async due({ now: time, limit }) {
      const due: DueSchedule[] = [];
      for (const { doc, pending, scheduleChangeId } of store.values()) {
        if (pending)
          due.push({
            id: doc.id,
            kind: "update",
            publishAt: pending.publishAt,
            changeId: pending.changeId,
          });
        else if (doc.status === "scheduled" && doc.publishAt)
          due.push({
            id: doc.id,
            kind: "publish",
            publishAt: doc.publishAt,
            changeId: scheduleChangeId ?? "schedule",
          });
      }
      return due
        .filter((d) => at(d.publishAt) <= time.getTime())
        .sort((a, b) => at(a.publishAt) - at(b.publishAt) || a.id.localeCompare(b.id))
        .slice(0, limit);
    },
    async apply(id, input) {
      const previous = store.get(id);
      if (!previous || at(input.publishAt) > input.now.getTime()) return null;
      const { doc, pending } = previous;
      if (input.kind === "update") {
        if (
          doc.status !== "published" ||
          !pending ||
          pending.changeId !== input.changeId ||
          at(pending.publishAt) !== at(input.publishAt)
        )
          return null;
        return commit(
          id,
          previous,
          { source: pending.source, status: "published", pending: null },
          input.changeId,
          "Publish scheduled update",
        );
      }
      if (doc.status !== "scheduled" || !doc.publishAt || at(doc.publishAt) !== at(input.publishAt))
        return null;
      // A first publication records the time it was scheduled for, not the time the cron ran.
      return commit(
        id,
        previous,
        { status: "published", publishedAt: new Date(doc.publishAt).toISOString() },
        input.changeId,
        "Publish scheduled",
      );
    },
  };
}
