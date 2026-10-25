// The posts half of the content kit: PostsList's view data and its intents.

import { SiteApiError } from "../client.js";
import {
  ContentId,
  ContentTag,
  type Capabilities,
  type ContentDoc,
  type ContentStatus,
  type ContentSummary,
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
} from "./kit.js";


export type PostSort = "updated" | "published" | "title";
const POST_SORTS: readonly PostSort[] = ["updated", "published", "title"];

export interface PostQuery {
  q?: string;
  status?: ContentStatus;
  kind?: string;
  tag?: string;
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
  /** Present when the site's list carries it. */
  version?: string;
  tags?: string[];
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
  counts?: Partial<Record<ContentStatus | "all", number>>;
  kinds: string[];
  offers: { delete: boolean; schedule: boolean; tags: boolean; duplicate: boolean };
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
  return {
    ...(dir === "asc" || dir === "desc" ? { dir } : {}),
    ...(q ? { q } : {}),
    ...(status && (["draft", "scheduled", "published"] as const).includes(status as ContentStatus) ? { status: status as ContentStatus } : {}),
    ...(kind ? { kind } : {}),
    ...(tag ? { tag } : {}),
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
    ...(item.version ? { version: item.version } : {}),
    ...(item.tags ? { tags: item.tags } : {}),
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
  const lister = source.postIndex ?? source.client;
  const base = { ...(query.q ? { q: query.q } : {}), ...(query.sort ? { sort: query.sort, ...(query.dir ? { dir: query.dir } : {}) } : {}) };
  const list = await lister.list({ limit: PER_PAGE, ...base, ...(query.status ? { status: query.status } : {}), ...(query.cursor ? { cursor: query.cursor } : {}) });
  let rows = list.items.map((item) => postRow(source, item));
  const kinds = [...new Set(rows.map((r) => r.kind))].sort();
  // The contract has no kind or tag filter, so these work on the page the site sent.
  if (query.kind) rows = rows.filter((r) => r.kind === query.kind);
  if (query.tag) rows = rows.filter((r) => (r.tags ?? []).some((t) => sameTag(t, query.tag!)));
  // A site that sorted says so (v0.6.0); otherwise the kit sorts the page it has and says that.
  const sortedOnPage = query.sort !== undefined && list.sorted === undefined;
  if (sortedOnPage) {
    const dir = query.dir ?? (query.sort === "title" ? "asc" : "desc");
    rows = [...rows].sort((a, b) => (dir === (query.sort === "title" ? "asc" : "desc") ? 1 : -1) * BY[query.sort!](a, b));
  }
  // Where the site counts (v0.6.0), each status tab gets its count for the same search.
  let counts: PostsData["counts"];
  if (list.total !== undefined) {
    const statuses = ["draft", "scheduled", "published"] as const;
    const totals = await Promise.all(statuses.map((status) => lister.list({ limit: 1, ...(query.q ? { q: query.q } : {}), status })));
    counts = { all: query.status ? totals.reduce((n, t) => n + (t.total ?? 0), 0) : list.total };
    statuses.forEach((status, i) => (counts![status] = totals[i]!.total ?? 0));
  }
  if (source.notes && rows.length > 0) {
    const notes = await source.notes(rows.map((r) => r.id));
    rows = rows.map((r) => (notes[r.id]?.length ? { ...r, notes: notes[r.id] } : r));
  }
  return {
    site: { id: source.site.id, name: source.site.name },
    query,
    rows,
    page: { nextCursor: list.nextCursor, ...(list.total !== undefined ? { total: list.total } : {}), ...(sortedOnPage ? { sortedOnPage } : {}) },
    ...(counts ? { counts } : {}),
    kinds,
    offers: { delete: meta.capabilities.contentDelete === true, schedule: true, tags: true, duplicate: true },
    can: source.can,
  };
}

const POST_INTENTS = ["tag-add", "tag-remove", "duplicate", "unpublish", "republish", "delete"] as const;
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
  const need: keyof Permissions = intent === "delete" ? "deleteContent" : intent === "unpublish" || intent === "republish" ? "publish" : "edit";
  if (!source.can[need]) return refused(NOT_YOURS[need]);

  const { targets, invalid } = targetsOf(input, ContentId);
  const tooMany = checkCount(targets.length + invalid.length, "post");
  if (tooMany) return tooMany;
  const early: Outcome[] = invalid.map((id) => ({ id, ok: false, message: "That is not a post id, so it was not sent to the site." }));

  let tag: string | null = null;
  if (intent === "tag-add" || intent === "tag-remove") {
    tag = cleanPostTag(text(input, "tag"));
    if (tag === null) return refused("A tag is one short piece of text, with no commas, brackets, quotes or colons.");
  }
  let capabilities: Capabilities | null = null;
  if (intent !== "unpublish" && intent !== "republish") capabilities = (await source.client.meta()).capabilities;
  if (intent === "delete" && capabilities?.contentDelete !== true) return refused("This site does not delete posts through the site API.");

  const client = source.client;
  const read = async (id: string, version: string | null): Promise<ContentDoc> => {
    const doc = await client.get(id);
    if (version !== null && doc.version !== version) throw new Conflict(doc.version);
    return doc;
  };
  const held = async (id: string): Promise<string | null> => (source.hold ? source.hold(intent, id) : null);
  const undoIds: string[] = [];
  const undoVersions: string[] = [];
  let notUndoable = 0;

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
        return { id, ok: true, message: (intent === "tag-add" ? `Added the tag "${tag}".` : `Removed the tag "${tag}".`) + note };
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
      case "delete": {
        const doc = await read(id, version);
        const change = changeId();
        await client.delete(id, { expectedVersion: doc.version, changeId: change });
        const note = await recordDone(source, "post-delete", id, change);
        return { id, ok: true, message: "Deleted from the site." + note };
      }
    }
  });

  const all = [...early, ...outcomes];
  const extra: Partial<IntentResult> = conflict ? { conflict } : {};
  let tail = "";
  if (undoIds.length > 0) {
    const inverse = undoIntent(intent, capabilities, source.can);
    if (inverse) extra.undo = { intent: inverse, fields: { ids: undoIds, versions: undoVersions, ...(tag ? { tag } : {}) } };
    else if (intent === "duplicate") {
      tail =
        capabilities?.contentDelete === true
          ? " Deleting a post is the Owner's step, so ask the Owner to remove a copy you do not want."
          : " This site does not delete posts through the site API, so remove a copy you do not want in the site's own admin.";
    }
  }
  if (notUndoable > 0) tail += ` A post that was only scheduled has no Undo; schedule it again from the editor.`;
  return result(all, summarize(all, DONE[intent], "post") + tail, extra);
}

const DONE: Record<PostIntent, string> = {
  "tag-add": "Tagged",
  "tag-remove": "Untagged",
  duplicate: "Copied",
  unpublish: "Unpublished",
  republish: "Republished",
  delete: "Deleted",
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
      // Undo deletes the copy, at the version the duplicate made: only where the site deletes and the person may.
      return capabilities?.contentDelete === true && can.deleteContent ? "delete" : null;
    case "delete":
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
