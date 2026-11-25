// A reference adapter held in memory: what a conforming site does, small enough to read in one
// sitting. Carrel's tests run against it, and the conformance suite is proven on it.

import { type SiteAdapter } from "./adapter.js";
import type { MentionItem } from "./contract.js";

import { memoryContent } from "./testing/content.js";
import { memoryMedia } from "./testing/media.js";
import { memoryMentions } from "./testing/mentions.js";
import {
  MEMORY_MEDIA_LIMITS,
  titleOf,
  type MemoryAdapterOptions,
  type ReceivedMention,
  type Stored,
  type StoredMedia,
} from "./testing/shared.js";
export {
  MEMORY_MEDIA_LIMITS,
  type MemoryAdapterOptions,
  type ReceivedMention,
  type Stored,
  type StoredMedia,
};

export function memoryAdapter(options: MemoryAdapterOptions = {}): SiteAdapter & {
  store: Map<string, Stored>;
  mediaStore: Map<string, StoredMedia>;
  deleted: string[];
  deletedContent: string[];
  mentionStore: Map<string, MentionItem>;
  /** Targets whose cached page the adapter purged, one entry per write that purges. */
  purged: string[];
  /** Adds a mention as the site's endpoint would, and returns its id. */
  receiveMention(fields: ReceivedMention): string;
  /** The permanent redirects a rename left, old path to new. */
  redirects: Map<string, string>;
  /** Each item's transcript, by id, read back on `get`; set one to seed it, as a site's admin would. */
  transcripts: Map<string, string>;
} {
  const site = options.site ?? {
    id: "memory",
    name: "Memory site",
    origin: "https://memory.example",
  };
  const now = options.now ?? (() => new Date());
  const { store, redirects, transcripts, deletedContent, content, schedulesAdapter } =
    memoryContent(options, now);
  const { mediaStore, deleted, mediaAdapter } = memoryMedia(options, store, now);
  const { mentionStore, purged, receiveMention, mentionsAdapter } = memoryMentions(options, now);

  return {
    site,
    ...(schedulesAdapter ? { schedules: schedulesAdapter } : {}),
    mentionStore,
    purged,
    receiveMention,
    ...(mentionsAdapter ? { mentions: mentionsAdapter } : {}),
    ...(options.notFound
      ? {
          insight: {
            notFound: async (q) =>
              options
                .notFound!.filter((row) => q.includeProbes || row.kind === "page")
                .slice(0, q.limit),
          },
        }
      : {}),
    store,
    redirects,
    transcripts,
    mediaStore,
    deleted,
    deletedContent,
    ...(mediaAdapter ? { media: mediaAdapter } : {}),
    content,
    preview: {
      async render(input) {
        const title = titleOf(input.source, input.id ?? "preview");
        const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
        return `<!doctype html><html><head><title>${escape(title)}</title></head><body><pre>${escape(input.source)}</pre></body></html>`;
      },
    },
  };
}
