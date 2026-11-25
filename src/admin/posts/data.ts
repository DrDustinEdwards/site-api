import { createTwoFilesPatch } from "diff";
import { Timestamp } from "../../contract/base.js";
import {
  type Capabilities,
  type ContentStatus,
  type ContentSummary,
  type ListQuery,
  type ScheduledUpdateSummary,
} from "../../contract.js";
import { type ContentSource, type RowNote, PER_PAGE, orNull, absolute } from "../kit.js";

import type { PostQuery, PostsData, ScheduledUpdateView } from "../posts.js";

export type PostSort = "updated" | "published" | "title";
const POST_SORTS: readonly PostSort[] = ["updated", "published", "title"];

export interface PostRow {
  id: string;
  title: string;
  kind: string;
  status: ContentStatus;
  path: string | null;
  href: string;
  liveHref: string | null;
  publishAt: string | null;
  publishedAt: string | null;
  updatedAt: string | null;
  /**
   * The update scheduled to replace a live post (v0.10.0): when it goes live, and where its source is shown
   * (`ContentSource.scheduleHref`, else the editor). Absent when nothing waits.
   */
  scheduledUpdate?: { publishAt: string; href: string };
  /** Present when the site's list carries it. */
  version?: string;
  tags?: string[];
  /** v0.17.0, where the site keeps them: everyone credited, the primary first, and the excerpt. */
  authors?: string[];
  excerpt?: string;
  /** v0.17.0, on a trashed post: when it went to the trash. */
  trashedAt?: string | null;
  notes?: RowNote[];
}

/** A posts query from the address: anything the kit does not know is dropped, never sent. */
export function readPostQuery(search: URLSearchParams): PostQuery {
  const q = search.get("q")?.trim().slice(0, 200);
  const status = search.get("status");
  const kind = search.get("kind")?.trim().slice(0, 64);
  const tag = search.get("tag")?.trim().slice(0, 40);
  const sort = search.get("sort");
  const dir = search.get("dir");
  const cursor = search.get("cursor")?.slice(0, 500);
  const author = search.get("author")?.trim().slice(0, 200);
  const day = (name: string) => {
    const value = search.get(name)?.trim();
    return value &&
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Timestamp.safeParse(`${value}T00:00:00Z`).success
      ? value
      : undefined;
  };
  const [from, to] = [day("from"), day("to")];
  return {
    ...(dir === "asc" || dir === "desc" ? { dir } : {}),
    ...(q ? { q } : {}),
    ...(status && (["draft", "scheduled", "published"] as const).includes(status as ContentStatus)
      ? { status: status as ContentStatus }
      : {}),
    ...(kind ? { kind } : {}),
    ...(tag ? { tag } : {}),
    ...(author ? { author } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(search.get("trashed") === "1" ? { trashed: "1" as const } : {}),
    ...(sort && POST_SORTS.includes(sort as PostSort) ? { sort: sort as PostSort } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

function postRow(
  source: ContentSource,
  item: ContentSummary & { version?: string; tags?: string[] },
): PostRow {
  return {
    id: item.id,
    title: item.title || item.id,
    kind: item.kind,
    status: item.status,
    path: item.path,
    href: source.editorHref(item.id),
    liveHref:
      item.status === "published" && item.path ? absolute(source.site.origin, item.path) : null,
    publishAt: item.publishAt,
    publishedAt: item.publishedAt,
    updatedAt: item.updatedAt,
    ...(item.scheduledUpdate
      ? {
          scheduledUpdate: {
            publishAt: item.scheduledUpdate.publishAt,
            href: source.scheduleHref ? source.scheduleHref(item.id) : source.editorHref(item.id),
          },
        }
      : {}),
    ...(item.version ? { version: item.version } : {}),
    ...(item.tags ? { tags: item.tags } : {}),
    ...(item.authors ? { authors: item.authors } : {}),
    ...(item.excerpt ? { excerpt: item.excerpt } : {}),
    ...(item.trashedAt !== undefined ? { trashedAt: item.trashedAt } : {}),
  };
}

const BY: Record<PostSort, (a: PostRow, b: PostRow) => number> = {
  updated: (a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
  published: (a, b) =>
    (b.publishedAt ?? b.publishAt ?? "").localeCompare(a.publishedAt ?? a.publishAt ?? ""),
  title: (a, b) => a.title.localeCompare(b.title),
};

/** One page of one site's posts, as PostsList renders it. */
export async function loadPosts(source: ContentSource, query: PostQuery = {}): Promise<PostsData> {
  const meta = await source.client.meta();
  const filters = meta.capabilities.contentFilters ?? [];
  const trash = hasTrash(meta.capabilities);
  // The filters the site applies (v0.17.0) go to it; kind and tag on a site without them still work on the page it sent.
  const onSite: Partial<ListQuery> = {
    ...(query.kind && filters.includes("kind") ? { kind: query.kind } : {}),
    ...(query.tag && filters.includes("tag") ? { tag: query.tag } : {}),
    ...(query.author && filters.includes("author") ? { author: query.author } : {}),
    ...(query.from && filters.includes("published")
      ? { publishedAfter: `${query.from}T00:00:00.000Z` }
      : {}),
    ...(query.to && filters.includes("published")
      ? { publishedBefore: `${query.to}T23:59:59.999Z` }
      : {}),
    ...(query.trashed && trash ? { trashed: true } : {}),
  };
  // A host's own index answers only the plain list; a filtered one comes from the site, which says what it applied.
  const lister =
    Object.keys(onSite).length > 0 ? source.client : (source.postIndex ?? source.client);
  const base = {
    ...(query.q ? { q: query.q } : {}),
    ...(query.sort ? { sort: query.sort, ...(query.dir ? { dir: query.dir } : {}) } : {}),
  };
  const list = await lister.list({
    limit: PER_PAGE,
    ...base,
    ...onSite,
    ...(query.status ? { status: query.status } : {}),
    ...(query.cursor ? { cursor: query.cursor } : {}),
  });
  let rows = list.items.map((item) => postRow(source, item));
  const kinds = [...new Set(rows.map((r) => r.kind))].sort();
  const authors = [...new Set(rows.flatMap((r) => r.authors ?? []))].sort();
  if (query.kind && !onSite.kind) rows = rows.filter((r) => r.kind === query.kind);
  if (query.tag && !onSite.tag)
    rows = rows.filter((r) => (r.tags ?? []).some((t) => sameTag(t, query.tag!)));
  // A site that sorted says so (v0.6.0); otherwise the kit sorts the page it has and says that.
  const sortedOnPage = query.sort !== undefined && list.sorted === undefined;
  if (sortedOnPage) {
    const dir = query.dir ?? (query.sort === "title" ? "asc" : "desc");
    rows = [...rows].sort(
      (a, b) =>
        (dir === (query.sort === "title" ? "asc" : "desc") ? 1 : -1) * BY[query.sort!](a, b),
    );
  }
  // Where the site counts (v0.6.0), each status tab gets its count for the same search, and the Trash its own.
  let counts: PostsData["counts"];
  if (list.total !== undefined) {
    const statuses = ["draft", "scheduled", "published"] as const;
    const search = query.q ? { q: query.q } : {};
    const [totals, binned] = await Promise.all([
      Promise.all(statuses.map((status) => lister.list({ limit: 1, ...search, status }))),
      trash ? source.client.list({ limit: 1, ...search, trashed: true }) : null,
    ]);
    counts = {
      all:
        query.status || query.trashed ? totals.reduce((n, t) => n + (t.total ?? 0), 0) : list.total,
    };
    statuses.forEach((status, i) => (counts![status] = totals[i]!.total ?? 0));
    if (binned?.total !== undefined) counts.trash = binned.total;
  }
  if (source.notes && rows.length > 0) {
    const notes = await source.notes(rows.map((r) => r.id));
    rows = rows.map((r) => (notes[r.id]?.length ? { ...r, notes: notes[r.id] } : r));
  }
  const capabilities = meta.capabilities;
  return {
    site: { id: source.site.id, name: source.site.name },
    query,
    rows,
    page: {
      nextCursor: list.nextCursor,
      ...(list.total !== undefined ? { total: list.total } : {}),
      ...(sortedOnPage ? { sortedOnPage } : {}),
    },
    ...(counts ? { counts } : {}),
    kinds,
    offers: {
      delete: capabilities.contentDelete === true,
      schedule: true,
      tags: true,
      duplicate: true,
      scheduledUpdates: capabilities.scheduledUpdates === true,
      trash,
      rename: capabilities.contentRename === true,
      previewLinks: capabilities.previewLinks === true,
      backlinks: capabilities.backlinks === true,
      filters,
      authors,
    },
    can: source.can,
  };
}

/** True where the site has the content trash (v0.17.0): trash and restore, and delete for good from it. */
export const hasTrash = (capabilities: Capabilities | null) => capabilities?.contentTrash === true;

/** A time as the kit's messages say it: "2030-01-01 15:00 UTC", the same wherever the host runs. */
export function scheduleLabel(publishAt: string): string {
  return `${new Date(publishAt).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * The warning before a save to a live post that has an update waiting (v0.10.0): the save changes the live post now,
 * and the update still replaces the whole post at its time. null when there is nothing to warn about. The editor
 * shows it before saving; the kit adds it to a tag change's outcome. `label` says the time; an admin that writes times its
 * own way elsewhere passes its formatter, so the page says one time one way.
 */
export function liveSaveWarning(
  doc: { status: ContentStatus; scheduledUpdate?: ScheduledUpdateSummary | null },
  label: (publishAt: string) => string = scheduleLabel,
): string | null {
  if (doc.status !== "published" || !doc.scheduledUpdate) return null;
  return `An update is scheduled for ${label(doc.scheduledUpdate.publishAt)}. Saving changes the live post now, and the scheduled update will still replace it then, without this change. Edit the scheduled update too, or cancel it.`;
}

/** The update waiting on one post, or null when nothing waits (or the site keeps no scheduled updates). */
export async function loadScheduledUpdate(
  source: ContentSource,
  id: string,
): Promise<ScheduledUpdateView | null> {
  const doc = await orNull(source.client.get(id));
  if (!doc?.scheduledUpdate) return null;
  const update = await orNull(source.client.scheduledUpdate(id));
  if (!update) return null;
  return {
    id,
    title: doc.title || id,
    publishAt: update.publishAt,
    when: scheduleLabel(update.publishAt),
    scheduledAt: update.scheduledAt,
    source: update.source,
    live: {
      source: doc.source,
      version: doc.version,
      href: doc.path ? absolute(source.site.origin, doc.path) : null,
    },
    patch: createTwoFilesPatch(`${id} (live)`, `${id} (scheduled)`, doc.source, update.source),
    editorHref: source.editorHref(id),
    can: source.can,
  };
}

export const sameTag = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export const POST_INTENTS = [
  "tag-add",
  "tag-remove",
  "duplicate",
  "unpublish",
  "republish",
  "delete",
  "reschedule",
  "cancel-schedule",
  "trash",
  "restore",
  "rename",
  "preview-link",
] as const;

export type PostIntent = (typeof POST_INTENTS)[number];
