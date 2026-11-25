import { memorySchedules } from "./schedules.js";
import {
  NotFoundError,
  RefusedError,
  transcriptVersion,
  VersionConflictError,
  type SiteAdapter,
} from "../adapter.js";
import { joinSource, splitSource } from "@drdustinedwards/site-helpers/frontmatter";
import { POST_FIELDS, SEARCH_FIELDS, setTags as writeTags } from "../frontmatter.js";
import type { ContentDoc, WriteResult } from "../contract.js";

import {
  at,
  summaryOf,
  titleOf,
  withTags,
  type MemoryAdapterOptions,
  type Stored,
  type WriteChanges,
} from "./shared.js";

/** The in-memory content group and its schedules: the store, the writes over it and what they leave behind. */
export function memoryContent(options: MemoryAdapterOptions, now: () => Date) {
  const store = new Map<string, Stored>();
  const schedules = options.schedules !== false;
  const contentExtras = options.contentExtras !== false;
  const redirects = new Map<string, string>();
  const transcripts = new Map<string, string>();
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
    changes: WriteChanges,
    changeId: string,
    message: string,
    actor?: { name: string },
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
      publishedAt:
        changes.status === "published"
          ? (changes.redate ?? wasPublished ?? changes.publishedAt ?? at)
          : wasPublished,
      updatedAt: at,
      format: "markdown",
      source,
      version,
      ...(contentExtras
        ? {
            trashedAt:
              changes.trashedAt !== undefined
                ? changes.trashedAt
                : (previous?.doc.trashedAt ?? null),
          }
        : {}),
      // v0.22.0: only a live item has a pending draft; a write that does not say keeps what it had. (In memory the draft is
      // the source itself: there is no separate public copy to keep.)
      ...(contentExtras
        ? {
            hasDraft:
              changes.status === "published" &&
              (changes.hasDraft ?? previous?.doc.hasDraft ?? false),
          }
        : {}),
    };
    // Only a live item carries an update, and a write that does not name one keeps what was waiting.
    const pending =
      changes.status !== "published"
        ? undefined
        : changes.pending === undefined
          ? previous?.pending
          : (changes.pending ?? undefined);
    if (schedules)
      doc.scheduledUpdate = pending
        ? { publishAt: pending.publishAt, changeId: pending.changeId }
        : null;
    const history = previous?.history ?? [];
    // v0.22.0: the person Carrel names is the revision's author.
    history.unshift({
      revision: {
        version,
        at,
        author: actor?.name ?? "carrel",
        message: `${message} [${changeId}]`,
      },
      source,
    });
    store.set(id, {
      doc,
      history,
      ...(pending ? { pending } : {}),
      ...(changes.status === "scheduled" ? { scheduleChangeId: changeId } : {}),
    });
    return {
      id,
      version,
      status: doc.status,
      changeId,
      ...(schedules ? { scheduledUpdate: doc.scheduledUpdate } : {}),
    };
  }

  function existing(id: string, expectedVersion: string): Stored {
    const current = expect(id, expectedVersion);
    if (!current) throw new NotFoundError();
    return current;
  }

  const deletedContent: string[] = [];

  /** The stored item at its expected version: a missing id is NotFoundError, a stale version a conflict. */
  function held(id: string, expectedVersion: string): Stored {
    if (!store.has(id)) throw new NotFoundError();
    return existing(id, expectedVersion);
  }

  /** A write made on behalf of a request: its change id and the person it names. */
  function write(
    id: string,
    previous: Stored | undefined,
    changes: WriteChanges,
    input: { changeId: string; actor?: { name: string } },
    message: string,
  ): WriteResult {
    return commit(id, previous, changes, input.changeId, message, input.actor);
  }

  /** v0.22.0: every other post whose source links to this one's path, as a site's link table would answer. */
  async function backlinks(id: string) {
    const target = `/blog/${id}`;
    // An id holds only letters, digits, dots, underscores and hyphens, so the dot is the one character to escape.
    const linking = new RegExp(`${target.replace(/\./g, "\\.")}(?![\\w.-])`);
    return [...store.values()]
      .filter(({ doc }) => doc.id !== id && linking.test(doc.source))
      .map(({ doc }) => ({
        id: doc.id,
        title: doc.title,
        path: doc.status === "published" ? doc.path : null,
      }));
  }

  /** The reference schedules group (v0.10.0): the update sits beside the live item until `apply` puts it live. */
  const schedulesAdapter = schedules
    ? memorySchedules({ store, now, existing, commit })
    : undefined;

  const content: SiteAdapter["content"] = {
    ...(contentExtras
      ? {
          publishedAtSettable: true,
          hasDraft: true,
          postFields: POST_FIELDS,
          searchFields: SEARCH_FIELDS,
          filters: ["kind", "tag", "author", "published"] as const,
        }
      : {}),
    async list(query) {
      const needle = query.q?.toLowerCase();
      const all = [...store.values()]
        .map((s) => s.doc)
        .filter(
          (d) =>
            !query.status ||
            d.status === query.status ||
            (query.status === "draft" && d.hasDraft === true),
        )
        .filter((d) => Boolean(d.trashedAt) === Boolean(query.trashed))
        .filter((d) => !query.kind || d.kind === query.kind)
        .filter(
          (d) =>
            !query.tag ||
            (withTags(d).tags ?? []).some((t) => t.toLowerCase() === query.tag!.toLowerCase()),
        )
        .filter((d) => !query.author || (withTags(d).authors ?? []).includes(query.author))
        .filter(
          (d) =>
            !query.publishedAfter ||
            (d.publishedAt !== null && at(d.publishedAt) >= at(query.publishedAfter)),
        )
        .filter(
          (d) =>
            !query.publishedBefore ||
            (d.publishedAt !== null && at(d.publishedAt) < at(query.publishedBefore)),
        )
        .filter(
          (d) =>
            !needle ||
            d.title.toLowerCase().includes(needle) ||
            d.source.toLowerCase().includes(needle),
        )
        .sort((a, b) => a.id.localeCompare(b.id));
      // A search without a sort answers the newest updated first (v0.17.0), as every site's does.
      if (needle && !query.sort)
        all.sort(
          (a, b) =>
            (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.id.localeCompare(b.id),
        );
      // v0.6.0: sorted as asked, newest first for the dates and A to Z for titles unless dir says otherwise.
      const sorted = query.sort
        ? { sort: query.sort, dir: query.dir ?? (query.sort === "title" ? "asc" : "desc") }
        : undefined;
      if (sorted) {
        const key = (d: ContentDoc) =>
          sorted.sort === "title"
            ? d.title.toLowerCase()
            : sorted.sort === "published"
              ? (d.publishedAt ?? d.publishAt ?? "")
              : (d.updatedAt ?? "");
        all.sort(
          (a, b) =>
            (sorted.dir === "asc" ? 1 : -1) * key(a).localeCompare(key(b)) ||
            a.id.localeCompare(b.id),
        );
      }
      const start = query.cursor ? Number(query.cursor) : 0;
      const page = all.slice(start, start + query.limit);
      const next = start + query.limit < all.length ? String(start + query.limit) : null;
      return {
        items: page.map(summaryOf),
        nextCursor: next,
        total: all.length,
        ...(sorted ? { sorted } : {}),
      };
    },
    async get(id) {
      const doc = store.get(id)?.doc;
      if (!doc) return null;
      const transcript = transcripts.get(id);
      return { ...withTags(doc), ...(transcript !== undefined ? { transcript } : {}) };
    },
    // v0.36.0: the transcript is live at once and the item's version stays.
    ...(options.contentTranscript === false
      ? {}
      : {
          async setTranscript(
            id: string,
            input: { transcript: string; expectedTranscriptVersion: string | null },
          ) {
            const held = store.get(id);
            if (!held) throw new NotFoundError();
            const now = transcripts.get(id);
            const version = now === undefined ? null : await transcriptVersion(now);
            if (version !== input.expectedTranscriptVersion)
              throw new VersionConflictError(version);
            transcripts.set(id, input.transcript);
            return { version: held.doc.version };
          },
        }),
    async saveDraft(id, input) {
      const previous = expect(id, input.expectedVersion);
      const status = previous?.doc.status === "published" ? "published" : "draft";
      return write(
        id,
        previous,
        {
          source: input.source,
          status,
          publishAt: previous?.doc.publishAt,
          hasDraft: status === "published",
        },
        input,
        "Save",
      );
    },
    async publish(id, input) {
      const previous = existing(id, input.expectedVersion);
      // A publish now drops any update that was waiting: what goes live is this.
      const redate = input.publishedAt ? { redate: new Date(input.publishedAt).toISOString() } : {};
      return write(
        id,
        previous,
        { source: input.source, status: "published", pending: null, hasDraft: false, ...redate },
        input,
        "Publish",
      );
    },
    async schedule(id, input) {
      const previous = existing(id, input.expectedVersion);
      return write(
        id,
        previous,
        { source: input.source, status: "scheduled", publishAt: input.publishAt },
        input,
        "Schedule",
      );
    },
    async unpublish(id, input) {
      const previous = existing(id, input.expectedVersion);
      return write(id, previous, { status: "draft" }, input, "Unpublish");
    },
    async revisions(id) {
      return store.get(id)?.history.map((h) => h.revision) ?? null;
    },
    ...(contentExtras ? { backlinks } : {}),
    async revisionSource(id, version) {
      return store.get(id)?.history.find((h) => h.revision.version === version)?.source ?? null;
    },
    ...(options.contentTags === false
      ? {}
      : {
          async setTags(
            id: string,
            input: {
              tags: string[];
              expectedVersion: string;
              changeId: string;
              actor?: { name: string };
            },
          ) {
            const previous = held(id, input.expectedVersion);
            const parts = splitSource(previous.doc.source);
            if (parts.front === null)
              throw new RefusedError(
                "This post has no frontmatter, so it has nowhere to keep tags.",
              );
            const source = joinSource({ ...parts, front: writeTags(parts.front, input.tags) });
            return write(
              id,
              previous,
              { source, status: previous.doc.status, publishAt: previous.doc.publishAt },
              input,
              "Tags",
            );
          },
        }),
    ...(contentExtras
      ? {
          async rename(
            id: string,
            input: {
              newId: string;
              expectedVersion: string;
              changeId: string;
              actor?: { name: string };
            },
          ) {
            const previous = held(id, input.expectedVersion);
            if (store.has(input.newId)) throw new RefusedError(`${input.newId} is already taken.`);
            const previousPath = previous.doc.publishedAt ? previous.doc.path : null;
            store.delete(id);
            const moved = { ...previous, doc: { ...previous.doc, id: input.newId } };
            const written = commit(
              input.newId,
              moved,
              { status: previous.doc.status, publishAt: previous.doc.publishAt },
              input.changeId,
              `Rename from ${id}`,
              input.actor,
            );
            if (previousPath) redirects.set(previousPath, store.get(input.newId)!.doc.path!);
            return { ...written, previousPath };
          },
          // A live item leaves the site as it goes to the trash, and comes back a draft.
          async trash(
            id: string,
            input: { expectedVersion: string; changeId: string; actor?: { name: string } },
          ) {
            const previous = held(id, input.expectedVersion);
            if (previous.doc.trashedAt)
              throw new RefusedError("This post is already in the trash.");
            return write(
              id,
              previous,
              { status: "draft", pending: null, trashedAt: now().toISOString() },
              input,
              "Trash",
            );
          },
          async restore(
            id: string,
            input: { expectedVersion: string; changeId: string; actor?: { name: string } },
          ) {
            const previous = held(id, input.expectedVersion);
            if (!previous.doc.trashedAt) throw new RefusedError("This post is not in the trash.");
            return write(id, previous, { status: "draft", trashedAt: null }, input, "Restore");
          },
        }
      : {}),
    ...(options.contentDelete === false
      ? {}
      : {
          async delete(id: string, input: { expectedVersion: string; changeId: string }) {
            if (!store.has(id)) throw new NotFoundError();
            const held = expect(id, input.expectedVersion);
            if (options.deleteFromTrashOnly && !held?.doc.trashedAt)
              throw new RefusedError("Move this post to the trash first.");
            store.delete(id);
            deletedContent.push(id);
          },
        }),
  };
  return {
    store,
    redirects,
    transcripts,
    deletedContent,
    content,
    schedulesAdapter,
  };
}
