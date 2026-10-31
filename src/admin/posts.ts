// The posts half of the content kit: PostsList's view data and its intents.

import { createTwoFilesPatch } from "diff";
import { SiteApiError } from "../client.js";
import { Timestamp } from "../contract/base.js";
import {
  ContentId,
  ContentTag,
  type Capabilities,
  type ContentDoc,
  type ContentFilter,
  type ContentStatus,
  type ContentSummary,
  type ListQuery,
  type ScheduledUpdateSummary,
  type SortDir,
} from "../contract.js";
import { joinSource, readKey, setRawKey, setTags, splitSource, tagsOf } from "../frontmatter.js";
import {
  type Permissions,
  type ContentSource,
  type RowNote,
  type IntentInput,
  type Outcome,
  type IntentResult,
  PER_PAGE,
  NOT_YOURS,
  text,
  refused,
  askFirst,
  plural,
  texts,
  changeId,
  recordDone,
  targetsOf,
  checkCount,
  summarize,
  result,
  orNull,
  Conflict,
  eachItem,
  absolute,
  actingClient,
} from "./kit.js";


export type PostSort = "updated" | "published" | "title";
const POST_SORTS: readonly PostSort[] = ["updated", "published", "title"];

export interface PostQuery {
  q?: string;
  status?: ContentStatus;
  kind?: string;
  tag?: string;
  /** v0.17.0, where the site filters by them: one of the post's authors, and a published range in whole days (YYYY-MM-DD, both included). */
  author?: string;
  from?: string;
  to?: string;
  /** v0.17.0, where the site has a trash: "1" lists only the trash. */
  trashed?: "1";
  sort?: PostSort;
  dir?: SortDir;
  cursor?: string;
}

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

export interface PostsData {
  site: { id: string; name: string };
  query: PostQuery;
  rows: PostRow[];
  page: {
    nextCursor: string | null;
    total?: number;
    /** True when the rows were sorted on this page only, because the site's list does not sort. */
    sortedOnPage?: boolean;
  };
  counts?: Partial<Record<ContentStatus | "all" | "trash", number>>;
  kinds: string[];
  /**
   * `scheduledUpdates` (v0.10.0): the site keeps an update waiting on a live post, so reschedule and cancel work on it.
   * v0.17.0: `trash`, `rename` and `previewLinks` as the site's capabilities say, the list `filters` it applies, and the
   * `authors` on this page for the Author select.
   */
  offers: {
    delete: boolean;
    schedule: boolean;
    tags: boolean;
    duplicate: boolean;
    scheduledUpdates: boolean;
    trash: boolean;
    rename: boolean;
    previewLinks: boolean;
    /** v0.19.0: the site lists the posts that link to one, so a delete or a trash warns with them first. */
    backlinks: boolean;
    filters: ContentFilter[];
    authors: string[];
  };
  can: Permissions;
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
    return value && /^\d{4}-\d{2}-\d{2}$/.test(value) && Timestamp.safeParse(`${value}T00:00:00Z`).success ? value : undefined;
  };
  const [from, to] = [day("from"), day("to")];
  return {
    ...(dir === "asc" || dir === "desc" ? { dir } : {}),
    ...(q ? { q } : {}),
    ...(status && (["draft", "scheduled", "published"] as const).includes(status as ContentStatus) ? { status: status as ContentStatus } : {}),
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

function postRow(source: ContentSource, item: ContentSummary & { version?: string; tags?: string[] }): PostRow {
  return {
    id: item.id,
    title: item.title || item.id,
    kind: item.kind,
    status: item.status,
    path: item.path,
    href: source.editorHref(item.id),
    liveHref: item.status === "published" && item.path ? absolute(source.site.origin, item.path) : null,
    publishAt: item.publishAt,
    publishedAt: item.publishedAt,
    updatedAt: item.updatedAt,
    ...(item.scheduledUpdate
      ? { scheduledUpdate: { publishAt: item.scheduledUpdate.publishAt, href: source.scheduleHref ? source.scheduleHref(item.id) : source.editorHref(item.id) } }
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
  published: (a, b) => (b.publishedAt ?? b.publishAt ?? "").localeCompare(a.publishedAt ?? a.publishAt ?? ""),
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
    ...(query.from && filters.includes("published") ? { publishedAfter: `${query.from}T00:00:00.000Z` } : {}),
    ...(query.to && filters.includes("published") ? { publishedBefore: `${query.to}T23:59:59.999Z` } : {}),
    ...(query.trashed && trash ? { trashed: true } : {}),
  };
  // A host's own index answers only the plain list; a filtered one comes from the site, which says what it applied.
  const lister = Object.keys(onSite).length > 0 ? source.client : (source.postIndex ?? source.client);
  const base = { ...(query.q ? { q: query.q } : {}), ...(query.sort ? { sort: query.sort, ...(query.dir ? { dir: query.dir } : {}) } : {}) };
  const list = await lister.list({ limit: PER_PAGE, ...base, ...onSite, ...(query.status ? { status: query.status } : {}), ...(query.cursor ? { cursor: query.cursor } : {}) });
  let rows = list.items.map((item) => postRow(source, item));
  const kinds = [...new Set(rows.map((r) => r.kind))].sort();
  const authors = [...new Set(rows.flatMap((r) => r.authors ?? []))].sort();
  if (query.kind && !onSite.kind) rows = rows.filter((r) => r.kind === query.kind);
  if (query.tag && !onSite.tag) rows = rows.filter((r) => (r.tags ?? []).some((t) => sameTag(t, query.tag!)));
  // A site that sorted says so (v0.6.0); otherwise the kit sorts the page it has and says that.
  const sortedOnPage = query.sort !== undefined && list.sorted === undefined;
  if (sortedOnPage) {
    const dir = query.dir ?? (query.sort === "title" ? "asc" : "desc");
    rows = [...rows].sort((a, b) => (dir === (query.sort === "title" ? "asc" : "desc") ? 1 : -1) * BY[query.sort!](a, b));
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
    counts = { all: query.status || query.trashed ? totals.reduce((n, t) => n + (t.total ?? 0), 0) : list.total };
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
    page: { nextCursor: list.nextCursor, ...(list.total !== undefined ? { total: list.total } : {}), ...(sortedOnPage ? { sortedOnPage } : {}) },
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
const hasTrash = (capabilities: Capabilities | null) => capabilities?.contentTrash === true;

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

/** The update waiting on a live post, with what it changes, for the page that shows its source (v0.10.0). */
export interface ScheduledUpdateView {
  id: string;
  title: string;
  publishAt: string;
  /** "2030-01-01 15:00 UTC". */
  when: string;
  scheduledAt: string;
  /** The update's own source, and the live one it replaces, for a side-by-side compare. */
  source: string;
  live: { source: string; version: string; href: string | null };
  /** A unified diff from the live source to the update's. */
  patch: string;
  editorHref: string;
  can: Permissions;
}

/** The update waiting on one post, or null when nothing waits (or the site keeps no scheduled updates). */
export async function loadScheduledUpdate(source: ContentSource, id: string): Promise<ScheduledUpdateView | null> {
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
    live: { source: doc.source, version: doc.version, href: doc.path ? absolute(source.site.origin, doc.path) : null },
    patch: createTwoFilesPatch(`${id} (live)`, `${id} (scheduled)`, doc.source, update.source),
    editorHref: source.editorHref(id),
    can: source.can,
  };
}

const POST_INTENTS = [
  "tag-add", "tag-remove", "duplicate", "unpublish", "republish", "delete", "reschedule", "cancel-schedule", "trash", "restore", "rename", "preview-link",
] as const;
export type PostIntent = (typeof POST_INTENTS)[number];

/** A tag as a post's frontmatter list can hold it: one short piece of text with nothing that would break the list. */
function cleanPostTag(raw: string): string | null {
  const tag = raw.trim();
  return ContentTag.safeParse(tag).success ? tag : null;
}

const sameTag = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const COPY_TRIES = 50;

/**
 * Runs one posted intent on one site's posts, each post its own write, in order. The person's
 * permission is checked once before the site is asked anything; a post whose own state needs more
 * (a live post, for someone who may not publish) is refused alone and the rest go on.
 */
export async function runPostsIntent(source: ContentSource, input: IntentInput): Promise<IntentResult> {
  const intent = text(input, "intent") as PostIntent;
  if (!POST_INTENTS.includes(intent)) return refused("That is not something the posts list can do.");
  const need: keyof Permissions =
    intent === "delete" ? "deleteContent" : intent === "unpublish" || intent === "republish" || intent === "reschedule" || intent === "cancel-schedule" ? "publish" : "edit";
  if (!source.can[need]) return refused(NOT_YOURS[need]);
  // Rename and a preview link name one post, and a rename one new id for it.
  if ((intent === "rename" || intent === "preview-link") && texts(input, "ids").length !== 1) return refused("Choose one post.");
  const newId = intent === "rename" ? text(input, "newId").trim() : "";
  if (intent === "rename" && !ContentId.safeParse(newId).success) {
    return refused("A new id is lowercase letters, digits and hyphens, and may have / between parts.");
  }

  const { targets, invalid } = targetsOf(input, ContentId);
  const tooMany = checkCount(targets.length + invalid.length, "post");
  if (tooMany) return tooMany;
  const early: Outcome[] = invalid.map((id) => ({ id, ok: false, message: "That is not a post id, so it was not sent to the site." }));

  let tag: string | null = null;
  if (intent === "tag-add" || intent === "tag-remove") {
    tag = cleanPostTag(text(input, "tag"));
    if (tag === null) return refused("A tag is one short piece of text, with no commas, brackets, quotes or colons.");
  }
  // A reschedule names one new time for every post, or (its Undo) one time per post in the order of `ids`.
  const times = texts(input, "publishAts");
  const time = text(input, "publishAt");
  if (intent === "reschedule" && !(times.length > 0 ? times.every((t) => Timestamp.safeParse(t).success) : Timestamp.safeParse(time).success)) {
    return refused("Choose the new time, with its time zone.");
  }
  const newTime = (id: string) => (times.length > 0 ? times[texts(input, "ids").indexOf(id)] : time) ?? time;
  const undoTimes: string[] = [];
  let capabilities: Capabilities | null = null;
  if (intent !== "unpublish" && intent !== "republish") capabilities = (await source.client.meta()).capabilities;
  if (intent === "delete" && capabilities?.contentDelete !== true) return refused("This site does not delete posts through the site API.");
  if ((intent === "trash" || intent === "restore") && !hasTrash(capabilities)) return refused("This site has no trash for posts.");
  if (intent === "rename" && capabilities?.contentRename !== true) return refused("This site does not rename posts through the site API.");
  if (intent === "preview-link" && capabilities?.previewLinks !== true) return refused("This site does not make preview links.");
  // v0.19.0: where the site lists backlinks, the posts that link to each one about to go, for the confirm to warn with.
  const linked = async () => {
    if (capabilities?.backlinks !== true || text(input, "confirm") !== "") return [];
    const found = await Promise.all(targets.map(async (t) => ({ id: t.id, linkedFrom: (await orNull(source.client.backlinks(t.id)))?.items ?? [] })));
    return found.filter((b) => b.linkedFrom.length > 0);
  };
  const warning = (backlinks: Array<{ linkedFrom: unknown[] }>) => {
    const linking = backlinks.reduce((n, b) => n + b.linkedFrom.length, 0);
    return linking > 0 ? ` ${plural(linking, "link")} from other posts will break: the list is below.` : "";
  };
  if (intent === "delete" && targets.length > 0) {
    const backlinks = await linked();
    const ask = askFirst(input, {
      intent,
      title: `Delete ${plural(targets.length, "post")} for good?`,
      lead: "Each post leaves the site, and nothing here can bring it back." + warning(backlinks),
      action: "Delete for good",
      items: targets.map((t) => t.id),
      fields: { ids: targets.map((t) => t.id), versions: targets.map((t) => t.version ?? "") },
    });
    if (ask) return backlinks.length > 0 ? { ...ask, confirm: { ...ask.confirm!, backlinks } } : ask;
  }
  // A trash can be undone, so it asks only when other posts link to one of them.
  if (intent === "trash" && targets.length > 0) {
    const backlinks = await linked();
    if (backlinks.length > 0) {
      const ask = askFirst(input, {
        intent,
        title: `Move ${plural(targets.length, "post")} to the Trash?`,
        lead: `A live post leaves the site.${warning(backlinks)}`,
        action: "Move to the Trash",
        items: targets.map((t) => t.id),
        fields: { ids: targets.map((t) => t.id), versions: targets.map((t) => t.version ?? "") },
      });
      if (ask) return { ...ask, confirm: { ...ask.confirm!, backlinks } };
    }
  }

  const client = actingClient(source.client, source.actor);
  const read = async (id: string, version: string | null): Promise<ContentDoc> => {
    const doc = await client.get(id);
    if (version !== null && doc.version !== version) throw new Conflict(doc.version);
    return doc;
  };
  const held = async (id: string): Promise<string | null> => (source.hold ? source.hold(intent, id) : null);
  const undoIds: string[] = [];
  const undoVersions: string[] = [];
  let notUndoable = 0;
  const renamed: { from?: string } = {};
  let previewLink: IntentResult["previewLink"];

  const { outcomes, conflict } = await eachItem(source, targets, "post", async ({ id, version }): Promise<Outcome> => {
    const hold = await held(id);
    if (hold) return { id, ok: false, message: hold };
    switch (intent) {
      case "tag-add":
      case "tag-remove": {
        const doc = await read(id, version);
        if (doc.status !== "draft" && !source.can.publish) return { id, ok: false, message: LIVE_POST };
        // A site that keeps tags (v0.6.0) writes them through its own route; otherwise the frontmatter is rewritten, as Carrel did.
        const viaRoute = capabilities?.contentTags === true;
        const parts = splitSource(doc.source);
        if (!viaRoute && parts.front === null) return { id, ok: false, message: "This post has no frontmatter, so it has no tags to change." };
        const tags = viaRoute ? (doc.tags ?? []) : tagsOf(parts.front);
        const has = tags.some((t) => sameTag(t, tag!));
        if (intent === "tag-add" && has) return { id, ok: true, message: `Already tagged "${tag}". Not changed.` };
        if (intent === "tag-remove" && !has) return { id, ok: true, message: `Did not have the tag "${tag}". Not changed.` };
        const next = intent === "tag-add" ? [...tags, tag!] : tags.filter((t) => !sameTag(t, tag!));
        const change = changeId();
        const written = viaRoute
          ? await client.setTags(id, { tags: next, expectedVersion: doc.version, changeId: change })
          : await client.saveDraft(id, { source: joinSource({ ...parts, front: setTags(parts.front!, next) }), expectedVersion: doc.version, changeId: change });
        undoIds.push(id);
        undoVersions.push(written.version);
        const note = await recordDone(source, `post-${intent}`, id, change);
        const warning = liveSaveWarning(doc);
        return { id, ok: true, message: (intent === "tag-add" ? `Added the tag "${tag}".` : `Removed the tag "${tag}".`) + note + (warning ? ` ${warning}` : "") };
      }
      case "duplicate": {
        const doc = await read(id, version);
        const parts = splitSource(doc.source);
        if (parts.front === null) return { id, ok: false, message: "This post has no frontmatter, so it cannot be copied as a draft." };
        const copy = await freeCopyId(source, id);
        if (!copy) return { id, ok: false, message: "No unused id was found for the copy. Rename an earlier copy and try again." };
        let front = setRawKey(parts.front, "title", JSON.stringify(`${readKey(parts.front, "title") || id} (copy${copy.n > 1 ? ` ${copy.n}` : ""})`));
        // The site's own copy of the id sits in the file as well; a copy that kept the old one would clash with the original.
        if (/^slug:/m.test(front)) front = setRawKey(front, "slug", copy.id);
        front = setRawKey(front, "draft", "true");
        const change = changeId();
        let written;
        try {
          written = await client.saveDraft(copy.id, { source: joinSource({ ...parts, front }), expectedVersion: null, changeId: change });
        } catch (error) {
          if (error instanceof SiteApiError && error.body?.error === "version-conflict") {
            return { id, ok: false, message: "The id chosen for the copy was taken while this ran. Nothing was copied." };
          }
          throw error;
        }
        undoIds.push(copy.id);
        undoVersions.push(written.version);
        const note = await recordDone(source, "post-duplicate", copy.id, change);
        return { id, ok: true, message: `Copied as a draft with the id "${copy.id}".` + note, copyId: copy.id };
      }
      case "unpublish": {
        const doc = await read(id, version);
        if (doc.status === "draft") return { id, ok: true, message: "Not published, so there was nothing to unpublish." };
        const change = changeId();
        const written = await client.unpublish(id, { expectedVersion: doc.version, changeId: change });
        // Undo republishes, so only a post that has been public before gets one: never a first publication.
        if (doc.status === "published" && doc.publishedAt !== null) {
          undoIds.push(id);
          undoVersions.push(written.version);
        } else notUndoable++;
        const note = await recordDone(source, "post-unpublish", id, change);
        return { id, ok: true, message: (doc.status === "scheduled" ? "Unscheduled; it is a draft again." : "Unpublished; it is a draft again.") + note };
      }
      case "republish": {
        const doc = await read(id, version);
        if (doc.status !== "draft") return { id, ok: true, message: "Already live. Not changed." };
        if (doc.publishedAt === null) {
          return { id, ok: false, message: "This post has never been published, so it was not published here. A first publication is made from the editor." };
        }
        const change = changeId();
        const written = await client.publish(id, { expectedVersion: doc.version, changeId: change });
        undoIds.push(id);
        undoVersions.push(written.version);
        const note = await recordDone(source, "post-republish", id, change);
        return { id, ok: true, message: "Published again." + note };
      }
      case "reschedule": {
        const doc = await read(id, version);
        const publishAt = newTime(id)!;
        const change = changeId();
        let before: string;
        let written;
        if (doc.status === "published" && doc.scheduledUpdate) {
          // The update keeps its own source; only its time moves.
          const update = await client.scheduledUpdate(id);
          before = update.publishAt;
          written = await client.schedule(id, { expectedVersion: doc.version, changeId: change, publishAt, source: update.source });
        } else if (doc.status === "scheduled" && doc.publishAt) {
          before = doc.publishAt;
          written = await client.schedule(id, { expectedVersion: doc.version, changeId: change, publishAt });
        } else return { id, ok: false, message: "Nothing is scheduled for this post. Schedule it from the editor." };
        undoIds.push(id);
        undoVersions.push(written.version);
        undoTimes.push(before);
        const note = await recordDone(source, "post-reschedule", id, change);
        return { id, ok: true, message: `Rescheduled for ${scheduleLabel(publishAt)}.` + note };
      }
      case "cancel-schedule": {
        const doc = await read(id, version);
        const change = changeId();
        let message: string;
        if (doc.status === "published" && doc.scheduledUpdate) {
          await client.cancelSchedule(id, { expectedVersion: doc.version, changeId: change });
          message = "Canceled the scheduled update; the live post stays as it is.";
        } else if (doc.status === "scheduled") {
          // A site with no scheduled updates cancels a scheduled post by returning it to draft, as unpublish does.
          if (capabilities?.scheduledUpdates === true) await client.cancelSchedule(id, { expectedVersion: doc.version, changeId: change });
          else await client.unpublish(id, { expectedVersion: doc.version, changeId: change });
          message = "Unscheduled; it is a draft again.";
        } else return { id, ok: true, message: "Nothing was scheduled. Not changed." };
        notUndoable++;
        const note = await recordDone(source, "post-cancel-schedule", id, change);
        return { id, ok: true, message: message + note };
      }
      case "delete": {
        const doc = await read(id, version);
        // Where the site has a trash, only a post already in it is deleted for good.
        if (hasTrash(capabilities) && !doc.trashedAt) return { id, ok: false, message: "Move this post to the Trash first; it is deleted for good from there." };
        const change = changeId();
        await client.delete(id, { expectedVersion: doc.version, changeId: change });
        const note = await recordDone(source, "post-delete", id, change);
        return { id, ok: true, message: "Deleted from the site." + note };
      }
      case "trash": {
        const doc = await read(id, version);
        if (doc.trashedAt) return { id, ok: true, message: "Already in the Trash. Not changed." };
        if (doc.status !== "draft" && !source.can.publish) return { id, ok: false, message: LIVE_POST };
        const change = changeId();
        const written = await client.trash(id, { expectedVersion: doc.version, changeId: change });
        undoIds.push(id);
        undoVersions.push(written.version);
        const note = await recordDone(source, "post-trash", id, change);
        return { id, ok: true, message: (doc.status === "draft" ? "Moved to the Trash." : "Taken off the site and moved to the Trash.") + note };
      }
      case "restore": {
        const doc = await read(id, version);
        if (!doc.trashedAt) return { id, ok: true, message: "Not in the Trash. Not changed." };
        const change = changeId();
        const written = await client.restore(id, { expectedVersion: doc.version, changeId: change });
        undoIds.push(id);
        undoVersions.push(written.version);
        const note = await recordDone(source, "post-restore", id, change);
        return { id, ok: true, message: "Restored as a draft." + note };
      }
      case "rename": {
        const doc = await read(id, version);
        if (doc.status !== "draft" && !source.can.publish) return { id, ok: false, message: "Renaming a live post changes its public address, which is a publish, so it was left as it was." };
        if (newId === id) return { id, ok: true, message: "That is its id already. Not changed." };
        const change = changeId();
        const written = await client.rename(id, { newId, expectedVersion: doc.version, changeId: change });
        undoIds.push(newId);
        undoVersions.push(written.version);
        renamed.from = id;
        const note = await recordDone(source, "post-rename", newId, change);
        const moved = written.previousPath ? ` Its old address ${written.previousPath} now redirects to the new one.` : "";
        return { id, ok: true, message: `Renamed to "${newId}".` + moved + note };
      }
      case "preview-link": {
        await read(id, version);
        // v0.19.0: how long it lives, where the form says and the site takes it; else the site's 48 hours.
        const hours = Number(text(input, "expiresInHours"));
        const max = capabilities?.previewLinkHours?.max;
        const expiresInHours = max && Number.isInteger(hours) && hours >= 1 && hours <= max ? hours : undefined;
        const link = await client.previewLinks.create({ id, changeId: changeId(), ...(expiresInHours ? { expiresInHours } : {}) });
        previewLink = { url: link.url, expiresAt: link.expiresAt };
        return { id, ok: true, message: `Made a preview link that works until ${scheduleLabel(link.expiresAt)}.` };
      }
    }
  });

  const all = [...early, ...outcomes];
  const extra: Partial<IntentResult> = { ...(conflict ? { conflict } : {}), ...(previewLink ? { previewLink } : {}) };
  let tail = "";
  if (undoIds.length > 0) {
    const inverse = undoIntent(intent, capabilities, source.can);
    if (inverse) {
      extra.undo = {
        intent: inverse,
        fields: {
          ids: undoIds,
          versions: undoVersions,
          ...(tag ? { tag } : {}),
          ...(undoTimes.length ? { publishAts: undoTimes } : {}),
          ...(renamed.from ? { newId: renamed.from } : {}),
          ...(inverse === "delete" ? { confirm: String(undoIds.length) } : {}),
        },
      };
    }
    else if (intent === "duplicate") {
      tail =
        capabilities?.contentDelete === true
          ? " Deleting a post is the Owner's step, so ask the Owner to remove a copy you do not want."
          : " This site does not delete posts through the site API, so remove a copy you do not want in the site's own admin.";
    }
  }
  if (notUndoable > 0) {
    tail +=
      intent === "cancel-schedule"
        ? " A canceled schedule has no Undo; schedule it again from the editor."
        : " A post that was only scheduled has no Undo; schedule it again from the editor.";
  }
  return result(all, summarize(all, DONE[intent], "post") + tail, extra);
}

const DONE: Record<PostIntent, string> = {
  "tag-add": "Tagged",
  "tag-remove": "Untagged",
  duplicate: "Copied",
  unpublish: "Unpublished",
  republish: "Republished",
  delete: "Deleted",
  reschedule: "Rescheduled",
  "cancel-schedule": "Canceled the schedule of",
  trash: "Moved to the Trash",
  restore: "Restored",
  rename: "Renamed",
  "preview-link": "Made a preview link for",
};

const LIVE_POST = "Changing a live post is a publish, which is not yours to do here, so this one was left as it was.";

/** The inverse of a posts intent, or null when it has none here. */
function undoIntent(intent: PostIntent, capabilities: Capabilities | null, can: Permissions): string | null {
  switch (intent) {
    case "tag-add":
      return "tag-remove";
    case "tag-remove":
      return "tag-add";
    case "unpublish":
      return "republish";
    case "republish":
      return "unpublish";
    case "duplicate":
      // Undo trashes the copy where the site has a trash; else deletes it, at the version the duplicate made, where the site deletes and the person may.
      if (hasTrash(capabilities)) return "trash";
      return capabilities?.contentDelete === true && can.deleteContent ? "delete" : null;
    case "trash":
      return "restore";
    case "restore":
      return "trash";
    case "rename":
      // Back to the old id; the redirect the first rename left stays, which is harmless.
      return "rename";
    case "reschedule":
      // Back to the times they had, one per post.
      return "reschedule";
    case "delete":
    case "cancel-schedule":
    case "preview-link":
      return null;
  }
}

/** The first of id-copy, id-copy-2, ... that neither the site nor the host already uses. */
async function freeCopyId(source: ContentSource, id: string): Promise<{ id: string; n: number } | null> {
  for (let n = 1; n <= COPY_TRIES; n++) {
    const candidate = n === 1 ? `${id}-copy` : `${id}-copy-${n}`;
    if (!ContentId.safeParse(candidate).success) return null;
    if (source.taken && (await source.taken(candidate))) continue;
    if ((await orNull(source.client.get(candidate))) === null) return { id: candidate, n };
  }
  return null;
}
