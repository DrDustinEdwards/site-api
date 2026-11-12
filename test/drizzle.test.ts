// Each Drizzle mirror (src/drizzle.ts) against the SQL that creates its table, with site-runtime's ./drizzle-check:
// columns, types, NOT NULL, defaults, keys and indexes, so a change to the SQL without its mirror fails here.

import { assertMirror } from "@dustinedwards/site-runtime/drizzle-check";
import { it } from "vitest";
import * as mirrors from "../src/drizzle.js";
import { MEDIA_LIBRARY_SQL } from "../src/media-store.js";
import { SCHEDULED_UPDATES_SQL } from "../src/schedules.js";
import { SITE_API_STORE_SQL } from "../src/store.js";

const { media, mediaRevisions, mediaChanges, scheduledUpdates, ...store } = mirrors;

it.each([
  ...[media, mediaRevisions, mediaChanges].map((table) => [table, MEDIA_LIBRARY_SQL] as const),
  ...Object.values(store).map((table) => [table, SITE_API_STORE_SQL] as const),
  [scheduledUpdates, SCHEDULED_UPDATES_SQL] as const,
])("a mirror matches its SQL", (table, sql) => assertMirror(table, sql));
