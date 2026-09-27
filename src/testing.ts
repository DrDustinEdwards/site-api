// A reference adapter held in memory: what a conforming site does, small enough to read in one
// sitting. Carrel's tests run against it, and the conformance suite is proven on it.

import { MediaInUseError, NotFoundError, VersionConflictError, type MediaAdapter, type SiteAdapter } from "./adapter.js";
import type { ContentDoc, ContentStatus, MediaItem, MediaUploadLimits, MediaUse, Revision, SiteInfo, WriteResult } from "./contract.js";

interface Stored {
  doc: ContentDoc;
  history: Array<{ revision: Revision; source: string }>;
}

export interface MemoryAdapterOptions {
  site?: SiteInfo;
  now?: () => Date;
  /** The media group's limits, or false for a site with no media manager (a v0.1.0 site). */
  media?: MediaUploadLimits | false;
}

/** What the reference adapter accepts, like dustinedwards.info's own list, at a test-sized limit. */
export const MEMORY_MEDIA_LIMITS: MediaUploadLimits = {
  maxBytes: 5 * 1024 * 1024,
  types: ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/svg+xml"],
};

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
};

interface StoredMedia {
  item: MediaItem;
  bytes: Uint8Array;
}

function titleOf(source: string, id: string): string {
  const front = source.match(/^---\r?\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m);
  if (front) return front[1]!;
  const heading = source.match(/^#\s+(.+)$/m);
  return heading ? heading[1]!.trim() : id;
}

export function memoryAdapter(
  options: MemoryAdapterOptions = {},
): SiteAdapter & { store: Map<string, Stored>; mediaStore: Map<string, StoredMedia>; deleted: string[] } {
  const site = options.site ?? { id: "memory", name: "Memory site", origin: "https://memory.example" };
  const now = options.now ?? (() => new Date());
  const store = new Map<string, Stored>();
  let counter = 0;

  function expect(id: string, expectedVersion: string | null): Stored | undefined {
    const current = store.get(id);
    const held = current?.doc.version ?? null;
    if (held !== expectedVersion) throw new VersionConflictError(held);
    return current;
  }

  function commit(
    id: string,
    previous: Stored | undefined,
    changes: { source?: string; status: ContentStatus; publishAt?: string | null },
    changeId: string,
    message: string,
  ): WriteResult {
    const at = now().toISOString();
    const version = `v${++counter}`;
    const source = changes.source ?? previous?.doc.source ?? "";
    const wasPublished = previous?.doc.publishedAt ?? null;
    const doc: ContentDoc = {
      id,
      kind: "post",
      title: titleOf(source, id),
      status: changes.status,
      path: changes.status === "published" || wasPublished ? `/blog/${id}` : null,
      publishAt: changes.publishAt ?? null,
      publishedAt: changes.status === "published" ? (wasPublished ?? at) : wasPublished,
      updatedAt: at,
      format: "markdown",
      source,
      version,
    };
    const history = previous?.history ?? [];
    history.unshift({ revision: { version, at, author: "carrel", message: `${message} [${changeId}]` }, source });
    store.set(id, { doc, history });
    return { id, version, status: doc.status, changeId };
  }

  function existing(id: string, expectedVersion: string): Stored {
    const current = expect(id, expectedVersion);
    if (!current) throw new NotFoundError();
    return current;
  }

  const mediaStore = new Map<string, StoredMedia>();
  const deleted: string[] = [];
  let mediaCounter = 0;

  /** The site's reference check: every post whose source carries the file's URL, as the real site scans. */
  function usesOf(id: string): MediaUse[] {
    const url = `/media/${id}`;
    const uses: MediaUse[] = [];
    for (const { doc } of store.values()) {
      const lines = doc.source.split("\n");
      lines.forEach((line, i) => {
        if (line.includes(url)) uses.push({ type: "post", id: doc.id, title: doc.title, detail: `line ${i + 1}` });
      });
    }
    return uses;
  }

  const mediaAdapter: MediaAdapter | undefined =
    options.media === false
      ? undefined
      : {
          limits: options.media ?? MEMORY_MEDIA_LIMITS,
          async list(query) {
            const needle = query.q?.toLowerCase();
            const all = [...mediaStore.values()]
              .map((m) => m.item)
              .filter((i) => !needle || [i.id, i.filename ?? "", i.alt].some((t) => t.toLowerCase().includes(needle)))
              .reverse();
            const start = query.cursor ? Number(query.cursor) : 0;
            const page = all.slice(start, start + query.limit);
            return { items: page, nextCursor: start + query.limit < all.length ? String(start + query.limit) : null };
          },
          async get(id) {
            const stored = mediaStore.get(id);
            return stored ? { ...stored.item, usedBy: usesOf(id) } : null;
          },
          async upload(input) {
            const base = input.filename.replace(/\.[^.]*$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "file";
            const id = `uploads/${++mediaCounter}-${base}.${EXTENSIONS[input.contentType] ?? "bin"}`;
            const item: MediaItem = {
              id,
              url: `/media/${id}`,
              filename: input.filename,
              contentType: input.contentType,
              bytes: input.bytes.byteLength,
              width: null,
              height: null,
              alt: input.alt,
              uploadedAt: now().toISOString(),
              deletable: true,
            };
            mediaStore.set(id, { item, bytes: input.bytes });
            return item;
          },
          async delete(id) {
            if (!mediaStore.has(id)) throw new NotFoundError("No such media.");
            const uses = usesOf(id);
            if (uses.length > 0) throw new MediaInUseError(uses);
            mediaStore.delete(id);
            deleted.push(id);
          },
        };

  return {
    site,
    store,
    mediaStore,
    deleted,
    ...(mediaAdapter ? { media: mediaAdapter } : {}),
    content: {
      async list(query) {
        const needle = query.q?.toLowerCase();
        const all = [...store.values()]
          .map((s) => s.doc)
          .filter((d) => !query.status || d.status === query.status)
          .filter((d) => !needle || d.title.toLowerCase().includes(needle) || d.source.toLowerCase().includes(needle))
          .sort((a, b) => a.id.localeCompare(b.id));
        const start = query.cursor ? Number(query.cursor) : 0;
        const page = all.slice(start, start + query.limit);
        const next = start + query.limit < all.length ? String(start + query.limit) : null;
        return {
          items: page.map(({ source: _s, version: _v, format: _f, ...summary }) => summary),
          nextCursor: next,
        };
      },
      async get(id) {
        return store.get(id)?.doc ?? null;
      },
      async saveDraft(id, input) {
        const previous = expect(id, input.expectedVersion);
        const status = previous?.doc.status === "published" ? "published" : "draft";
        return commit(id, previous, { source: input.source, status, publishAt: previous?.doc.publishAt }, input.changeId, "Save");
      },
      async publish(id, input) {
        const previous = existing(id, input.expectedVersion);
        return commit(id, previous, { source: input.source, status: "published" }, input.changeId, "Publish");
      },
      async schedule(id, input) {
        const previous = existing(id, input.expectedVersion);
        return commit(id, previous, { source: input.source, status: "scheduled", publishAt: input.publishAt }, input.changeId, "Schedule");
      },
      async unpublish(id, input) {
        const previous = existing(id, input.expectedVersion);
        return commit(id, previous, { status: "draft" }, input.changeId, "Unpublish");
      },
      async revisions(id) {
        return store.get(id)?.history.map((h) => h.revision) ?? null;
      },
      async revisionSource(id, version) {
        return store.get(id)?.history.find((h) => h.revision.version === version)?.source ?? null;
      },
    },
    preview: {
      async render(input) {
        const title = titleOf(input.source, input.id ?? "preview");
        const escape = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
        return `<!doctype html><html><head><title>${escape(title)}</title></head><body><pre>${escape(input.source)}</pre></body></html>`;
      },
    },
  };
}
