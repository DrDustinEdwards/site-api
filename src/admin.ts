// The content kit: the server half of the shared posts, media and mentions screens (Capsomer's
// PostsList, MediaLibrary and MentionsList). Server only: it holds the site client, so the key never
// reaches a browser. It does three things and no more:
//
//   - turns a site client into the plain view data a component renders (loadPosts, loadMedia, loadMentions);
//   - turns a posted intent into contract calls, each with the version the person saw and a fresh change id;
//   - returns an IntentResult naming the inverse intent when the action can be undone.
//
// The host (Carrel, or a site's own admin) signs the person in, decides what they may do, picks the
// site and supplies a ContentSource. Carrel passes createSiteClient({ baseUrl, key }); a site's own
// admin passes localClient(adapter), so both run this code against the same contract. Every rule of
// the site's own stays behind the contract; the kit adds only "who may" and "what the inverse is".
//
// Lifted from Carrel's app/lib/bulk.server.ts, media.server.ts and mentions.server.ts.

import { SiteApiError, type SiteClient } from "./client.js";
import {
  ContentId,
  ContentTag,
  MEDIA_SORTS,
  MediaId,
  MediaLens,
  MediaTag,
  MentionId,
  MentionStatus,
  Version,
  type Capabilities,
  type ContentDoc,
  type ContentList,
  type ListQuery,
  type ContentStatus,
  type ContentSummary,
  type SortDir,
  type MediaDetail,
  type MediaItem,
  type MediaSort,
  type MediaUploadLimits,
  type MediaUse,
  type MentionCounts,
  type MentionItem,
  type MentionList,
} from "./contract.js";
import { joinSource, readKey, setRawKey, setTags, splitSource, tagsOf } from "./frontmatter.js";

export { localClient } from "./local.js";

// ---------- what the host supplies

/** What this person may do on this site. The kit refuses an intent the person may not run, whatever the form says. */
export interface Permissions {
  /** Tag, duplicate, upload, edit alt text and tags, trash and restore. */
  edit: boolean;
  /** Change what the public sees: unpublish, republish, and any write to a post that is not a draft. */
  publish: boolean;
  deleteContent: boolean;
  deleteMedia: boolean;
  decideMentions: boolean;
}

/** A host-supplied fact about one row, such as "2 AI drafts waiting" or "New draft". */
export interface RowNote {
  text: string;
  tone?: "info" | "warning";
}

export interface ContentSource {
  site: { id: string; name: string; origin: string };
  /** createSiteClient({ baseUrl, key }) in Carrel; localClient(adapter) in a site's own admin. */
  client: SiteClient;
  can: Permissions;
  /** Where a row's title links: Carrel's editor, or the site's own. */
  editorHref(id: string): string;
  /** Optional: a faster list than the site's own, such as Carrel's search index. Same answer as client.list. */
  postIndex?: { list(query: Partial<ListQuery> & { limit: number }): Promise<ContentList> };
  /** Optional: notes per post id, for the rows on this page. */
  notes?(ids: string[]): Promise<Record<string, RowNote[]>>;
  /** Optional: how many posts the host has something waiting on (Carrel's AI drafts), for summary(). */
  waiting?(): Promise<number>;
  /** Optional: a host reason to leave one post alone, such as Carrel's unsaved working draft of it. null lets it go on. */
  hold?(intent: string, id: string): Promise<string | null>;
  /** Optional: true for an id the host already uses that the site does not know yet, so a copy never takes it. */
  taken?(id: string): Promise<boolean>;
  /** Optional: records who did what. Called once per item the site carried out, with the change id sent for it. */
  record?(change: { kind: string; ids: string[]; changeId: string }): Promise<void>;
  /** Where unexpected failures are logged. Defaults to console.error. */
  log?(entry: Record<string, unknown>): void;
}

// ---------- what an intent returns

/** The fields a form posts. A list (ids, versions) is an array; one value is a string. An upload's file is a Blob. */
export type Fields = Record<string, string | string[]>;
export type IntentInput = FormData | Record<string, string | string[] | Blob>;

export interface Outcome {
  id: string;
  ok: boolean;
  message: string;
  usedBy?: MediaUse[];
  /** The new copy's id, after a duplicate. */
  copyId?: string;
}

export interface IntentResult {
  ok: boolean;
  /** One sentence for the message region. */
  message: string;
  outcomes?: Outcome[];
  /** The inverse, as the fields to post with it, versions included. Absent when the action cannot be undone. */
  undo?: { intent: string; fields: Fields };
  /** Set when one item changed on the site since the person saw it. */
  conflict?: { id: string; currentVersion: string | null };
}

/** The most items one intent acts on, as the site's own bulk route allows. */
export const MAX_INTENT_ITEMS = 100;
export const PER_PAGE = 50;

// ---------- shared plumbing

function fieldOf(input: IntentInput, name: string): Array<string | Blob> {
  if (input instanceof FormData) return input.getAll(name) as Array<string | Blob>;
  const value = input[name];
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function texts(input: IntentInput, name: string): string[] {
  return fieldOf(input, name).filter((v): v is string => typeof v === "string");
}

function text(input: IntentInput, name: string): string {
  return texts(input, name)[0] ?? "";
}

function refused(message: string): IntentResult {
  return { ok: false, message };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function changeId(): string {
  return crypto.randomUUID();
}

function logOf(source: ContentSource) {
  return source.log ?? ((entry: Record<string, unknown>) => console.error(JSON.stringify(entry)));
}

/** Records one done item. A record that cannot be written is said in the outcome, never hidden. */
async function recordDone(source: ContentSource, kind: string, id: string, change: string): Promise<string> {
  if (!source.record) return "";
  try {
    await source.record({ kind, ids: [id], changeId: change });
    return "";
  } catch (error) {
    logOf(source)({ contentKit: "record-failed", kind, id, changeId: change, error: String(error) });
    return " The record of it could not be saved.";
  }
}

/**
 * The ids and their versions, as the form sent them: `ids` and, when the person saw them, `versions`
 * in the same order. Unique, each shaped as the site could hold it; anything else is reported, not sent.
 */
function targetsOf(
  input: IntentInput,
  shape: { safeParse(v: unknown): { success: boolean } },
): { targets: Array<{ id: string; version: string | null; status: string | null }>; invalid: string[] } {
  const ids = texts(input, "ids");
  const versions = texts(input, "versions");
  const statuses = texts(input, "statuses");
  const targets: Array<{ id: string; version: string | null; status: string | null }> = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  ids.forEach((id, i) => {
    if (seen.has(id)) return;
    seen.add(id);
    const version = versions[i] ?? "";
    if (!shape.safeParse(id).success || (version !== "" && !Version.safeParse(version).success)) invalid.push(id || "(no id)");
    else targets.push({ id, version: version === "" ? null : version, status: statuses[i] || null });
  });
  return { targets, invalid };
}

function checkCount(total: number, noun: string): IntentResult | null {
  if (total === 0) return refused(`Choose at least one ${noun}.`);
  if (total > MAX_INTENT_ITEMS) return refused(`At most ${MAX_INTENT_ITEMS} ${noun}s at a time.`);
  return null;
}

/** The message for a whole run: what was done, and how many were left as they were. */
function summarise(outcomes: Outcome[], done: string, noun: string): string {
  const ok = outcomes.filter((o) => o.ok).length;
  const left = outcomes.length - ok;
  if (left === 0) return `${done} ${plural(ok, noun)}.`;
  if (ok === 0) return `Nothing was changed: ${plural(left, noun)} left as ${left === 1 ? "it was" : "they were"}.`;
  return `${done} ${plural(ok, noun)}; ${left} left as ${left === 1 ? "it was" : "they were"}.`;
}

function result(outcomes: Outcome[], message: string, extra: Partial<IntentResult> = {}): IntentResult {
  return { ok: outcomes.length > 0 && outcomes.every((o) => o.ok), message, outcomes, ...extra };
}

/** A 404 from the site, as null; anything else is the caller's to handle. */
async function orNull<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof SiteApiError && (error.status === 404 || error.status === 400)) return null;
    throw error;
  }
}

class Conflict extends Error {
  constructor(readonly currentVersion: string | null) {
    super("conflict");
  }
}

/** What went wrong for one item, said plainly. Anything unexpected is logged and reported, never dropped. */
function failure(source: ContentSource, id: string, error: unknown, noun: string): Outcome & { currentVersion?: string | null } {
  if (error instanceof Conflict) {
    return { id, ok: false, message: `This ${noun} changed on the site since the page loaded. It was left as it was.`, currentVersion: error.currentVersion };
  }
  if (error instanceof SiteApiError) {
    if (error.body?.error === "version-conflict") {
      return { id, ok: false, message: `This ${noun} changed on the site since the page loaded. It was left as it was.`, currentVersion: error.body.currentVersion ?? null };
    }
    if (error.status === 404) return { id, ok: false, message: `The site does not have this ${noun}. It may have been deleted.` };
    if (error.status === 501) return { id, ok: false, message: "This site does not offer that." };
    if (error.body?.error === "refused") return { id, ok: false, message: error.body.message, ...(error.body.usedBy ? { usedBy: error.body.usedBy } : {}) };
  }
  logOf(source)({ contentKit: "item-failed", id, error: error instanceof SiteApiError ? `site ${error.status} ${error.body?.error ?? ""}` : String(error) });
  return { id, ok: false, message: `The site did not accept this change. The ${noun} was left as it was.` };
}

/** Runs each item in order. One failing never stops the rest; the first conflict is named on the result. */
async function eachItem<T extends { id: string }>(
  source: ContentSource,
  items: T[],
  noun: string,
  run: (item: T) => Promise<Outcome>,
): Promise<{ outcomes: Outcome[]; conflict?: { id: string; currentVersion: string | null } }> {
  const outcomes: Outcome[] = [];
  let conflict: { id: string; currentVersion: string | null } | undefined;
  for (const item of items) {
    try {
      outcomes.push(await run(item));
    } catch (error) {
      const { currentVersion, ...outcome } = failure(source, item.id, error, noun);
      if (currentVersion !== undefined && !conflict) conflict = { id: item.id, currentVersion };
      outcomes.push(outcome);
    }
  }
  return { outcomes, ...(conflict ? { conflict } : {}) };
}

function absolute(origin: string, url: string): string {
  return url.startsWith("/") ? `${origin.replace(/\/+$/, "")}${url}` : url;
}

// ---------- posts

export type PostSort = "updated" | "published" | "title";
export const POST_SORTS: readonly PostSort[] = ["updated", "published", "title"];

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

export const POST_INTENTS = ["tag-add", "tag-remove", "duplicate", "unpublish", "republish", "delete"] as const;
export type PostIntent = (typeof POST_INTENTS)[number];

/** A tag as a post's frontmatter list can hold it: one short piece of text with nothing that would break the list. */
export function cleanPostTag(raw: string): string | null {
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
  return result(all, summarise(all, DONE[intent], "post") + tail, extra);
}

const DONE: Record<PostIntent, string> = {
  "tag-add": "Tagged",
  "tag-remove": "Untagged",
  duplicate: "Copied",
  unpublish: "Unpublished",
  republish: "Republished",
  delete: "Deleted",
};

const NOT_YOURS: Record<keyof Permissions, string> = {
  edit: "You may not change posts on this site.",
  publish: "Changing what the public sees is not yours to do on this site.",
  deleteContent: "Deleting a post is the Owner's step.",
  deleteMedia: "Deleting a file for good is the Owner's step.",
  decideMentions: "Deciding mentions is not yours to do on this site.",
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

// ---------- media

export interface MediaQuery {
  q?: string;
  tag?: string;
  view?: "library" | "trash";
  /** v0.6.0, where the site names the lens; dropped, never sent, where it does not. */
  lens?: MediaLens;
  sort?: MediaSort;
  dir?: SortDir;
  cursor?: string;
  /** The file open in the inspector. */
  inspect?: string;
}

/** A file as the library shows it: the site's item, plus the absolute address a browser loads. */
export type MediaRow = MediaItem & { src: string };

export interface MediaData {
  site: { id: string; name: string };
  query: MediaQuery;
  rows: MediaRow[];
  page: {
    nextCursor: string | null;
    total?: number;
    /** True when the rows were sorted on this page only, because the site's list does not sort. */
    sortedOnPage?: boolean;
  };
  /** The file in the inspector with every place it is used; null when the site has no such file. */
  detail?: (MediaDetail & { src: string }) | null;
  offers: {
    /** False on a site with no media manager: every other offer is then false. */
    media: boolean;
    upload: MediaUploadLimits | null;
    alt: boolean;
    tags: boolean;
    trash: boolean;
    delete: boolean;
    /** The lenses the site answers (v0.6.0); empty where it answers none. */
    lenses: MediaLens[];
  };
  can: Permissions;
}

export function readMediaQuery(search: URLSearchParams): MediaQuery {
  const q = search.get("q")?.trim().slice(0, 200);
  const tag = search.get("tag")?.trim().toLowerCase();
  const cursor = search.get("cursor")?.slice(0, 500);
  const inspect = search.get("inspect") ?? "";
  const lens = MediaLens.safeParse(search.get("lens"));
  const sort = search.get("sort");
  const dir = search.get("dir");
  return {
    ...(q ? { q } : {}),
    ...(lens.success ? { lens: lens.data } : {}),
    ...(sort && (MEDIA_SORTS as readonly string[]).includes(sort) ? { sort: sort as MediaSort } : {}),
    ...(dir === "asc" || dir === "desc" ? { dir } : {}),
    ...(tag && MediaTag.safeParse(tag).success ? { tag } : {}),
    ...(search.get("view") === "trash" ? { view: "trash" as const } : {}),
    ...(cursor ? { cursor } : {}),
    ...(MediaId.safeParse(inspect).success ? { inspect } : {}),
  };
}

function mediaOffers(capabilities: Capabilities): MediaData["offers"] {
  const media = capabilities.media === true && capabilities.mediaUpload !== undefined;
  return {
    media,
    upload: media ? capabilities.mediaUpload! : null,
    alt: media && capabilities.mediaAlt === true,
    tags: media && capabilities.mediaTags === true,
    trash: media && capabilities.mediaTrash === true,
    delete: media,
    lenses: media ? [...(capabilities.mediaLenses ?? [])] : [],
  };
}

const MEDIA_BY: Record<MediaSort, (a: MediaItem, b: MediaItem) => number> = {
  added: (a, b) => (b.uploadedAt ?? "").localeCompare(a.uploadedAt ?? ""),
  size: (a, b) => b.bytes - a.bytes,
  name: (a, b) => (a.filename ?? a.id).localeCompare(b.filename ?? b.id),
};

/** One page of one site's media library, as MediaLibrary renders it. */
export async function loadMedia(source: ContentSource, query: MediaQuery = {}): Promise<MediaData> {
  const offers = mediaOffers((await source.client.meta()).capabilities);
  const base = { site: { id: source.site.id, name: source.site.name }, query, offers, can: source.can };
  if (!offers.media) return { ...base, rows: [], page: { nextCursor: null } };
  const list = await source.client.media.list({
    limit: PER_PAGE,
    ...(query.q ? { q: query.q } : {}),
    ...(query.tag && offers.tags ? { tag: query.tag } : {}),
    ...(query.view === "trash" && offers.trash ? { trashed: "only" as const } : {}),
    ...(query.lens && offers.lenses.includes(query.lens) ? { lens: query.lens } : {}),
    ...(query.sort ? { sort: query.sort, ...(query.dir ? { dir: query.dir } : {}) } : {}),
    ...(query.cursor ? { cursor: query.cursor } : {}),
  });
  let items = list.items;
  // A site that sorted says so (v0.6.0); otherwise the kit sorts the page it has and says that.
  const sortedOnPage = query.sort !== undefined && list.sorted === undefined;
  if (sortedOnPage) {
    const natural = query.sort === "name" ? "asc" : "desc";
    const flip = (query.dir ?? natural) === natural ? 1 : -1;
    items = [...items].sort((a, b) => flip * MEDIA_BY[query.sort!](a, b));
  }
  const rows = items.map((item) => ({ ...item, src: absolute(source.site.origin, item.url) }));
  let detail: MediaData["detail"];
  if (query.inspect) {
    const found = await orNull(source.client.media.get(query.inspect));
    detail = found ? { ...found, src: absolute(source.site.origin, found.url) } : null;
  }
  const page = { nextCursor: list.nextCursor, ...(list.total !== undefined ? { total: list.total } : {}), ...(sortedOnPage ? { sortedOnPage } : {}) };
  return { ...base, rows, page, ...(detail !== undefined ? { detail } : {}) };
}

export const MEDIA_INTENTS = ["upload", "alt", "tags", "tag-add", "tag-remove", "trash", "restore", "delete", "empty-trash"] as const;
export type MediaIntent = (typeof MEDIA_INTENTS)[number];

/** A typed list of tags (commas between them) as a tag set: each in the site's spelling, unique, at most 12. */
export function parseMediaTags(raw: string | string[]): { ok: true; tags: string[] } | { ok: false; message: string } {
  const tags: string[] = [];
  for (const part of (Array.isArray(raw) ? raw : [raw]).flatMap((r) => r.split(/[,\n]+/))) {
    if (part.trim() === "") continue;
    const tag = part.trim().toLowerCase().replace(/[\s_]+/g, "-");
    if (!MediaTag.safeParse(tag).success) {
      return { ok: false, message: `"${part.trim()}" cannot be a tag. A tag is lower case words and numbers joined by hyphens, up to 32 characters.` };
    }
    if (!tags.includes(tag)) tags.push(tag);
  }
  if (tags.length > 12) return { ok: false, message: "A file carries at most 12 tags." };
  return { ok: true, tags };
}

function megabytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

/** The most rounds one empty-trash intent sends; each round deletes up to the site's limit. */
const EMPTY_ROUNDS = 20;

/**
 * Runs one posted intent on one site's media library. Bulk intents go to the site as one bulk
 * request; the site answers file by file, and every file gets an outcome.
 */
export async function runMediaIntent(source: ContentSource, input: IntentInput): Promise<IntentResult> {
  const intent = text(input, "intent") as MediaIntent;
  if (!MEDIA_INTENTS.includes(intent)) return refused("That is not something the media library can do.");
  const need: keyof Permissions = intent === "delete" || intent === "empty-trash" ? "deleteMedia" : "edit";
  if (!source.can[need]) return refused(NOT_YOURS[need]);
  const offers = mediaOffers((await source.client.meta()).capabilities);
  if (!offers.media) return refused("This site has no media library.");
  const lacking =
    (intent === "alt" && !offers.alt) ||
    ((intent === "tags" || intent === "tag-add" || intent === "tag-remove") && !offers.tags) ||
    ((intent === "trash" || intent === "restore" || intent === "empty-trash") && !offers.trash);
  if (lacking) return refused("This site does not offer that.");

  if (intent === "upload") return uploadOne(source, input, offers.upload!);
  if (intent === "empty-trash") return emptyTrash(source);

  const { targets, invalid } = targetsOf(input, MediaId);
  const tooMany = checkCount(targets.length + invalid.length, "file");
  if (tooMany) return tooMany;
  const early: Outcome[] = invalid.map((id) => ({ id, ok: false, message: "That is not a file id, so it was not sent to the site." }));
  // A write needs the version the person saw; without one the site could not tell a stale write from a fresh one.
  const sendable = targets.filter((t) => intent === "delete" || t.version !== null);
  for (const t of targets) {
    if (!sendable.includes(t)) early.push({ id: t.id, ok: false, message: "The page did not say which version of this file you saw, so nothing was sent. Reload and try again." });
  }

  if (intent === "alt" || intent === "tags") {
    if (sendable.length !== 1 || targets.length !== 1) return result(early, "Choose one file.");
    const file = { id: sendable[0]!.id, version: sendable[0]!.version! };
    return intent === "alt" ? setAlt(source, file, text(input, "alt")) : setFileTags(source, file, texts(input, "tags"));
  }

  let tags: string[] = [];
  if (intent === "tag-add" || intent === "tag-remove") {
    const parsed = parseMediaTags(texts(input, "tags"));
    if (!parsed.ok) return refused(parsed.message);
    if (parsed.tags.length === 0) return refused("Name at least one tag.");
    tags = parsed.tags;
  }

  // Each file is read first where the kit needs what the site holds: which tags would really change
  // (so Undo touches only those), and, on a site with a trash, that a delete is from the trash.
  const before = new Map<string, MediaDetail>();
  const plan: Array<{ id: string; version: string | null }> = [];
  const { outcomes: checks, conflict: staleRead } = await eachItem(source, sendable, "file", async (t): Promise<Outcome> => {
    if (intent === "tag-add" || intent === "tag-remove" || (intent === "delete" && offers.trash)) {
      const detail = await source.client.media.get(t.id);
      if (t.version !== null && detail.version !== t.version) throw new Conflict(detail.version ?? null);
      before.set(t.id, detail);
      if (intent === "delete" && !detail.trashedAt) {
        return { id: t.id, ok: false, message: "Move this file to the trash first: files are deleted for good only from the trash." };
      }
      if (intent === "tag-add" || intent === "tag-remove") {
        const held = detail.tags ?? [];
        const changes = intent === "tag-add" ? tags.some((g) => !held.includes(g)) : tags.some((g) => held.includes(g));
        if (!changes) return { id: t.id, ok: true, message: intent === "tag-add" ? "Already had those tags. Not changed." : "Had none of those tags. Not changed." };
      }
    }
    plan.push(t);
    return { id: t.id, ok: true, message: "" };
  });
  const settled = checks.filter((c) => !c.ok || c.message !== "");
  const all: Outcome[] = [...early, ...settled];
  if (plan.length === 0) return result(all, summarise(all, MEDIA_DONE[intent], "file"), staleRead ? { conflict: staleRead } : {});

  const op = intent === "tag-add" ? "add-tags" : intent === "tag-remove" ? "remove-tags" : intent;
  const sent = plan.map((p) => ({ ...p, changeId: changeId() }));
  const answer = await source.client.media.bulk({
    op,
    ...(tags.length > 0 ? { tags } : {}),
    items: sent.map((s) => ({ id: s.id, changeId: s.changeId, ...(op !== "delete" && s.version ? { expectedVersion: s.version } : {}) })),
  });
  const undoIds: string[] = [];
  const undoVersions: string[] = [];
  const undoTags = new Set<string>();
  let conflict: IntentResult["conflict"] = staleRead;
  for (const outcome of answer.results) {
    if (outcome.ok) {
      const note = await recordDone(source, `media-${intent}`, outcome.id, outcome.changeId);
      all.push({ id: outcome.id, ok: true, message: MEDIA_DONE_ONE[intent] + note });
      if (outcome.version) {
        undoIds.push(outcome.id);
        undoVersions.push(outcome.version);
        const held = before.get(outcome.id)?.tags ?? [];
        for (const g of tags) if (intent === "tag-add" ? !held.includes(g) : held.includes(g)) undoTags.add(`${outcome.id}\u0000${g}`);
      }
    } else {
      if (outcome.error === "version-conflict" && !conflict) conflict = { id: outcome.id, currentVersion: outcome.currentVersion ?? null };
      all.push({
        id: outcome.id,
        ok: false,
        message: outcome.error === "version-conflict" ? "This file changed on the site since the page loaded. It was left as it was." : outcome.message,
        ...(outcome.usedBy && outcome.usedBy.length > 0 ? { usedBy: outcome.usedBy } : {}),
      });
    }
  }
  const extra: Partial<IntentResult> = conflict ? { conflict } : {};
  let tail = "";
  if (undoIds.length > 0 && (intent === "trash" || intent === "restore")) {
    extra.undo = { intent: intent === "trash" ? "restore" : "trash", fields: { ids: undoIds, versions: undoVersions } };
  } else if (undoIds.length > 0 && (intent === "tag-add" || intent === "tag-remove")) {
    // Undo applies the inverse to the files that changed, and only those: one bulk request when every
    // file changed by the same tags, which a single tag always does.
    const changed = undoIds.map((id) => tags.filter((g) => undoTags.has(`${id}\u0000${g}`)).join(","));
    if (changed.every((c) => c === changed[0])) {
      extra.undo = { intent: intent === "tag-add" ? "tag-remove" : "tag-add", fields: { ids: undoIds, versions: undoVersions, tags: changed[0]!.split(",") } };
    } else tail = " The files changed by different tags, so there is no single Undo; change them one at a time to reverse it.";
  }
  return result(all, summarise(all, MEDIA_DONE[intent], "file") + tail, extra);
}

const MEDIA_DONE: Record<MediaIntent, string> = {
  upload: "Uploaded",
  alt: "Saved alt text on",
  tags: "Saved tags on",
  "tag-add": "Tagged",
  "tag-remove": "Untagged",
  trash: "Moved to the trash",
  restore: "Restored",
  delete: "Deleted",
  "empty-trash": "Deleted",
};

const MEDIA_DONE_ONE: Record<MediaIntent, string> = {
  upload: "Uploaded.",
  alt: "Alt text saved.",
  tags: "Tags saved.",
  "tag-add": "Tags added.",
  "tag-remove": "Tags removed.",
  trash: "Moved to the trash.",
  restore: "Restored to the library.",
  delete: "Deleted from the site.",
  "empty-trash": "Deleted from the site.",
};

/**
 * Uploads one file. The kit checks the site's own limits first, so a file the site would refuse is
 * not sent at all; the site API checks them again, and the bytes, before the site's code.
 */
async function uploadOne(source: ContentSource, input: IntentInput, limits: MediaUploadLimits): Promise<IntentResult> {
  const file = fieldOf(input, "file").find((v): v is Blob => typeof v !== "string");
  if (!file) return refused("Choose a file to upload.");
  const name = (file as Blob & { name?: string }).name || "upload";
  const type = file.type.split(";")[0]!.trim().toLowerCase();
  if (!limits.types.includes(type)) {
    return refused(`${name} is ${type || "an unknown type"}; this site accepts ${limits.types.map((t) => t.split("/")[1]).join(", ")}.`);
  }
  if (file.size > limits.maxBytes) return refused(`${name} is ${megabytes(file.size)}; this site accepts files up to ${megabytes(limits.maxBytes)}.`);
  if (file.size === 0) return refused(`${name} is empty.`);
  const change = changeId();
  try {
    const item = await source.client.media.upload({
      bytes: new Uint8Array(await file.arrayBuffer()),
      contentType: type,
      filename: name.replace(/[/\\]/g, "-").slice(0, 200),
      alt: text(input, "alt").trim().slice(0, 2000),
      changeId: change,
    });
    const note = await recordDone(source, "media-upload", item.id, change);
    return result([{ id: item.id, ok: true, message: "Uploaded." + note }], `Uploaded ${name}.` + note);
  } catch (error) {
    if (error instanceof SiteApiError && error.body) return refused(`The site refused ${name}: ${error.body.message}`);
    throw error;
  }
}

async function setAlt(source: ContentSource, file: { id: string; version: string }, alt: string): Promise<IntentResult> {
  const { outcomes, conflict } = await eachItem(source, [file], "file", async ({ id, version }) => {
    const change = changeId();
    await source.client.media.setAlt(id, { alt: alt.trim().slice(0, 2000), expectedVersion: version, changeId: change });
    return { id, ok: true, message: "Alt text saved." + (await recordDone(source, "media-alt", id, change)) };
  });
  return result(outcomes, outcomes[0]!.message, conflict ? { conflict } : {});
}

/** Sets a file's whole tag set. Undo sets back the set it held, at the version this write made. */
async function setFileTags(source: ContentSource, file: { id: string; version: string }, raw: string[]): Promise<IntentResult> {
  const parsed = parseMediaTags(raw);
  if (!parsed.ok) return refused(parsed.message);
  let undo: IntentResult["undo"];
  const { outcomes, conflict } = await eachItem(source, [file], "file", async ({ id, version }) => {
    const detail = await source.client.media.get(id);
    if (detail.version !== version) throw new Conflict(detail.version ?? null);
    const change = changeId();
    const written = await source.client.media.setTags(id, { tags: parsed.tags, expectedVersion: version, changeId: change });
    undo = { intent: "tags", fields: { ids: [id], versions: [written.version], tags: (detail.tags ?? []).join(", ") } };
    return { id, ok: true, message: "Tags saved." + (await recordDone(source, "media-tags", id, change)) };
  });
  return result(outcomes, outcomes[0]!.message, { ...(conflict ? { conflict } : {}), ...(undo ? { undo } : {}) });
}

/**
 * Deletes for good every file in the trash, each through the site's own reference check: a file a
 * post still uses is refused and stays in the trash. Sends again while the site says more remain and
 * the last round deleted something.
 */
async function emptyTrash(source: ContentSource): Promise<IntentResult> {
  const outcomes: Outcome[] = [];
  const refusedIds = new Set<string>();
  let more = false;
  for (let round = 0; round < EMPTY_ROUNDS; round++) {
    // The site records file n under `<change id>-<n>` in the order it lists the trash, refused files
    // included, so the kit lists the same trash first to record the same ids.
    const order = source.record ? (await source.client.media.list({ trashed: "only", limit: 200 })).items.map((i) => i.id) : [];
    const change = changeId();
    const answer = await source.client.media.emptyTrash({ changeId: change });
    for (const id of answer.deleted) {
      const n = order.indexOf(id);
      const note = await recordDone(source, "media-delete", id, n >= 0 ? `${change}-${n + 1}` : `${change}:${id}`);
      outcomes.push({ id, ok: true, message: "Deleted from the site." + note });
    }
    for (const r of answer.refused) {
      if (refusedIds.has(r.id)) continue;
      refusedIds.add(r.id);
      outcomes.push({ id: r.id, ok: false, message: r.message, ...(r.usedBy && r.usedBy.length > 0 ? { usedBy: r.usedBy } : {}) });
    }
    more = answer.more;
    if (!answer.more || answer.deleted.length === 0) break;
  }
  if (outcomes.length === 0) return { ok: true, message: "The trash was already empty.", outcomes };
  const deleted = outcomes.filter((o) => o.ok).length;
  const kept = outcomes.length - deleted;
  const message =
    `Deleted ${plural(deleted, "file")} from the trash for good.` +
    (kept > 0 ? ` ${plural(kept, "file")} ${kept === 1 ? "is" : "are"} still used and stayed in the trash.` : "") +
    (more ? " More remain; empty the trash again." : "");
  return { ok: kept === 0 && !more, message, outcomes };
}

// ---------- mentions

export type MentionFilter = MentionStatus | "all";
export const MENTION_FILTERS: readonly MentionFilter[] = ["pending", "failed", "approved", "rejected", "unverified", "all"];

export interface MentionsQuery {
  /** Absent: open on pending, or on all when nothing is pending. */
  status?: MentionFilter;
  /** v0.6.0: words in the source, the author or the excerpt. */
  q?: string;
  /** v0.6.0: only the mentions of this post. */
  targetId?: string;
  cursor?: string;
}

export type MentionRow = MentionItem & { postHref: string };

export interface MentionsData {
  site: { id: string; name: string };
  /** The filter shown, after the default was applied. */
  filter: MentionFilter;
  query: MentionsQuery;
  rows: MentionRow[];
  page: {
    nextCursor: string | null;
    /** True when q or targetId was applied to this page only, because the site's list does not filter by them. */
    filteredOnPage?: boolean;
  };
  /** Across the whole queue, not the page. */
  counts: MentionCounts;
  /** What a sweep would remove now. */
  expiring: MentionList["expiring"];
  offers: { mentions: boolean; reset: boolean };
  can: Permissions;
}

export function readMentionsQuery(search: URLSearchParams): MentionsQuery {
  const status = search.get("status");
  const cursor = search.get("cursor")?.slice(0, 500);
  const q = search.get("q")?.trim().slice(0, 200);
  const targetId = search.get("targetId")?.trim().slice(0, 300);
  return {
    ...(status && MENTION_FILTERS.includes(status as MentionFilter) ? { status: status as MentionFilter } : {}),
    ...(q ? { q } : {}),
    ...(targetId ? { targetId } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

const NO_COUNTS: MentionCounts = { unverified: 0, pending: 0, approved: 0, rejected: 0, failed: 0 };

/** One page of one site's mention queue, as MentionsList renders it. */
export async function loadMentions(source: ContentSource, query: MentionsQuery = {}): Promise<MentionsData> {
  const capabilities = (await source.client.meta()).capabilities;
  const base = { site: { id: source.site.id, name: source.site.name }, query, can: source.can, offers: { mentions: capabilities.mentions === true, reset: capabilities.mentions === true && capabilities.mentionReset === true } };
  if (capabilities.mentions !== true) {
    return { ...base, filter: query.status ?? "all", rows: [], page: { nextCursor: null }, counts: NO_COUNTS, expiring: { failed: 0, rejected: 0 } };
  }
  const page = (filter: MentionFilter) =>
    source.client.mentions.list({
      limit: PER_PAGE,
      ...(filter === "all" ? {} : { status: filter }),
      ...(query.q ? { q: query.q } : {}),
      ...(query.targetId ? { targetId: query.targetId } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
  let filter: MentionFilter = query.status ?? "pending";
  let list = await page(filter);
  if (!query.status && list.items.length === 0 && list.counts.pending === 0) {
    filter = "all";
    list = await page("all");
  }
  // A site that filtered echoes it (v0.6.0); otherwise the kit filters the page it has and says that.
  let items = list.items;
  const filteredOnPage = (query.q !== undefined || query.targetId !== undefined) && list.filtered === undefined;
  if (filteredOnPage) {
    const needle = query.q?.toLowerCase();
    items = items.filter(
      (m) =>
        (!query.targetId || m.targetId === query.targetId) &&
        (!needle || [m.sourceUrl, m.authorName ?? "", m.excerpt ?? ""].some((t) => t.toLowerCase().includes(needle))),
    );
  }
  return {
    ...base,
    filter,
    rows: items.map((m) => ({ ...m, postHref: source.editorHref(m.targetId) })),
    page: { nextCursor: list.nextCursor, ...(filteredOnPage ? { filteredOnPage } : {}) },
    counts: list.counts,
    expiring: list.expiring,
  };
}

export const MENTION_INTENTS = ["approve", "reject", "reset", "delete", "sweep"] as const;
export type MentionIntent = (typeof MENTION_INTENTS)[number];

/** Said when the write moved but the site could not clear its cache. */
const PURGE_FAILED = " The site could not clear its cache, so the post's page may show the old mentions until its cache expires.";

/**
 * Approves, rejects, resets (v0.6.0) or deletes each mention, in order, each with its own change id and record, or
 * sweeps the queue. Each write carries the version the person saw, so a mention the site changed since
 * is refused as stale and stays.
 */
export async function runMentionsIntent(source: ContentSource, input: IntentInput): Promise<IntentResult> {
  const intent = text(input, "intent") as MentionIntent;
  if (!MENTION_INTENTS.includes(intent)) return refused("That is not something the mentions list can do.");
  if (!source.can.decideMentions) return refused(NOT_YOURS.decideMentions);
  const capabilities = (await source.client.meta()).capabilities;
  if (capabilities.mentions !== true) return refused("This site does not receive webmentions through the site API.");
  const canReset = capabilities.mentionReset === true;
  if (intent === "reset" && !canReset) return refused("This site does not take a mention decision back.");

  if (intent === "sweep") {
    const change = changeId();
    try {
      const { removed } = await source.client.mentions.sweep({ changeId: change });
      const note = await recordDone(source, "mention-sweep", "sweep", change);
      const n = removed.failed + removed.rejected;
      return { ok: true, message: `Removed ${removed.failed} failed and ${removed.rejected} rejected mention${n === 1 ? "" : "s"} past their retention window.` + note };
    } catch (error) {
      return refused(failure(source, "sweep", error, "mention").message);
    }
  }

  const { targets, invalid } = targetsOf(input, MentionId);
  const tooMany = checkCount(targets.length + invalid.length, "mention");
  if (tooMany) return tooMany;
  const early: Outcome[] = invalid.map((id) => ({ id, ok: false, message: "That is not a mention id, so it was not sent to the site." }));
  for (const t of targets) {
    if (t.version === null) early.push({ id: t.id, ok: false, message: "The page did not say which version of this mention you saw, so nothing was sent. Reload and try again." });
  }
  const sendable = targets.filter((t): t is { id: string; version: string; status: string | null } => t.version !== null);

  // Each done mention's inverse: the opposite decision between approved and rejected, a reset (v0.6.0)
  // for a decision on a waiting mention, and the decision that was taken back for a reset.
  const inverses: Array<{ id: string; version: string; intent: MentionIntent; status: MentionStatus }> = [];
  let noUndo = 0;
  const { outcomes, conflict } = await eachItem(source, sendable, "mention", async ({ id, version, status }): Promise<Outcome> => {
    const change = changeId();
    if (intent === "delete") {
      const { purged } = await source.client.mentions.delete(id, { expectedVersion: version, changeId: change });
      return { id, ok: true, message: "Deleted." + (purged === false ? PURGE_FAILED : "") + (await recordDone(source, "mention-delete", id, change)) };
    }
    const written = await source.client.mentions.decide(id, { decision: intent as "approve" | "reject" | "reset", expectedVersion: version, changeId: change });
    const parsed = MentionStatus.safeParse(status);
    const was = parsed.success ? parsed.data : null;
    const inverse: MentionIntent | null =
      was === written.status
        ? null
        : was === "approved"
          ? "approve"
          : was === "rejected"
            ? "reject"
            : was === "pending" && canReset
              ? "reset"
              : null;
    if (inverse) inverses.push({ id, version: written.version, intent: inverse, status: written.status });
    else if (was !== written.status) noUndo++;
    const note = await recordDone(source, `mention-${intent}`, id, change);
    return { id, ok: true, message: DECIDED[intent] + (written.purged === false ? PURGE_FAILED : "") + note };
  });

  const all = [...early, ...outcomes];
  const extra: Partial<IntentResult> = conflict ? { conflict } : {};
  let tail = "";
  if (inverses.length > 0 && inverses.every((i) => i.intent === inverses[0]!.intent)) {
    extra.undo = {
      intent: inverses[0]!.intent,
      fields: { ids: inverses.map((i) => i.id), versions: inverses.map((i) => i.version), statuses: inverses.map((i) => i.status) },
    };
  } else if (inverses.length > 0) {
    tail = " The mentions were in different states before, so there is no single Undo; change them one at a time to reverse it.";
  }
  if (intent !== "delete" && noUndo > 0) tail += canReset ? "" : " A decision on a waiting mention has no Undo on this site.";
  return result(all, summarise(all, DONE_MENTIONS[intent], "mention") + tail, extra);
}

const DECIDED: Record<MentionIntent, string> = { approve: "Approved.", reject: "Rejected.", reset: "Back to waiting.", delete: "Deleted.", sweep: "" };
const DONE_MENTIONS: Record<MentionIntent, string> = { approve: "Approved", reject: "Rejected", reset: "Took back the decision on", delete: "Deleted", sweep: "Swept" };

// ---------- many sites at once

export interface SiteSummary {
  site: { id: string; name: string };
  /** Mentions waiting for a decision; null when the site does not moderate mentions here. */
  mentionsWaiting: number | null;
  /** Posts the host has something waiting on (Carrel's AI drafts); null when the host does not say. */
  postsWaiting: number | null;
  /** Files with no alt text; null where the site cannot say. */
  mediaWithoutAlt: number | null;
}

/** A small count for one site, for an inbox line that links to the list. */
export async function summary(source: ContentSource): Promise<SiteSummary> {
  const capabilities = (await source.client.meta()).capabilities;
  const mentionsWaiting = capabilities.mentions === true ? (await source.client.mentions.list({ status: "pending", limit: 1 })).counts.pending : null;
  // A site that answers the no-alt lens (v0.6.0) and counts can say how many files lack alt text.
  const mediaWithoutAlt =
    capabilities.media === true && (capabilities.mediaLenses ?? []).includes("no-alt")
      ? ((await source.client.media.list({ lens: "no-alt", limit: 1 })).total ?? null)
      : null;
  return {
    site: { id: source.site.id, name: source.site.name },
    mentionsWaiting,
    postsWaiting: source.waiting ? await source.waiting() : null,
    mediaWithoutAlt,
  };
}
