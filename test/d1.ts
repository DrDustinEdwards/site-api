// SQLite (what D1 is) through a D1-shaped shim, for the package's own D1 tables.

import { DatabaseSync } from "node:sqlite";
import type { D1Like, D1StatementLike } from "../src/schedules.js";

export function d1(migration: string): D1Like {
  const db = new DatabaseSync(":memory:");
  db.exec(migration);
  const statement = (sql: string, values: unknown[] = []): D1StatementLike => ({
    bind: (...next) => statement(sql, next),
    first: async <T>() => (db.prepare(sql).get(...(values as never[])) ?? null) as T | null,
    all: async <T>() => ({ results: db.prepare(sql).all(...(values as never[])) as T[] }),
    run: async () => db.prepare(sql).run(...(values as never[])),
  });
  return { prepare: (sql) => statement(sql) };
}
