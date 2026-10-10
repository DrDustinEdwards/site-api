// A reference adapter held in memory: what a conforming site does, small enough to read in one
// sitting. Carrel's tests run against it, and the conformance suite is proven on it.

import { MediaInUseError, NotFoundError, RefusedError, VersionConflictError, type MediaAdapter, type MentionsAdapter, type SiteAdapter } from "./adapter.js";
import type { ContentDoc, ContentStatus, MediaItem, MediaUploadLimits, MediaUse, MentionItem, MentionStatus, Revision, SiteInfo, WriteResult } from "./contract.js";

interface Stored {
  doc: ContentDoc;
  history: Array<{ revision: Revision; source: string }>;
}

export interface MemoryAdapterOptions {
  site?: SiteInfo;
  now?: () => Date;
  /** The media group's limits, or false for a site with no media manager (a v0.1.0 site). */
  media?: MediaUploadLimits | false;
  /** false for a site whose adapter has no content delete (its route then answers 501). On by default. */
  contentDelete?: boolean;
  /** false for a media manager with no alt, tag or trash writes (a v0.2.0 site): those routes then answer 501. On by default. */
  mediaWrites?: boolean;
  /** false for a site that does not receive webmentions (its routes then answer 501). On by default. */
  mentions?: boolean;
  /** false for a mentions group with no reset (a v0.5.0 site): a reset then answers 501. On by default. */
  mentionReset?: boolean;
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
): SiteAdapter & {
  store: Map<string, Stored>;
  mediaStore: Map<string, StoredMedia>;
  deleted: string[];
  deletedContent: string[];
  mentionStore: Map<string, MentionItem>;
  /** Targets whose cached page the adapter purged, one entry per write that purges. */
  purged: string[];
  /** Adds a mention as the site's endpoint would, and returns its id. */
  receiveMention(fields: ReceivedMention): string;
} {
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
  const deletedContent: string[] = [];
  let mediaCounter = 0;
  let mediaVersion = 0;
  const nextMediaVersion = () => `m${++mediaVersion}`;
  const mediaWrites = options.mediaWrites !== false;

  /** The stored file, or NotFoundError; a stale expectedVersion is VersionConflictError. */
  function heldMedia(id: string, expectedVersion: string): StoredMedia {
    const stored = mediaStore.get(id);
    if (!stored) throw new NotFoundError("No such media.");
    if (stored.item.version !== expectedVersion) throw new VersionConflictError(stored.item.version ?? null, "The file changed since it was loaded.");
    return stored;
  }

  /** Every metadata write moves the version, so alt, tags and trash each count as a change. */
  function touchMedia(stored: StoredMedia, changes: Partial<MediaItem>): { version: string } {
    const version = nextMediaVersion();
    stored.item = { ...stored.item, ...changes, version };
    return { version };
  }

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
              .filter((i) => (query.trashed === "only" ? Boolean(i.trashedAt) : !i.trashedAt))
              .filter((i) => !query.tag || (i.tags ?? []).includes(query.tag))
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
              ...(mediaWrites ? { version: nextMediaVersion(), tags: [], trashedAt: null } : {}),
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
          ...(mediaWrites
            ? {
                async setAlt(id: string, input: { alt: string; expectedVersion: string; changeId: string }) {
                  return touchMedia(heldMedia(id, input.expectedVersion), { alt: input.alt });
                },
                async setTags(id: string, input: { tags: string[]; expectedVersion: string; changeId: string }) {
                  return touchMedia(heldMedia(id, input.expectedVersion), { tags: input.tags });
                },
                async trash(id: string, input: { expectedVersion: string; changeId: string }) {
                  return touchMedia(heldMedia(id, input.expectedVersion), { trashedAt: now().toISOString() });
                },
                async restore(id: string, input: { expectedVersion: string; changeId: string }) {
                  return touchMedia(heldMedia(id, input.expectedVersion), { trashedAt: null });
                },
              }
            : {}),
        };

  // ---------- mentions: what dustinedwards.info does, in memory

  const mentionStore = new Map<string, MentionItem>();
  const purged: string[] = [];
  let mentionCounter = 0;
  let mentionVersion = 0;
  const DAY = 24 * 60 * 60 * 1000;
  /** Same rule as the site: only a verified mention (pending, approved, rejected) takes a decision. */
  const DECIDABLE: MentionStatus[] = ["pending", "approved", "rejected"];

  function receiveMention(fields: ReceivedMention): string {
    const id = String(++mentionCounter);
    const status = fields.status ?? "pending";
    const receivedAt = (fields.receivedAt ?? now()).toISOString();
    mentionStore.set(id, {
      id,
      status,
      sourceUrl: fields.sourceUrl,
      targetId: fields.targetId,
      authorName: fields.authorName ?? null,
      authorUrl: fields.authorUrl ?? null,
      excerpt: fields.excerpt ?? null,
      failureReason: fields.failureReason ?? (status === "failed" ? "no-link" : null),
      receivedAt,
      verifiedAt: status === "unverified" ? null : receivedAt,
      decidedAt: null,
      version: `m${++mentionVersion}`,
    });
    return id;
  }

  function heldMention(id: string, expectedVersion: string): MentionItem {
    const current = mentionStore.get(id);
    if (!current) throw new NotFoundError("No such mention.");
    if (current.version !== expectedVersion) throw new VersionConflictError(current.version);
    return current;
  }

  function expiring(): { failed: MentionItem[]; rejected: MentionItem[] } {
    const at = now().getTime();
    const past = (status: "failed" | "rejected") =>
      [...mentionStore.values()].filter(
        (m) => m.status === status && Date.parse(m.receivedAt) < at - MEMORY_MENTION_RETENTION_DAYS[status] * DAY,
      );
    return { failed: past("failed"), rejected: past("rejected") };
  }

  const mentionsAdapter: MentionsAdapter | undefined =
    options.mentions === false
      ? undefined
      : {
          async list(query) {
            const all = [...mentionStore.values()]
              .filter((m) => !query.status || m.status === query.status)
              .sort((a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt) || Number(b.id) - Number(a.id));
            const start = query.cursor ? Number(query.cursor) : 0;
            const counts = { unverified: 0, pending: 0, approved: 0, rejected: 0, failed: 0 };
            for (const m of mentionStore.values()) counts[m.status]++;
            const soon = expiring();
            return {
              items: all.slice(start, start + query.limit),
              nextCursor: start + query.limit < all.length ? String(start + query.limit) : null,
              counts,
              expiring: { failed: soon.failed.length, rejected: soon.rejected.length },
            };
          },
          async decide(id, input) {
            const current = heldMention(id, input.expectedVersion);
            if (!DECIDABLE.includes(current.status)) {
              throw new RefusedError(`A ${current.status} mention cannot be decided: only a verified mention can.`);
            }
            const next: MentionItem = {
              ...current,
              status: input.decision === "approve" ? "approved" : "rejected",
              decidedAt: now().toISOString(),
              version: `m${++mentionVersion}`,
            };
            mentionStore.set(id, next);
            purged.push(current.targetId);
            return { status: next.status, version: next.version, purged: true };
          },
          async reset(id, input) {
            const current = heldMention(id, input.expectedVersion);
            if (current.status !== "approved" && current.status !== "rejected") {
              throw new RefusedError(`A ${current.status} mention has no decision to take back.`);
            }
            const next: MentionItem = { ...current, status: "pending", decidedAt: null, version: `m${++mentionVersion}` };
            mentionStore.set(id, next);
            purged.push(current.targetId);
            return { status: next.status, version: next.version, purged: true };
          },
          async delete(id, input) {
            const current = heldMention(id, input.expectedVersion);
            mentionStore.delete(id);
            purged.push(current.targetId);
            return { purged: true };
          },
          async sweep() {
            const gone = expiring();
            for (const m of [...gone.failed, ...gone.rejected]) mentionStore.delete(m.id);
            return { failed: gone.failed.length, rejected: gone.rejected.length };
          },
        };

  // A v0.5.0 mentions group: no way back to pending.
  if (mentionsAdapter && options.mentionReset === false) delete mentionsAdapter.reset;

  return {
    site,
    mentionStore,
    purged,
    receiveMention,
    ...(mentionsAdapter ? { mentions: mentionsAdapter } : {}),
    store,
    mediaStore,
    deleted,
    deletedContent,
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
      ...(options.contentDelete === false
        ? {}
        : {
            async delete(id: string, input: { expectedVersion: string; changeId: string }) {
              if (!store.has(id)) throw new NotFoundError();
              expect(id, input.expectedVersion);
              store.delete(id);
              deletedContent.push(id);
            },
          }),
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
