// v0.10.0: the D1 table a site keeps its scheduled updates in, run on SQLite (what D1 is) through a D1-shaped shim.

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { d1ScheduledUpdates, SCHEDULED_UPDATES_SQL, type D1Like, type D1StatementLike } from "../src/schedules.js";

function d1(): D1Like {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEDULED_UPDATES_SQL);
  const statement = (sql: string, values: unknown[] = []): D1StatementLike => ({
    bind: (...next) => statement(sql, next),
    first: async <T>() => (db.prepare(sql).get(...(values as never[])) ?? null) as T | null,
    all: async <T>() => ({ results: db.prepare(sql).all(...(values as never[])) as T[] }),
    run: async () => db.prepare(sql).run(...(values as never[])),
  });
  return { prepare: (sql) => statement(sql) };
}

describe("d1ScheduledUpdates (v0.10.0)", () => {
  it("keeps one update per item in UTC, lists the due ones oldest first, and a matched remove keeps a reschedule", async () => {
    const store = d1ScheduledUpdates(d1());
    await store.put("a", { source: "A2", publishAt: "2030-01-01T09:00:00-06:00", changeId: "c1", scheduledAt: new Date("2029-12-01T00:00:00Z") }).run();
    await store.put("b", { source: "B2", publishAt: "2030-01-01T12:00:00Z", changeId: "c2" }).run();
    expect(await store.get("a")).toEqual({ id: "a", source: "A2", publishAt: "2030-01-01T15:00:00.000Z", changeId: "c1", scheduledAt: "2029-12-01T00:00:00.000Z" });

    expect(await store.due(new Date("2030-01-01T15:00:00Z"), 10)).toEqual([
      { id: "b", kind: "update", publishAt: "2030-01-01T12:00:00.000Z", changeId: "c2" },
      { id: "a", kind: "update", publishAt: "2030-01-01T15:00:00.000Z", changeId: "c1" },
    ]);
    expect(await store.due(new Date("2030-01-01T15:00:00Z"), 1)).toHaveLength(1);

    // A reschedule between the listing and the apply: the remove the apply sends matches nothing.
    await store.put("a", { source: "A3", publishAt: "2030-02-01T00:00:00Z", changeId: "c3" }).run();
    await store.remove("a", { publishAt: "2030-01-01T15:00:00.000Z", changeId: "c1" }).run();
    expect(await store.get("a")).toMatchObject({ source: "A3", changeId: "c3" });
    await store.remove("a").run();
    expect(await store.get("a")).toBeNull();
  });
});
