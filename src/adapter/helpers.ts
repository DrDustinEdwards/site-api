import { sha256Hex } from "@dustinedwards/site-runtime/encoding";
import { CONTENT_FILTERS, PREVIEW_LINK_MAX_HOURS } from "../contract.js";
import type { Capabilities, ContentFilter, ContentSort, ListQuery } from "../contract.js";

/**
 * What the site's adapter offers, for the capabilities answer. A group the adapter lacks answers 501.
 * `store`: the site gave createSiteApi a store.
 */
import type { SiteAdapter } from "../adapter.js";

export function capabilitiesOf(
  adapter: SiteAdapter,
  options: { store?: boolean; hooks?: readonly string[] } = {},
): Capabilities {
  return {
    content: true,
    preview: true,
    media: Boolean(adapter.media),
    inbox: false,
    insight: Boolean(adapter.insight),
    publications: false,
    ...(adapter.media ? { mediaUpload: adapter.media.limits } : {}),
    ...(adapter.content.delete ? { contentDelete: true } : {}),
    ...(adapter.content.setTags ? { contentTags: true } : {}),
    ...(adapter.content.publishedAtSettable ? { contentPublishedAt: true } : {}),
    ...(adapter.content.hasDraft ? { contentHasDraft: true } : {}),
    ...(adapter.content.rename ? { contentRename: true } : {}),
    ...(hasContentTrash(adapter) ? { contentTrash: true } : {}),
    ...(contentFiltersOf(adapter).length ? { contentFilters: contentFiltersOf(adapter) } : {}),
    ...(adapter.content.searchFields?.length
      ? { searchFields: [...adapter.content.searchFields] }
      : {}),
    ...(adapter.content.postFields?.length ? { postFields: [...adapter.content.postFields] } : {}),
    ...(adapter.media?.setAlt ? { mediaAlt: true } : {}),
    ...(adapter.media?.lenses?.length ? { mediaLenses: [...adapter.media.lenses] } : {}),
    ...(adapter.media?.setTags ? { mediaTags: true } : {}),
    ...(adapter.media?.trash && adapter.media.restore ? { mediaTrash: true } : {}),
    ...(adapter.media?.setFocus ? { mediaFocus: true } : {}),
    ...(adapter.media?.setCaption ? { mediaCaption: true } : {}),
    ...(adapter.media?.replace ? { mediaReplace: true } : {}),
    ...(adapter.media?.replace && adapter.media.replaceKeepsSize
      ? { mediaReplaceKeepsSize: true }
      : {}),
    ...(adapter.media?.findByHash ? { mediaDuplicates: true } : {}),
    ...(adapter.media?.usage ? { mediaUsage: true } : {}),
    ...(adapter.media?.filters ? { mediaFilters: true } : {}),
    ...(adapter.media?.importFetch ? { mediaImport: true } : {}),
    ...(adapter.media?.setCredit ? { mediaCredit: true } : {}),
    ...(adapter.media?.transform ? { mediaTransform: true } : {}),
    ...(adapter.media?.history && adapter.media.revert ? { mediaHistory: true } : {}),
    ...(adapter.media?.changes ? { mediaChanges: true } : {}),
    ...(adapter.media?.resize ? { mediaResize: { ...adapter.media.resize } } : {}),
    ...(adapter.media?.resize && adapter.media.shrink ? { mediaResizePass: true } : {}),
    ...(adapter.media?.readsEmbedded ? { mediaEmbedded: true } : {}),
    ...(adapter.media?.suggest ? { mediaSuggestions: true } : {}),
    ...(adapter.media?.suggestFile ? { mediaUploadSuggestions: true } : {}),
    ...(adapter.mentions ? { mentions: true } : {}),
    ...(adapter.mentions?.reset ? { mentionReset: true } : {}),
    ...(adapter.schedules ? { scheduledUpdates: true } : {}),
    ...(options.store
      ? { replay: true, previewLinks: true, previewLinkHours: { max: PREVIEW_LINK_MAX_HOURS } }
      : {}),
    ...(options.store && options.hooks?.length ? { hooks: [...options.hooks] } : {}),
    ...(adapter.content.backlinks ? { backlinks: true } : {}),
    ...(adapter.content.setTranscript ? { contentTranscript: true } : {}),
    ...(adapter.renderVersion ? { render: { version: adapter.renderVersion } } : {}),
    ...(adapter.insight ? { insightNotFound: true } : {}),
  };
}

/** Trash and restore, and the delete that empties the trash. */
export function hasContentTrash(adapter: SiteAdapter): boolean {
  const { content } = adapter;
  return (
    content.trash !== undefined && content.restore !== undefined && content.delete !== undefined
  );
}

/** The list filters the site applies, in the contract's order. */
export function contentFiltersOf(adapter: SiteAdapter): ContentFilter[] {
  const offered = new Set<ContentFilter>(adapter.content.filters ?? []);
  if (hasContentTrash(adapter)) offered.add("trashed");
  return CONTENT_FILTERS.filter((f) => offered.has(f));
}

/**
 * A content version made from the fields that identify an item's own content: the first 32 hex
 * characters of the SHA-256 of their JSON. For a site with no version column; pass the same fields,
 * in the same order, on every read and write.
 */
export async function contentVersion(parts: readonly unknown[]): Promise<string> {
  return (await sha256Hex(JSON.stringify(parts))).slice(0, 32);
}

/**
 * A transcript's version: contentVersion of its text, so the site and Carrel name the same one without a
 * column. The package puts it on every read that carries a transcript; an adapter checks a transcript write against it.
 */
export function transcriptVersion(transcript: string): Promise<string> {
  return contentVersion(["transcript", transcript]);
}

/**
 * The page of a content list a site holds in memory: `rows` ordered as the contract's `sort` and `dir` ask (dates
 * newest first, titles A to Z, unless `dir` says otherwise), cut at `cursor` for `limit` rows. `keys` reads each sort's
 * value from a row. The answer carries what `ContentList` needs beside the items: `total`, `nextCursor` and `sorted`.
 */
export function orderAndPage<T>(
  rows: readonly T[],
  query: Pick<ListQuery, "sort" | "dir" | "cursor" | "limit">,
  keys: Record<ContentSort, (row: T) => string | number>,
): {
  page: T[];
  total: number;
  nextCursor: string | null;
  sorted: { sort: ContentSort; dir: "asc" | "desc" };
} {
  const sort = query.sort ?? "updated";
  const dir = query.dir ?? (sort === "title" ? "asc" : "desc");
  const key = keys[sort];
  const ordered = [...rows].sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    return (
      (typeof x === "string" ? x.localeCompare(y as string) : x - (y as number)) *
      (dir === "asc" ? 1 : -1)
    );
  });
  const start = Math.max(0, Number.parseInt(query.cursor ?? "0", 10) || 0);
  const next = start + query.limit;
  return {
    page: ordered.slice(start, next),
    total: ordered.length,
    nextCursor: next < ordered.length ? String(next) : null,
    sorted: { sort, dir },
  };
}
