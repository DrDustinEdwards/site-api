import { splitSource } from "@drdustinedwards/site-helpers/frontmatter";
import { postFieldsOf, tagsOf } from "../frontmatter.js";
import type {
  ContentDoc,
  ContentStatus,
  ContentSummary,
  MediaItem,
  MediaResize,
  MediaRevision,
  MediaUploadLimits,
  MentionStatus,
  NotFoundRow,
  Revision,
  ScheduledUpdate,
  SiteInfo,
} from "../contract.js";

export interface Stored {
  doc: ContentDoc;
  history: Array<{ revision: Revision; source: string }>;
  /** The update waiting on a live item (v0.10.0), kept beside it as a site's own table would. */
  pending?: ScheduledUpdate;
  /** The change that scheduled a scheduled item, which its publish is recorded under. */
  scheduleChangeId?: string;
}

export interface MemoryAdapterOptions {
  site?: SiteInfo;
  now?: () => Date;
  /** The media group's limits, or false for a site with no media manager (a v0.1.0 site). */
  media?: MediaUploadLimits | false;
  /** false for a site whose adapter has no content delete (its route then answers 501). On by default. */
  contentDelete?: boolean;
  /** true for a site that deletes only from the trash, refusing a delete of a post that is not in it (germomics). Off by default. */
  deleteFromTrashOnly?: boolean;
  /** false for a site that keeps no post tags through the API (a v0.5.0 site): the tags route then answers 501. On by default. */
  contentTags?: boolean;
  /** false for a site whose transcripts are read only (before v0.36.0): the transcript route then answers 501. On by default. */
  contentTranscript?: boolean;
  /** false for a v0.14.0 content group (v0.17.0): no settable publish date, rename, trash, list filters or post fields. On by default. */
  contentExtras?: boolean;
  /** false for a media manager with no alt, tag, trash, focal point, caption or replace writes (a v0.2.0 site): those routes then answer 501. On by default. */
  mediaWrites?: boolean;
  /** false for a media manager with no lenses and no sort (a v0.5.0 site): a lens then answers 501. On by default. */
  mediaLenses?: boolean;
  /** true for a site whose replace refuses a picture of another size, as some sites do (v0.11.0). Off by default. */
  mediaReplaceKeepsSize?: boolean;
  /**
   * false for a v0.12.0 media manager (v0.13.0): no duplicates, usage counts, filters, credit, transforms, history, changes,
   * embedded metadata, suggestions or new lenses. On by default, with `mediaWrites`.
   */
  mediaExtras?: boolean;
  /**
   * true for a site that answers an upload of bytes it holds with that file (v0.13.0), and the duplicates lens. Off by
   * default, since tests upload the same few bytes again and again.
   */
  mediaDuplicates?: boolean;
  /** What uploads shrink to (v0.13.0), or false for none. { maxEdge: 2048, quality: 82 } by default, with `mediaExtras`. */
  mediaResize?: MediaResize | false;
  /** The fetch imports use (v0.13.0). Absent: the site does not import, so no test ever reaches the network. */
  mediaImportFetch?: typeof fetch;
  /** false for a mentions group that ignores q and targetId (a v0.5.0 site) and so echoes no `filtered`. On by default. */
  mentionFilters?: boolean;
  /** false for a site that does not receive webmentions (its routes then answer 501). On by default. */
  mentions?: boolean;
  /** false for a mentions group with no reset (a v0.5.0 site): a reset then answers 501. On by default. */
  mentionReset?: boolean;
  /** false for a site with no scheduled updates (a v0.9.0 site): reading and canceling a schedule answer 501. On by default. */
  schedules?: boolean;
  /** The site's counted 404s (v0.16.0), as report rows most hits first. Absent: the site reports none, and the route answers 501. */
  notFound?: NotFoundRow[];
}

/** What the reference adapter's sweep keeps, like dustinedwards.info: failed rows 30 days, rejected rows 90. */
export const MEMORY_MENTION_RETENTION_DAYS = { failed: 30, rejected: 90 } as const;

/** What the endpoint writes when a stranger sends a mention, for tests to seed the queue with. */
export interface ReceivedMention {
  sourceUrl: string;
  targetId: string;
  status?: MentionStatus;
  authorName?: string | null;
  authorUrl?: string | null;
  excerpt?: string | null;
  failureReason?: string | null;
  receivedAt?: Date;
}

/** What the reference adapter accepts, like dustinedwards.info's own list, at a test-sized limit. */
export const MEMORY_MEDIA_LIMITS: MediaUploadLimits = {
  maxBytes: 5 * 1024 * 1024,
  types: ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml"],
};

export const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
};

export interface StoredMedia {
  item: MediaItem;
  bytes: Uint8Array;
  /** v0.13.0: the content hash the package sent, for duplicates. */
  sha256?: string;
  /** v0.13.0: every set of bytes the file has had, oldest first; the last is current. */
  revisions?: Array<Omit<MediaRevision, "current"> & { data: Uint8Array }>;
}

/** A PNG's width and height from its IHDR chunk, as a site measures an upload; null for anything else. */
export function measure(bytes: Uint8Array): { width: number; height: number } | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => bytes[i] === v);
  if (!png || bytes.length < 24 || String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR")
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const [width, height] = [view.getUint32(16), view.getUint32(20)];
  return width > 0 && height > 0 ? { width, height } : null;
}

/** A PNG's tEXt chunks, the embedded metadata the reference adapter reads (a real site reads IPTC and EXIF as well). */
export function pngText(bytes: Uint8Array): Record<string, string> {
  const found: Record<string, string> = {};
  if (!measure(bytes)) return found;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 8; at + 8 <= bytes.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const data = bytes.subarray(at + 8, Math.min(at + 8 + length, bytes.length));
    if (type === "tEXt") {
      const nul = data.indexOf(0);
      if (nul > 0)
        found[String.fromCharCode(...data.subarray(0, nul))] = String.fromCharCode(
          ...data.subarray(nul + 1),
        );
    }
    at += 12 + length;
  }
  return found;
}

/** The item with its tags (v0.6.0), where its frontmatter can hold them, and its authors and excerpt where it has them (v0.17.0). */
export function withTags(doc: ContentDoc): ContentDoc {
  const front = splitSource(doc.source).front;
  if (front === null) return doc;
  const { authors, excerpt } = postFieldsOf(front);
  return {
    ...doc,
    tags: tagsOf(front),
    ...(authors.length ? { authors } : {}),
    ...(excerpt ? { excerpt } : {}),
  };
}

/** A list row: the item without its source, with its version and tags. */
export function summaryOf(doc: ContentDoc): ContentSummary {
  const { source: _s, format: _f, ...summary } = withTags(doc);
  return summary;
}

export function titleOf(source: string, id: string): string {
  const front = source.match(/^---\r?\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m);
  if (front) return front[1]!;
  const heading = source.match(/^#\s+(.+)$/m);
  return heading ? heading[1]!.trim() : id;
}

/** What a write to the content store changes; anything it leaves out keeps its value. */
export interface WriteChanges {
  source?: string;
  status: ContentStatus;
  publishAt?: string | null;
  pending?: ScheduledUpdate | null;
  publishedAt?: string;
  redate?: string;
  trashedAt?: string | null;
  hasDraft?: boolean;
}

export const at = (time: string) => Date.parse(time);
