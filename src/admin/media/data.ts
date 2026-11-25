import { SiteApiError } from "../../client.js";
import { orientationOf } from "../../media.js";
import {
  MEDIA_SORTS,
  MediaId,
  MediaKind,
  MediaLens,
  MediaOrientation,
  MediaTag,
  type Capabilities,
  type MediaDetail,
  type MediaItem,
  type MediaSort,
} from "../../contract.js";
import { type ContentSource, PER_PAGE, orNull, absolute } from "../kit.js";
import type { MediaChangesData, MediaData, MediaQuery } from "../media.js";

/**
 * A file as the library shows it: the site's item, plus the absolute address a browser loads and (v0.13.1) which way a
 * picture lies, so a screen filters and warns by the package's own rule (orientationOf) rather than a copy of it.
 */
export type MediaRow = MediaItem & { src: string; orientation?: MediaOrientation };

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
 * What the site's model suggests for the file in the inspector (v0.13.0): only what would change it, the tags it does not
 * carry and an alt text unlike its own, so each shows as a suggestion to accept (the `tag-add` and `alt` intents) or dismiss.
 */
export interface MediaSuggestionView {
  tags: string[];
  alt: string | null;
  model: string;
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

export function mediaOffers(capabilities: Capabilities): MediaData["offers"] {
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
    replaceKeepsSize:
      media && capabilities.mediaReplace === true && capabilities.mediaReplaceKeepsSize === true,
    duplicates: media && capabilities.mediaDuplicates === true,
    usage: media && capabilities.mediaUsage === true,
    filters: media && capabilities.mediaFilters === true,
    import: media && capabilities.mediaImport === true,
    credit: media && capabilities.mediaCredit === true,
    transform: media && capabilities.mediaTransform === true,
    history: media && capabilities.mediaHistory === true,
    live: media && capabilities.mediaChanges === true,
    resize: media ? (capabilities.mediaResize ?? null) : null,
    resizePass:
      media && capabilities.mediaResize !== undefined && capabilities.mediaResizePass === true,
    embedded: media && capabilities.mediaEmbedded === true,
    suggestions: media && capabilities.mediaSuggestions === true,
    uploadSuggestions: media && capabilities.mediaUploadSuggestions === true,
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
  // A site that sorted says so (v0.6.0); otherwise the kit sorts the page it has and says that.
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
