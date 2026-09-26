// A reference adapter held in memory: what a conforming site does, small enough to read in one
// sitting. Carrel's tests run against it, and the conformance suite is proven on it.

import { NotFoundError, VersionConflictError, type SiteAdapter } from "./adapter.js";
import type { ContentDoc, ContentStatus, Revision, SiteInfo, WriteResult } from "./contract.js";

interface Stored {
  doc: ContentDoc;
  history: Array<{ revision: Revision; source: string }>;
}

export interface MemoryAdapterOptions {
  site?: SiteInfo;
  now?: () => Date;
}

function titleOf(source: string, id: string): string {
  const front = source.match(/^---\r?\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m);
  if (front) return front[1]!;
  const heading = source.match(/^#\s+(.+)$/m);
  return heading ? heading[1]!.trim() : id;
}

export function memoryAdapter(options: MemoryAdapterOptions = {}): SiteAdapter & { store: Map<string, Stored> } {
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

  return {
    site,
    store,
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
