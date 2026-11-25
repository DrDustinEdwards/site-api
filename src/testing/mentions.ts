import {
  NotFoundError,
  RefusedError,
  VersionConflictError,
  type MentionsAdapter,
} from "../adapter.js";
import type { MentionItem, MentionStatus } from "../contract.js";

import {
  MEMORY_MENTION_RETENTION_DAYS,
  type MemoryAdapterOptions,
  type ReceivedMention,
} from "./shared.js";

/** The in-memory mentions group, as dustinedwards.info keeps it. */
export function memoryMentions(options: MemoryAdapterOptions, now: () => Date) {
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

  /** Stores a mention's decision under a new version and purges the page it is shown on. */
  function settle(current: MentionItem, changes: Partial<MentionItem>) {
    const next: MentionItem = { ...current, ...changes, version: `m${++mentionVersion}` };
    mentionStore.set(current.id, next);
    purged.push(current.targetId);
    return { status: next.status, version: next.version, purged: true };
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
        (m) =>
          m.status === status &&
          Date.parse(m.receivedAt) < at - MEMORY_MENTION_RETENTION_DAYS[status] * DAY,
      );
    return { failed: past("failed"), rejected: past("rejected") };
  }

  const mentionsAdapter: MentionsAdapter | undefined =
    options.mentions === false
      ? undefined
      : {
          async list(query) {
            const filters = options.mentionFilters !== false;
            const needle = filters ? query.q?.toLowerCase() : undefined;
            const all = [...mentionStore.values()]
              .filter((m) => !query.status || m.status === query.status)
              .filter(
                (m) =>
                  !needle ||
                  [m.sourceUrl, m.authorName ?? "", m.excerpt ?? ""].some((t) =>
                    t.toLowerCase().includes(needle),
                  ),
              )
              .filter((m) => !filters || !query.targetId || m.targetId === query.targetId)
              .sort(
                (a, b) =>
                  Date.parse(b.receivedAt) - Date.parse(a.receivedAt) ||
                  Number(b.id) - Number(a.id),
              );
            const start = query.cursor ? Number(query.cursor) : 0;
            const counts = { unverified: 0, pending: 0, approved: 0, rejected: 0, failed: 0 };
            for (const m of mentionStore.values()) counts[m.status]++;
            const soon = expiring();
            return {
              items: all.slice(start, start + query.limit),
              nextCursor: start + query.limit < all.length ? String(start + query.limit) : null,
              counts,
              expiring: { failed: soon.failed.length, rejected: soon.rejected.length },
              ...(filters && (query.q || query.targetId)
                ? {
                    filtered: {
                      ...(query.q ? { q: query.q } : {}),
                      ...(query.targetId ? { targetId: query.targetId } : {}),
                    },
                  }
                : {}),
            };
          },
          async decide(id, input) {
            const current = heldMention(id, input.expectedVersion);
            if (!DECIDABLE.includes(current.status)) {
              throw new RefusedError(
                `A ${current.status} mention cannot be decided: only a verified mention can.`,
              );
            }
            return settle(current, {
              status: input.decision === "approve" ? "approved" : "rejected",
              decidedAt: now().toISOString(),
            });
          },
          async reset(id, input) {
            const current = heldMention(id, input.expectedVersion);
            if (current.status !== "approved" && current.status !== "rejected") {
              throw new RefusedError(`A ${current.status} mention has no decision to take back.`);
            }
            return settle(current, { status: "pending", decidedAt: null });
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

  // A mentions group with no way back to pending.
  if (mentionsAdapter && options.mentionReset === false) delete mentionsAdapter.reset;
  return { mentionStore, purged, receiveMention, mentionsAdapter };
}
