// The media half of the content kit: MediaLibrary's view data and its intents.

import { focusOf } from "@dustinedwards/site-runtime/image";

import { SiteApiError } from "../client.js";
import {
  MAX_RESIZE_PASS,
  MEDIA_SORTS,
  MediaId,
  MediaKind,
  MediaLens,
  MediaOrientation,
  MediaSourceUrl,
  MediaTag,
  MediaTransformOp,
  type Capabilities,
  type SortDir,
  type MediaDetail,
  type MediaItem,
  type MediaResize,
  type MediaRevision,
  type MediaSort,
  type MediaTransformOp as TransformOp,
  type MediaUploadLimits,
} from "../contract.js";
import {
  type Permissions,
  type ContentSource,
  type IntentInput,
  type Outcome,
  type IntentResult,
  PER_PAGE,
  NOT_YOURS,
  fieldOf,
  texts,
  text,
  refused,
  askFirst,
  plural,
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
  /** v0.13.0, where the site filters (offers.filters); dropped, never sent, where it does not. */
  orientation?: MediaOrientation;
  kind?: MediaKind;
  /** v0.13.0: ask the site's model about the file in the inspector (offers.suggestions), as a "Suggest" link does. */
  suggest?: boolean;
}

/** A file as the library shows it: the site's item, plus the absolute address a browser loads. */
export type MediaRow = MediaItem & { src: string };

/**
 * What the site's model suggests for the file in the inspector (v0.13.0): only what would change it, the tags it does not
 * carry and an alt text unlike its own, so each shows as a suggestion to accept (the `tag-add` and `alt` intents) or dismiss.
 */
export interface MediaSuggestionView {
  tags: string[];
  alt: string | null;
  model: string;
}

export interface MediaData {
  site: { id: string; name: string };
  query: MediaQuery;
  rows: MediaRow[];
  page: {
    nextCursor: string | null;
    total?: number;
    /** True when the rows were sorted on this page only, because the site's list does not sort. */
    sortedOnPage?: boolean;
    /** v0.13.0, where offers.live: the point to poll from with loadMediaChanges. */
    changeCursor?: string;
  };
  /**
   * The file in the inspector with every place it is used; null when the site has no such file. v0.13.0: its earlier bytes
   * where offers.history, and the model's suggestions where the query asked for them.
   */
  detail?: (MediaDetail & { src: string; history?: MediaRevision[]; suggestions?: MediaSuggestionView | null }) | null;
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
    /** v0.10.0: the site keeps a focal point, keeps a caption, and replaces a file's bytes under its own address. */
    focus: boolean;
    caption: boolean;
    replace: boolean;
    /** v0.11.0: a replace must keep the picture's size (capabilities.mediaReplaceKeepsSize), so a crop is saved as a new file. */
    replaceKeepsSize: boolean;
    // v0.13.0, each false (or null) where the site lacks it.
    /** An upload of bytes the site holds answers that file; details carry twins; the duplicates lens may be offered. */
    duplicates: boolean;
    /** Rows carry usedCount, and the site sorts by `used` (the kit sorts the page where it does not). */
    usage: boolean;
    /** The orientation and kind filters. */
    filters: boolean;
    /** The `import` intent. */
    import: boolean;
    /** The `credit` intent, and rows carry credit, license, sourceUrl and licenseExpires. */
    credit: boolean;
    /** The `transform` intent. */
    transform: boolean;
    /** The inspector's history, and the `revert` intent. */
    history: boolean;
    /** loadMediaChanges, for a screen that polls for what others changed. */
    live: boolean;
    /** What uploads shrink to, and the upload's `resize=no` box. */
    resize: MediaResize | null;
    /** The `resize` intent over stored pictures (the `oversized` lens lists them). */
    resizePass: boolean;
    /** The site fills credit, license, caption and taken date from embedded metadata at upload. */
    embedded: boolean;
    /** The query's `suggest`. */
    suggestions: boolean;
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
  const orientation = MediaOrientation.safeParse(search.get("orientation"));
  const kind = MediaKind.safeParse(search.get("kind"));
  return {
    ...(q ? { q } : {}),
    ...(lens.success ? { lens: lens.data } : {}),
    ...(sort && (MEDIA_SORTS as readonly string[]).includes(sort) ? { sort: sort as MediaSort } : {}),
    ...(dir === "asc" || dir === "desc" ? { dir } : {}),
    ...(tag && MediaTag.safeParse(tag).success ? { tag } : {}),
    ...(search.get("view") === "trash" ? { view: "trash" as const } : {}),
    ...(cursor ? { cursor } : {}),
    ...(MediaId.safeParse(inspect).success ? { inspect } : {}),
    ...(orientation.success ? { orientation: orientation.data } : {}),
    ...(kind.success ? { kind: kind.data } : {}),
    ...(search.get("suggest") === "1" ? { suggest: true } : {}),
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
    focus: media && capabilities.mediaFocus === true,
    caption: media && capabilities.mediaCaption === true,
    replace: media && capabilities.mediaReplace === true,
    replaceKeepsSize: media && capabilities.mediaReplace === true && capabilities.mediaReplaceKeepsSize === true,
    duplicates: media && capabilities.mediaDuplicates === true,
    usage: media && capabilities.mediaUsage === true,
    filters: media && capabilities.mediaFilters === true,
    import: media && capabilities.mediaImport === true,
    credit: media && capabilities.mediaCredit === true,
    transform: media && capabilities.mediaTransform === true,
    history: media && capabilities.mediaHistory === true,
    live: media && capabilities.mediaChanges === true,
    resize: media ? (capabilities.mediaResize ?? null) : null,
    resizePass: media && capabilities.mediaResize !== undefined && capabilities.mediaResizePass === true,
    embedded: media && capabilities.mediaEmbedded === true,
    suggestions: media && capabilities.mediaSuggestions === true,
  };
}

const MEDIA_BY: Record<MediaSort, (a: MediaItem, b: MediaItem) => number> = {
  added: (a, b) => (b.uploadedAt ?? "").localeCompare(a.uploadedAt ?? ""),
  size: (a, b) => b.bytes - a.bytes,
  name: (a, b) => (a.filename ?? a.id).localeCompare(b.filename ?? b.id),
  used: (a, b) => (b.usedCount ?? 0) - (a.usedCount ?? 0),
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
    // A site that does not count uses would refuse the used sort; the kit sorts the page by what the rows carry instead.
    ...(query.sort && (query.sort !== "used" || offers.usage) ? { sort: query.sort, ...(query.dir ? { dir: query.dir } : {}) } : {}),
    ...(query.orientation && offers.filters ? { orientation: query.orientation } : {}),
    ...(query.kind && offers.filters ? { kind: query.kind } : {}),
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
    if (found && offers.history) {
      const history = await orNull(source.client.media.history(found.id));
      if (history) detail = { ...detail!, history: history.revisions };
    }
    // A model costs the site money, so it is asked only when the person asks, and only for someone who could accept it.
    if (found && query.suggest && offers.suggestions && source.can.edit) {
      detail = { ...detail!, suggestions: await suggestionsFor(source, found) };
    }
  }
  const page = {
    nextCursor: list.nextCursor,
    ...(list.total !== undefined ? { total: list.total } : {}),
    ...(sortedOnPage ? { sortedOnPage } : {}),
    ...(offers.live && list.changeCursor ? { changeCursor: list.changeCursor } : {}),
  };
  return { ...base, rows, page, ...(detail !== undefined ? { detail } : {}) };
}

/** The model's suggestions for one file, less what it already has; null when the site could not answer. */
async function suggestionsFor(source: ContentSource, file: MediaDetail): Promise<MediaSuggestionView | null> {
  try {
    const found = await source.client.media.suggestions(file.id);
    const held = file.tags ?? [];
    const alt = found.alt !== null && found.alt.trim() !== file.alt.trim() ? found.alt : null;
    return { tags: found.tags.filter((t) => !held.includes(t)), alt, model: found.model };
  } catch (error) {
    if (error instanceof SiteApiError) return null;
    throw error;
  }
}

/** What changed on the site since a cursor (v0.13.0), for a screen that polls: rows to put in place, ids to take out. */
export interface MediaChangesData {
  rows: MediaRow[];
  removed: string[];
  /** Where the next poll starts. */
  changeCursor: string;
  /** True when more changes wait: poll again at once. */
  more: boolean;
}

/**
 * The files another person changed since `cursor` (page.changeCursor, or the last poll's), each as it is now, trashed ones
 * included, so the screen moves each into or out of its view. `{ reload: true }` when the site can no longer answer from
 * that cursor, or does not offer live updates: the screen loads its page again.
 */
export async function loadMediaChanges(source: ContentSource, cursor: string): Promise<MediaChangesData | { reload: true }> {
  try {
    const changes = await source.client.media.changes(cursor, PER_PAGE);
    return {
      rows: changes.items.map((item) => ({ ...item, src: absolute(source.site.origin, item.url) })),
      removed: changes.removed ?? [],
      changeCursor: changes.changeCursor ?? cursor,
      more: changes.moreChanges === true,
    };
  } catch (error) {
    if (error instanceof SiteApiError && error.status < 500) return { reload: true };
    throw error;
  }
}

const MEDIA_INTENTS = [
  "upload", "alt", "tags", "tag-add", "tag-remove", "trash", "restore", "delete", "empty-trash", "focus", "caption", "replace",
  "import", "credit", "transform", "revert", "resize",
] as const;
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
  // A replace changes every live page that uses the file and the old bytes are gone, so it is the Owner's, like a delete.
  // A transform, a revert and a resize change every live page that uses the file too (v0.13.0), so they are the Owner's.
  const bytes = intent === "replace" || intent === "transform" || intent === "revert" || intent === "resize";
  const need: keyof Permissions = intent === "delete" || intent === "empty-trash" || bytes ? "deleteMedia" : "edit";
  if (!source.can[need]) return refused(intent === "replace" ? "Replacing a file is the Owner's step." : bytes ? "Changing a file's picture is the Owner's step." : NOT_YOURS[need]);
  const offers = mediaOffers((await source.client.meta()).capabilities);
  if (!offers.media) return refused("This site has no media library.");
  const lacking =
    (intent === "alt" && !offers.alt) ||
    ((intent === "tags" || intent === "tag-add" || intent === "tag-remove") && !offers.tags) ||
    ((intent === "trash" || intent === "restore" || intent === "empty-trash") && !offers.trash) ||
    (intent === "focus" && !offers.focus) ||
    (intent === "caption" && !offers.caption) ||
    (intent === "replace" && !offers.replace) ||
    (intent === "import" && !offers.import) ||
    (intent === "credit" && !offers.credit) ||
    (intent === "transform" && !offers.transform) ||
    (intent === "revert" && !offers.history) ||
    (intent === "resize" && !offers.resizePass);
  if (lacking) return refused("This site does not offer that.");

  if (intent === "upload") return uploadOne(source, input, offers.upload!);
  if (intent === "import") return importOne(source, input);
  if (intent === "empty-trash") {
    const trash = await source.client.media.list({ trashed: "only", limit: 200 });
    if (trash.items.length === 0) return { ok: true, message: "The trash was already empty.", outcomes: [] };
    const ask = askFirst(input, {
      intent,
      title: `Delete ${plural(trash.items.length, "file")} in the trash for good?`,
      lead: "Each file leaves the site's storage, and nothing can bring it back. A file a page still uses stays in the trash." + (trash.nextCursor ? " The trash holds more than these; empty it again for the rest." : ""),
      action: "Empty the trash",
      items: trash.items.map((i) => i.filename ?? i.id),
      fields: {},
    });
    return ask ?? emptyTrash(source);
  }

  const { targets, invalid } = targetsOf(input, MediaId);
  const tooMany = checkCount(targets.length + invalid.length, "file");
  if (tooMany) return tooMany;
  const early: Outcome[] = invalid.map((id) => ({ id, ok: false, message: "That is not a file id, so it was not sent to the site." }));
  // A write needs the version the person saw; without one the site could not tell a stale write from a fresh one.
  const sendable = targets.filter((t) => intent === "delete" || t.version !== null);
  for (const t of targets) {
    if (!sendable.includes(t)) early.push({ id: t.id, ok: false, message: "The page did not say which version of this file you saw, so nothing was sent. Reload and try again." });
  }

  if (intent === "alt" || intent === "tags" || intent === "focus" || intent === "caption" || intent === "replace" || intent === "credit" || intent === "transform" || intent === "revert") {
    if (sendable.length !== 1 || targets.length !== 1) return result(early, "Choose one file.");
    const file = { id: sendable[0]!.id, version: sendable[0]!.version! };
    if (intent === "alt") return setAlt(source, file, text(input, "alt"));
    if (intent === "tags") return setFileTags(source, file, texts(input, "tags"));
    if (intent === "focus") return setFocus(source, file, focusField(input));
    if (intent === "caption") return setCaption(source, file, text(input, "caption"));
    if (intent === "credit") return setCredit(source, input, file);
    if (intent === "transform") return transformFile(source, input, file, offers.history);
    if (intent === "revert") return revertFile(source, file, text(input, "to"));
    return replaceFile(source, input, file, offers.upload!);
  }
  if (intent === "resize") return resizeFiles(source, input, sendable, early);

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
  if (plan.length === 0) return result(all, summarize(all, MEDIA_DONE[intent], "file"), staleRead ? { conflict: staleRead } : {});

  if (intent === "delete") {
    // Asked once the kit knows which files would really go: none still in the library, none refused above.
    const ids = plan.map((p) => p.id);
    const ask = askFirst(input, {
      intent,
      title: `Delete ${plural(ids.length, "file")} for good?`,
      lead: "Each file leaves the site's storage, and nothing can bring it back. A file a page still uses is kept.",
      action: "Delete for good",
      items: ids,
      fields: { ids },
    });
    if (ask) return ask;
  }

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
  return result(all, summarize(all, MEDIA_DONE[intent], "file") + tail, extra);
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
  focus: "Saved the focal point on",
  caption: "Saved the caption on",
  replace: "Replaced",
  import: "Imported",
  credit: "Saved the credit on",
  transform: "Turned",
  revert: "Reverted",
  resize: "Shrank",
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
  focus: "Focal point saved.",
  caption: "Caption saved.",
  replace: "Replaced.",
  import: "Imported.",
  credit: "Credit saved.",
  transform: "Turned.",
  revert: "Reverted.",
  resize: "Shrunk.",
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
      ...(text(input, "resize") === "no" ? { resize: "no" as const } : {}),
    });
    if (item.duplicateOf) return stored(source, item, `${name} is already in the library`, change);
    return stored(source, item, `Uploaded ${name}`, change, "media-upload");
  } catch (error) {
    if (error instanceof SiteApiError && error.body) return refused(`The site refused ${name}: ${error.body.message}`);
    throw error;
  }
}

const EMBEDDED_WORDS: Record<string, string> = { credit: "credit", license: "license", caption: "caption", takenAt: "date taken" };

/**
 * What an upload or an import did, said in one sentence: a duplicate names the file it already was (nothing is recorded,
 * since nothing changed), and a new file says what the site shrank or filled in from the file itself.
 */
async function stored(
  source: ContentSource,
  item: { id: string; filename: string | null; duplicateOf?: string; embedded?: string[]; resizedFrom?: { width: number; height: number }; width: number | null; height: number | null },
  lead: string,
  change: string,
  kind?: string,
): Promise<IntentResult> {
  if (item.duplicateOf) {
    const message = `${lead} as ${item.filename ?? item.id}, so no second copy was stored.`;
    return result([{ id: item.id, ok: true, message, duplicate: true }], message);
  }
  const notes = [
    item.resizedFrom && item.width && item.height ? ` Shrunk from ${item.resizedFrom.width}x${item.resizedFrom.height} to ${item.width}x${item.height}.` : "",
    item.embedded && item.embedded.length > 0 ? ` Filled in from the file: ${item.embedded.map((f) => EMBEDDED_WORDS[f] ?? f).join(", ")}.` : "",
  ].join("");
  const note = await recordDone(source, kind!, item.id, change);
  const done = kind === "media-import" ? "Imported." : "Uploaded.";
  return result([{ id: item.id, ok: true, message: done + notes + note }], `${lead}.` + notes + note);
}

/** Has the site fetch a file from the web into its own storage (v0.13.0): `url`, and optional `filename` and `alt`. */
async function importOne(source: ContentSource, input: IntentInput): Promise<IntentResult> {
  const url = text(input, "url").trim();
  if (!/^https:\/\//i.test(url)) return refused("Give the file's https address.");
  const filename = text(input, "filename").trim().replace(/[/\\]/g, "-").slice(0, 200);
  const change = changeId();
  try {
    const item = await source.client.media.importUrl({
      url,
      ...(filename ? { filename } : {}),
      alt: text(input, "alt").trim().slice(0, 2000),
      changeId: change,
      ...(text(input, "resize") === "no" ? { resize: "no" as const } : {}),
    });
    return stored(source, item, item.duplicateOf ? "That file is already in the library" : `Imported ${item.filename ?? item.id}`, change, "media-import");
  } catch (error) {
    if (error instanceof SiteApiError && error.body) return refused(`The site did not import it: ${error.body.message}`);
    throw error;
  }
}

/** Saves a file's credit, license, source address and license end (v0.13.0), each the whole value after it. */
async function setCredit(source: ContentSource, input: IntentInput, file: { id: string; version: string }): Promise<IntentResult> {
  const sourceUrl = text(input, "sourceUrl").trim();
  if (sourceUrl !== "" && !MediaSourceUrl.safeParse(sourceUrl).success) return refused("The source is not a web address.");
  const licenseExpires = text(input, "licenseExpires").trim();
  if (licenseExpires !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(licenseExpires)) return refused("The license end is not a date.");
  const { outcomes, conflict } = await eachItem(source, [file], "file", async ({ id, version }) => {
    const change = changeId();
    const written = await source.client.media.setCredit(id, {
      credit: text(input, "credit").trim().slice(0, 300),
      license: text(input, "license").trim().slice(0, 300),
      sourceUrl: sourceUrl || null,
      licenseExpires: licenseExpires || null,
      expectedVersion: version,
      changeId: change,
    });
    return { id, ok: true, version: written.version, message: "Credit saved." + (await recordDone(source, "media-credit", id, change)) };
  });
  return result(outcomes, outcomes[0]!.message, conflict ? { conflict } : {});
}

const INVERSE: Record<TransformOp, TransformOp> = {
  "rotate-90": "rotate-270",
  "rotate-180": "rotate-180",
  "rotate-270": "rotate-90",
  "flip-h": "flip-h",
  "flip-v": "flip-v",
};

/**
 * Turns or mirrors one picture (v0.13.0), `op` one of MEDIA_TRANSFORMS. Undo puts the old bytes back where the site keeps
 * history (a revert, so nothing is encoded twice), else turns it back. A quarter turn the site saves as a new file has no
 * Undo: the old file is as it was, and the message says so.
 */
async function transformFile(source: ContentSource, input: IntentInput, file: { id: string; version: string }, history: boolean): Promise<IntentResult> {
  const op = MediaTransformOp.safeParse(text(input, "op"));
  if (!op.success) return refused("Choose a turn or a mirror.");
  let undo: IntentResult["undo"];
  const { outcomes, conflict } = await eachItem(source, [file], "file", async ({ id, version }) => {
    const before = history ? (await source.client.media.history(id)).revisions.find((r) => r.current)?.rev : undefined;
    const change = changeId();
    const done = await source.client.media.transform(id, { op: op.data, expectedVersion: version, changeId: change });
    const note = await recordDone(source, "media-transform", done.id, change);
    if (done.asNewFile) {
      return { id, ok: true, copyId: done.id, message: `Saved the turned picture as a new file, ${done.filename ?? done.id}, since this site's addresses carry the size. The pages that use the old one still show it.` + note };
    }
    undo = before
      ? { intent: "revert", fields: { ids: [id], versions: [done.version!], to: before } }
      : { intent: "transform", fields: { ids: [id], versions: [done.version!], op: INVERSE[op.data] } };
    const stale = done.sizesNeedPurge ? " The site's cache may still serve sizes of the old picture until they are purged." : "";
    return { id, ok: true, ...(done.version ? { version: done.version } : {}), message: "Turned. Every page that uses it shows the new picture." + stale + note };
  });
  return result(outcomes, outcomes[0]!.message, { ...(conflict ? { conflict } : {}), ...(undo ? { undo } : {}) });
}

/** Puts a file's earlier bytes back (v0.13.0), `to` a revision from the inspector's history. Undo puts back the bytes it had. */
async function revertFile(source: ContentSource, file: { id: string; version: string }, to: string): Promise<IntentResult> {
  if (to.trim() === "") return refused("Choose the version to go back to.");
  let undo: IntentResult["undo"];
  const { outcomes, conflict } = await eachItem(source, [file], "file", async ({ id, version }) => {
    const before = (await source.client.media.history(id)).revisions.find((r) => r.current)?.rev;
    const change = changeId();
    const done = await source.client.media.revert(id, { to: to.trim(), expectedVersion: version, changeId: change });
    if (before && done.version) undo = { intent: "revert", fields: { ids: [id], versions: [done.version], to: before } };
    const stale = done.sizesNeedPurge ? " The site's cache may still serve sizes of the newer picture until they are purged." : "";
    return { id, ok: true, ...(done.version ? { version: done.version } : {}), message: "Reverted. Every page that uses it shows that version; set its focal point again if it had one." + stale + (await recordDone(source, "media-revert", id, change)) };
  });
  return result(outcomes, outcomes[0]!.message, { ...(conflict ? { conflict } : {}), ...(undo ? { undo } : {}) });
}

/**
 * Shrinks the chosen stored pictures to the site's size (v0.13.0), after asking: each changes every page that uses it. Sent
 * in requests of the site's limit, each file with its own change id; one file's refusal is its own outcome.
 */
async function resizeFiles(source: ContentSource, input: IntentInput, files: Array<{ id: string; version: string | null }>, early: Outcome[]): Promise<IntentResult> {
  if (files.length === 0) return result(early, summarize(early, MEDIA_DONE.resize, "file"));
  const ids = files.map((f) => f.id);
  const ask = askFirst(input, {
    intent: "resize",
    title: `Shrink ${plural(ids.length, "picture")} to this site's size?`,
    lead: "Each picture is stored again at the smaller size, and every page that uses it shows the smaller one." + " Where the site keeps a file's history, the inspector can put the original back.",
    action: "Shrink",
    items: ids,
    fields: { ids, versions: files.map((f) => f.version!) },
  });
  if (ask) return ask;
  const all: Outcome[] = [...early];
  let conflict: IntentResult["conflict"];
  for (let at = 0; at < files.length; at += MAX_RESIZE_PASS) {
    const sent = files.slice(at, at + MAX_RESIZE_PASS).map((f) => ({ id: f.id, expectedVersion: f.version!, changeId: changeId() }));
    const answer = await source.client.media.resizePass({ items: sent });
    for (const outcome of answer.results) {
      if (outcome.ok) {
        const note = outcome.resized ? await recordDone(source, "media-resize", outcome.id, outcome.changeId) : "";
        all.push({ id: outcome.id, ok: true, ...(outcome.version ? { version: outcome.version } : {}), message: outcome.resized ? `Shrunk to ${outcome.width}x${outcome.height}.` + note : "Already within the size. Not changed." });
      } else {
        if (outcome.error === "version-conflict" && !conflict) conflict = { id: outcome.id, currentVersion: outcome.currentVersion ?? null };
        all.push({ id: outcome.id, ok: false, message: outcome.error === "version-conflict" ? "This file changed on the site since the page loaded. It was left as it was." : outcome.message });
      }
    }
  }
  return result(all, summarize(all, MEDIA_DONE.resize, "file"), conflict ? { conflict } : {});
}

async function setAlt(source: ContentSource, file: { id: string; version: string }, alt: string): Promise<IntentResult> {
  const { outcomes, conflict } = await eachItem(source, [file], "file", async ({ id, version }) => {
    const change = changeId();
    const written = await source.client.media.setAlt(id, { alt: alt.trim().slice(0, 2000), expectedVersion: version, changeId: change });
    return { id, ok: true, version: written.version, message: "Alt text saved." + (await recordDone(source, "media-alt", id, change)) };
  });
  return result(outcomes, outcomes[0]!.message, conflict ? { conflict } : {});
}

/**
 * The focal point a form posted: `clear=yes` clears it; `x` and `y`, each a percent from the top left, are what a form
 * with no script sends (MediaLibrary's focal point); otherwise `focus` as "XxY". "" clears it.
 */
function focusField(input: IntentInput): string {
  if (text(input, "clear") === "yes") return "";
  const x = text(input, "x").trim();
  const y = text(input, "y").trim();
  if (x === "" && y === "") return text(input, "focus");
  const part = (v: string) => {
    const n = Number(v);
    return v !== "" && n >= 0 && n <= 100 ? String(Math.round(n * 10) / 1000) : "bad";
  };
  return `${part(x)}x${part(y)}`;
}

/** Sets the point a file's crops are cut around: `focus` is "XxY", each 0 to 1 from the top left, or "" to clear it. */
async function setFocus(source: ContentSource, file: { id: string; version: string }, raw: string): Promise<IntentResult> {
  const focus = raw.trim() === "" ? null : focusOf(raw);
  if (raw.trim() !== "" && focus === null) return refused("That is not a point on the picture.");
  const { outcomes, conflict } = await eachItem(source, [file], "file", async ({ id, version }) => {
    const change = changeId();
    const written = await source.client.media.setFocus(id, { focus, expectedVersion: version, changeId: change });
    return { id, ok: true, version: written.version, message: (focus ? "Focal point saved." : "Focal point cleared.") + (await recordDone(source, "media-focus", id, change)) };
  });
  return result(outcomes, outcomes[0]!.message, conflict ? { conflict } : {});
}

async function setCaption(source: ContentSource, file: { id: string; version: string }, caption: string): Promise<IntentResult> {
  const { outcomes, conflict } = await eachItem(source, [file], "file", async ({ id, version }) => {
    const change = changeId();
    const written = await source.client.media.setCaption(id, { caption: caption.trim().slice(0, 2000), expectedVersion: version, changeId: change });
    return { id, ok: true, version: written.version, message: "Caption saved." + (await recordDone(source, "media-caption", id, change)) };
  });
  return result(outcomes, outcomes[0]!.message, conflict ? { conflict } : {});
}

/**
 * New bytes for one file under its own id and address, checked against the site's limits first as an upload is. Alt,
 * caption and tags stay; the focal point is cleared. Says so when the site's cache may still serve the old sizes.
 */
async function replaceFile(source: ContentSource, input: IntentInput, file: { id: string; version: string }, limits: MediaUploadLimits): Promise<IntentResult> {
  const upload = fieldOf(input, "file").find((v): v is Blob => typeof v !== "string");
  if (!upload) return refused("Choose the new file.");
  const name = (upload as Blob & { name?: string }).name || "upload";
  const type = upload.type.split(";")[0]!.trim().toLowerCase();
  if (!limits.types.includes(type)) return refused(`${name} is ${type || "an unknown type"}; this site accepts ${limits.types.map((t) => t.split("/")[1]).join(", ")}.`);
  if (upload.size > limits.maxBytes) return refused(`${name} is ${megabytes(upload.size)}; this site accepts files up to ${megabytes(limits.maxBytes)}.`);
  if (upload.size === 0) return refused(`${name} is empty.`);
  const { outcomes, conflict } = await eachItem(source, [file], "file", async ({ id, version }) => {
    const change = changeId();
    const done = await source.client.media.replace(id, {
      bytes: new Uint8Array(await upload.arrayBuffer()),
      contentType: type,
      filename: name.replace(/[/\\]/g, "-").slice(0, 200),
      expectedVersion: version,
      changeId: change,
    });
    const stale = done.sizesNeedPurge ? " The site's cache may still serve sizes of the old picture until they are purged." : "";
    return { id, ok: true, ...(done.version ? { version: done.version } : {}), message: "Replaced. Every page that uses it shows the new file; set its focal point again if it had one." + stale + (await recordDone(source, "media-replace", id, change)) };
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
    return { id, ok: true, version: written.version, message: "Tags saved." + (await recordDone(source, "media-tags", id, change)) };
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
