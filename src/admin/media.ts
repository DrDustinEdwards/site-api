// The media half of the content kit: MediaLibrary's view data and the poll for what others changed.

import { SiteApiError } from "../client.js";
import { orientationOf } from "../media.js";
import {
  MEDIA_SORTS,
  MediaId,
  MediaKind,
  MediaLens,
  MediaOrientation,
  MediaTag,
  type SortDir,
  type MediaDetail,
  type MediaItem,
  type MediaRevision,
  type MediaSort,
} from "../contract.js";
import { mediaOffers, type MediaOffers } from "./media-offers.js";
import { type Permissions, type ContentSource, PER_PAGE, orNull, absolute } from "./kit.js";

export interface MediaQuery {
  q?: string;
  tag?: string;
  view?: "library" | "trash";
  /** Where the site names the lens; dropped, never sent, where it does not. */
  lens?: MediaLens;
  sort?: MediaSort;
  dir?: SortDir;
  cursor?: string;
  /** The file open in the inspector. */
  inspect?: string;
  /** Where the site filters (offers.filters); dropped, never sent, where it does not. */
  orientation?: MediaOrientation;
  kind?: MediaKind;
  /** Ask the site's model about the file in the inspector (offers.suggestions), as a "Suggest" link does. */
  suggest?: boolean;
}

/**
 * A file as the library shows it: the site's item, plus the absolute address a browser loads and which way a
 * picture lies, so a screen filters and warns by the package's own rule (orientationOf) rather than a copy of it.
 */
type MediaRow = MediaItem & { src: string; orientation?: MediaOrientation };

function rowOf<T extends MediaItem>(
  source: ContentSource,
  item: T,
): T & { src: string; orientation?: MediaOrientation } {
  const orientation = orientationOf(item.width, item.height);
  return {
    ...item,
    src: absolute(source.site.origin, item.url),
    ...(orientation ? { orientation } : {}),
  };
}

/**
 * What the site's model suggests for the file in the inspector: only what would change it, the tags it does not
 * carry and an alt text unlike its own, so each shows as a suggestion to accept (the `tag-add` and `alt` intents) or dismiss.
 */
interface MediaSuggestionView {
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
    /** Where offers.live: the point to poll from with loadMediaChanges. */
    changeCursor?: string;
  };
  /**
   * The file in the inspector with every place it is used; null when the site has no such file. Its earlier bytes
   * where offers.history, and the model's suggestions where the query asked for them.
   */
  detail?:
    | (MediaDetail & {
        src: string;
        orientation?: MediaOrientation;
        history?: MediaRevision[];
        suggestions?: MediaSuggestionView | null;
      })
    | null;
  offers: MediaOffers;
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
    ...(sort && (MEDIA_SORTS as readonly string[]).includes(sort)
      ? { sort: sort as MediaSort }
      : {}),
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

const MEDIA_BY: Record<MediaSort, (a: MediaItem, b: MediaItem) => number> = {
  added: (a, b) => (b.uploadedAt ?? "").localeCompare(a.uploadedAt ?? ""),
  size: (a, b) => b.bytes - a.bytes,
  name: (a, b) => (a.filename ?? a.id).localeCompare(b.filename ?? b.id),
  used: (a, b) => (b.usedCount ?? 0) - (a.usedCount ?? 0),
};

/** One page of one site's media library, as MediaLibrary renders it. */
export async function loadMedia(source: ContentSource, query: MediaQuery = {}): Promise<MediaData> {
  const offers = mediaOffers((await source.client.meta()).capabilities);
  const base = {
    site: { id: source.site.id, name: source.site.name },
    query,
    offers,
    can: source.can,
  };
  if (!offers.media) return { ...base, rows: [], page: { nextCursor: null } };
  const list = await source.client.media.list({
    limit: PER_PAGE,
    ...(query.q ? { q: query.q } : {}),
    ...(query.tag && offers.tags ? { tag: query.tag } : {}),
    ...(query.view === "trash" && offers.trash ? { trashed: "only" as const } : {}),
    ...(query.lens && offers.lenses.includes(query.lens) ? { lens: query.lens } : {}),
    // A site that does not count uses would refuse the used sort; the kit sorts the page by what the rows carry instead.
    ...(query.sort && (query.sort !== "used" || offers.usage)
      ? { sort: query.sort, ...(query.dir ? { dir: query.dir } : {}) }
      : {}),
    ...(query.orientation && offers.filters ? { orientation: query.orientation } : {}),
    ...(query.kind && offers.filters ? { kind: query.kind } : {}),
    ...(query.cursor ? { cursor: query.cursor } : {}),
  });
  let items = list.items;
  // A site that sorted says so; otherwise the kit sorts the page it has and says that.
  const sortedOnPage = query.sort !== undefined && list.sorted === undefined;
  if (sortedOnPage) {
    const natural = query.sort === "name" ? "asc" : "desc";
    const flip = (query.dir ?? natural) === natural ? 1 : -1;
    items = [...items].sort((a, b) => flip * MEDIA_BY[query.sort!](a, b));
  }
  const rows = items.map((item) => rowOf(source, item));
  let detail: MediaData["detail"];
  if (query.inspect) {
    const found = await orNull(source.client.media.get(query.inspect));
    detail = found ? rowOf(source, found) : null;
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
async function suggestionsFor(
  source: ContentSource,
  file: MediaDetail,
): Promise<MediaSuggestionView | null> {
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

/** What changed on the site since a cursor, for a screen that polls: rows to put in place, ids to take out. */
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
export async function loadMediaChanges(
  source: ContentSource,
  cursor: string,
): Promise<MediaChangesData | { reload: true }> {
  try {
    const changes = await source.client.media.changes(cursor, PER_PAGE);
    return {
      rows: changes.items.map((item) => rowOf(source, item)),
      removed: changes.removed ?? [],
      changeCursor: changes.changeCursor ?? cursor,
      more: changes.moreChanges === true,
    };
  } catch (error) {
    if (error instanceof SiteApiError && error.status < 500) return { reload: true };
    throw error;
  }
}
