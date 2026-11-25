import { RefusedError, type MediaAdapter } from "../adapter.js";
import {
  LARGE_MEDIA_BYTES,
  type MediaDetail,
  type MediaLens,
  type MediaList,
  type MediaListQuery,
} from "../contract.js";
import { kindOf, orientationOf } from "../media.js";
import { type MediaLibraryOptions, type MediaRecord } from "./types.js";
import { OFFSET, SEQ, positive } from "./constants.js";

import type { LibraryCore } from "./types.js";

export function readMethods(core: LibraryCore, options: MediaLibraryOptions) {
  const { store, resize, now, usesOf, itemOf, itemWithUse } = core;
  return {
    async list(query: MediaListQuery): Promise<MediaList> {
      const start =
        query.cursor === undefined
          ? 0
          : OFFSET.test(query.cursor)
            ? Number(query.cursor)
            : Number.NaN;
      if (Number.isNaN(start))
        throw new RefusedError("That page cursor is not this site's; reload the library.");
      // The cursor first: a change that lands while the page is read is in the next poll, not lost between them.
      const cursor = String(await store.changeCursor());
      const records = await store.all();
      const uses = options.usage ? await usesOf() : undefined;
      const hashes = new Map<string, number>();
      for (const r of records) if (r.sha256) hashes.set(r.sha256, (hashes.get(r.sha256) ?? 0) + 1);
      const today = now().toISOString().slice(0, 10);
      const lens: Record<MediaLens, (r: MediaRecord) => boolean> = {
        unattached: (r) => (uses?.get(r.key)?.length ?? 0) === 0,
        "no-alt": (r) => r.alt.trim() === "" && r.decorative !== true,
        large: (r) => r.bytes > LARGE_MEDIA_BYTES,
        duplicates: (r) => r.sha256 !== null && (hashes.get(r.sha256) ?? 0) > 1,
        "license-expired": (r) => r.licenseExpires !== null && r.licenseExpires < today,
        oversized: (r) =>
          resize !== undefined && Math.max(r.width ?? 0, r.height ?? 0) > resize.maxEdge,
      };
      const needle = query.q?.trim().toLowerCase();
      const matching = records.filter(
        (r) =>
          (query.trashed === "only" ? r.trashedAt !== null : r.trashedAt === null) &&
          (!query.tag || r.tags.includes(query.tag)) &&
          (!needle ||
            [r.key, r.filename ?? "", r.alt, r.caption, r.credit, ...r.tags].some((t) =>
              t.toLowerCase().includes(needle),
            )) &&
          (!query.lens || lens[query.lens](r)) &&
          (!query.orientation ||
            orientationOf(positive(r.width), positive(r.height)) === query.orientation) &&
          (!query.kind || kindOf(r.contentType) === query.kind),
      );
      // The contract's defaults: added, size and used run largest first, name A to Z. Ties: newest first, then by key.
      const sort = query.sort ?? "added";
      const dir = query.dir ?? (sort === "name" ? "asc" : "desc");
      const keyOf_ = (r: MediaRecord): string | number =>
        sort === "size"
          ? r.bytes
          : sort === "used"
            ? (uses?.get(r.key)?.length ?? 0)
            : sort === "name"
              ? (r.filename ?? r.key).toLowerCase()
              : r.uploadedAt;
      const sorted = matching.sort((a, b) => {
        const [x, y] = [keyOf_(a), keyOf_(b)];
        const by = typeof x === "number" ? x - (y as number) : x.localeCompare(y as string);
        return (
          (dir === "asc" ? 1 : -1) * by ||
          b.uploadedAt.localeCompare(a.uploadedAt) ||
          a.key.localeCompare(b.key)
        );
      });
      const page = sorted.slice(start, start + query.limit);
      return {
        items: page.map((r) => itemOf(r, uses)),
        nextCursor: start + query.limit < sorted.length ? String(start + query.limit) : null,
        total: sorted.length,
        sorted: { sort, dir },
        changeCursor: cursor,
      };
    },

    async get(id): Promise<MediaDetail | null> {
      const record = await store.record(id);
      if (!record) return null;
      const uses = await usesOf([id]);
      const twins = record.sha256
        ? (await store.all())
            .filter((r) => r.sha256 === record.sha256 && r.key !== id)
            .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt) || a.key.localeCompare(b.key))
            .slice(0, 50)
            .map((r) => ({ id: r.key, filename: r.filename }))
        : [];
      return {
        ...itemOf(record, options.usage ? uses : undefined),
        usedBy: uses.get(id) ?? [],
        twins,
      };
    },

    async findByHash(sha256) {
      const record = await store.byHash(sha256);
      return record ? itemWithUse(record) : null;
    },

    // A file never changed has one revision, its bytes as uploaded, whether or not the site recorded it.
    async history(id) {
      const record = await store.record(id);
      if (!record) return null;
      const revisions = await store.revisions(id);
      const listed_ =
        revisions.length > 0
          ? revisions
          : [
              {
                id: 0,
                at: record.uploadedAt,
                bytes: record.bytes,
                width: record.width,
                height: record.height,
                reason: record.sourceUrl ? ("import" as const) : ("upload" as const),
                sha256: record.sha256,
                copyKey: null,
              },
            ];
      return listed_.map((r, n) => ({
        rev: String(r.id),
        at: r.at,
        bytes: r.bytes,
        width: positive(r.width),
        height: positive(r.height),
        reason: r.reason,
        current: n === 0,
      }));
    },

    // From the change log the store keeps: every insert, update and delete of a row.
    async changes({ since, limit }) {
      const head = await store.changeCursor();
      if (!SEQ.test(since) || Number(since) > head)
        throw new RefusedError("That change cursor is not this site's; reload the library.");
      const changed = await store.changedSince(Number(since), head, limit);
      const more = changed.length > limit;
      const taken = changed.slice(0, limit);
      // In groups of 90: D1 binds at most 100 values to a statement, and a poll may name up to 200 files.
      const keys = taken.map((c) => c.key);
      const found: MediaRecord[] = [];
      for (let n = 0; n < keys.length; n += 90)
        found.push(...(await store.records(keys.slice(n, n + 90))));
      const records = new Map(found.map((r) => [r.key, r]));
      const uses =
        options.usage && records.size > 0 ? await usesOf([...records.keys()]) : undefined;
      return {
        items: taken.flatMap((c) => {
          const record = records.get(c.key);
          return record ? [itemOf(record, options.usage ? (uses ?? new Map()) : undefined)] : [];
        }),
        removed: taken.filter((c) => !records.has(c.key)).map((c) => c.key),
        cursor: String(more ? taken[taken.length - 1]!.seq : head),
        more,
      };
    },
  } satisfies Partial<MediaAdapter>;
}
