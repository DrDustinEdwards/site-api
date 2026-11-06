// The mentions half of the content kit: MentionsList's view data and its intents.

import {
  MentionId,
  MentionStatus,
  type MentionCounts,
  type MentionItem,
  type MentionList,
} from "../contract.js";
import {
  type Permissions,
  type ContentSource,
  type IntentInput,
  type Outcome,
  type IntentResult,
  type IntentInput as Input,
  PER_PAGE,
  askFirst,
  texts,
  NOT_YOURS,
  text,
  refused,
  changeId,
  recordDone,
  targetsOf,
  checkCount,
  summarize,
  result,
  failure,
  eachItem,
} from "./kit.js";


export type MentionFilter = MentionStatus | "all";
export const MENTION_FILTERS: readonly MentionFilter[] = ["pending", "failed", "approved", "rejected", "unverified", "all"];

export interface MentionsQuery {
  /** Absent: open on pending, or on all when nothing is pending. */
  status?: MentionFilter;
  /** v0.6.0: words in the source, the author or the excerpt. */
  q?: string;
  /** v0.6.0: only the mentions of this post. */
  targetId?: string;
  cursor?: string;
}

export type MentionRow = MentionItem & { postHref: string };

export interface MentionsData {
  site: { id: string; name: string };
  /** The filter shown, after the default was applied. */
  filter: MentionFilter;
  query: MentionsQuery;
  rows: MentionRow[];
  page: {
    nextCursor: string | null;
    /** True when q or targetId was applied to this page only, because the site's list does not filter by them. */
    filteredOnPage?: boolean;
  };
  /** Across the whole queue, not the page. */
  counts: MentionCounts;
  /** What a sweep would remove now. */
  expiring: MentionList["expiring"];
  offers: { mentions: boolean; reset: boolean };
  can: Permissions;
}

export function readMentionsQuery(search: URLSearchParams): MentionsQuery {
  const status = search.get("status");
  const cursor = search.get("cursor")?.slice(0, 500);
  const q = search.get("q")?.trim().slice(0, 200);
  const targetId = search.get("targetId")?.trim().slice(0, 300);
  return {
    ...(status && MENTION_FILTERS.includes(status as MentionFilter) ? { status: status as MentionFilter } : {}),
    ...(q ? { q } : {}),
    ...(targetId ? { targetId } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

const NO_COUNTS: MentionCounts = { unverified: 0, pending: 0, approved: 0, rejected: 0, failed: 0 };

/** One page of one site's mention queue, as MentionsList renders it. */
export async function loadMentions(source: ContentSource, query: MentionsQuery = {}): Promise<MentionsData> {
  const capabilities = (await source.client.meta()).capabilities;
  const base = { site: { id: source.site.id, name: source.site.name }, query, can: source.can, offers: { mentions: capabilities.mentions === true, reset: capabilities.mentions === true && capabilities.mentionReset === true } };
  if (capabilities.mentions !== true) {
    return { ...base, filter: query.status ?? "all", rows: [], page: { nextCursor: null }, counts: NO_COUNTS, expiring: { failed: 0, rejected: 0 } };
  }
  const page = (filter: MentionFilter) =>
    source.client.mentions.list({
      limit: PER_PAGE,
      ...(filter === "all" ? {} : { status: filter }),
      ...(query.q ? { q: query.q } : {}),
      ...(query.targetId ? { targetId: query.targetId } : {}),
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
  let filter: MentionFilter = query.status ?? "pending";
  let list = await page(filter);
  if (!query.status && list.items.length === 0 && list.counts.pending === 0) {
    filter = "all";
    list = await page("all");
  }
  // A site that filtered echoes it (v0.6.0); otherwise the kit filters the page it has and says that.
  let items = list.items;
  const filteredOnPage = (query.q !== undefined || query.targetId !== undefined) && list.filtered === undefined;
  if (filteredOnPage) {
    const needle = query.q?.toLowerCase();
    items = items.filter(
      (m) =>
        (!query.targetId || m.targetId === query.targetId) &&
        (!needle || [m.sourceUrl, m.authorName ?? "", m.excerpt ?? ""].some((t) => t.toLowerCase().includes(needle))),
    );
  }
  return {
    ...base,
    filter,
    rows: items.map((m) => ({ ...m, postHref: source.editorHref(m.targetId) })),
    page: { nextCursor: list.nextCursor, ...(filteredOnPage ? { filteredOnPage } : {}) },
    counts: list.counts,
    expiring: list.expiring,
  };
}

const MENTION_INTENTS = ["approve", "reject", "reset", "delete", "sweep"] as const;
export type MentionIntent = (typeof MENTION_INTENTS)[number];

/** Said when the write moved but the site could not clear its cache. */
const PURGE_FAILED = " The site could not clear its cache, so the post's page may show the old mentions until its cache expires.";

/**
 * Approves, rejects, resets (v0.6.0) or deletes each mention, in order, each with its own change id and record, or
 * sweeps the queue. Each write carries the version the person saw, so a mention the site changed since
 * is refused as stale and stays.
 */
export async function runMentionsIntent(source: ContentSource, input: IntentInput): Promise<IntentResult> {
  const intent = text(input, "intent") as MentionIntent;
  if (!MENTION_INTENTS.includes(intent)) return refused("That is not something the mentions list can do.");
  if (!source.can.decideMentions) return refused(NOT_YOURS.decideMentions);
  const capabilities = (await source.client.meta()).capabilities;
  if (capabilities.mentions !== true) return refused("This site does not receive webmentions through the site API.");
  const canReset = capabilities.mentionReset === true;
  if (intent === "reset" && !canReset) return refused("This site does not take a mention decision back.");

  if (intent === "sweep") {
    // The sweep removes the only copy of what each sender sent, so it asks first, with what it would remove.
    if (text(input, "confirm") !== "sweep") {
      const { expiring } = await source.client.mentions.list({ limit: 1 });
      const n = expiring.failed + expiring.rejected;
      const title = `Remove ${n} expired mention${n === 1 ? "" : "s"}?`;
      return {
        ok: false,
        message: title,
        confirm: {
          intent: "sweep",
          title,
          lead: "The site removes these permanently. Nothing else has a copy of them.",
          action: `Remove ${n}`,
          items: [`${expiring.failed} failed`, `${expiring.rejected} rejected`],
          fields: { confirm: "sweep" },
        },
      };
    }
    const change = changeId();
    try {
      const { removed } = await source.client.mentions.sweep({ changeId: change });
      const note = await recordDone(source, "mention-sweep", "sweep", change);
      const n = removed.failed + removed.rejected;
      return { ok: true, message: `Removed ${removed.failed} failed and ${removed.rejected} rejected mention${n === 1 ? "" : "s"} past their retention window.` + note };
    } catch (error) {
      return refused(failure(source, "sweep", error, "mention").message);
    }
  }

  const { seen, names } = await withSeen(source, input, intent === "delete" && text(input, "confirm") === "");
  input = seen;
  const { targets, invalid } = targetsOf(input, MentionId);
  const tooMany = checkCount(targets.length + invalid.length, "mention");
  if (tooMany) return tooMany;
  const early: Outcome[] = invalid.map((id) => ({ id, ok: false, message: "That is not a mention id, so it was not sent to the site." }));
  for (const t of targets) {
    if (t.version === null) early.push({ id: t.id, ok: false, message: "The page did not say which version of this mention you saw, so nothing was sent. Reload and try again." });
  }
  const sendable = targets.filter((t): t is { id: string; version: string; status: string | null } => t.version !== null);

  // A delete removes the only copy of what each sender sent, so it asks first, with the count to type.
  if (intent === "delete" && sendable.length > 0) {
    const ask = askFirst(input, {
      intent: "delete",
      title: `Delete ${sendable.length} mention${sendable.length === 1 ? "" : "s"} permanently?`,
      lead: `Each mention below is removed from ${source.site.name}. This removes the only copy of what the sender sent; nothing else has one. Reject it instead if you may want it back.`,
      action: `Delete ${sendable.length}`,
      items: sendable.map((t) => names.get(t.id) ?? `Mention ${t.id}`),
      fields: { ids: sendable.map((t) => t.id), versions: sendable.map((t) => t.version), statuses: sendable.map((t) => t.status ?? "") },
    });
    if (ask) return ask;
  }

  // Each done mention's inverse: the opposite decision between approved and rejected, a reset (v0.6.0)
  // for a decision on a waiting mention, and the decision that was taken back for a reset.
  const inverses: Array<{ id: string; version: string; intent: MentionIntent; status: MentionStatus }> = [];
  let noUndo = 0;
  const { outcomes, conflict } = await eachItem(source, sendable, "mention", async ({ id, version, status }): Promise<Outcome> => {
    const change = changeId();
    if (intent === "delete") {
      const { purged } = await source.client.mentions.delete(id, { expectedVersion: version, changeId: change });
      return { id, ok: true, message: "Deleted." + (purged === false ? PURGE_FAILED : "") + (await recordDone(source, "mention-delete", id, change)) };
    }
    const written = await source.client.mentions.decide(id, { decision: intent as "approve" | "reject" | "reset", expectedVersion: version, changeId: change });
    const parsed = MentionStatus.safeParse(status);
    const was = parsed.success ? parsed.data : null;
    const inverse: MentionIntent | null =
      was === written.status
        ? null
        : was === "approved"
          ? "approve"
          : was === "rejected"
            ? "reject"
            : was === "pending" && canReset
              ? "reset"
              : null;
    if (inverse) inverses.push({ id, version: written.version, intent: inverse, status: written.status });
    else if (was !== written.status) noUndo++;
    const note = await recordDone(source, `mention-${intent}`, id, change);
    return { id, ok: true, message: DECIDED[intent] + (written.purged === false ? PURGE_FAILED : "") + note };
  });

  const all = [...early, ...outcomes];
  const extra: Partial<IntentResult> = conflict ? { conflict } : {};
  let tail = "";
  if (inverses.length > 0 && inverses.every((i) => i.intent === inverses[0]!.intent)) {
    extra.undo = {
      intent: inverses[0]!.intent,
      fields: { ids: inverses.map((i) => i.id), versions: inverses.map((i) => i.version), statuses: inverses.map((i) => i.status) },
    };
  } else if (inverses.length > 0) {
    tail = " The mentions were in different states before, so there is no single Undo; change them one at a time to reverse it.";
  }
  if (intent !== "delete" && noUndo > 0) tail += canReset ? "" : " A decision on a waiting mention has no Undo on this site.";
  return result(all, summarize(all, DONE_MENTIONS[intent], "mention") + tail, extra);
}

/** How many pages of the queue the kit reads for what a form did not post. */
const SEEN_PAGES = 10;

/**
 * The input with what the kit reads for each mention: its version and the status it had. MentionsList's row form posts
 * one `version` and its bulk form none, and neither posts the statuses, which the kit needs to choose each Undo. A
 * version the form names is kept, so a mention changed since is still refused as stale; for the rest the site's own is
 * read. An input that carries statuses (an Undo, or a caller that knows them) is passed on as it came. `names` is each
 * mention as a person reads it, for a confirm.
 */
async function withSeen(source: ContentSource, input: Input, wantNames: boolean): Promise<{ seen: Input; names: Map<string, string> }> {
  const ids = texts(input, "ids");
  const names = new Map<string, string>();
  const known = texts(input, "statuses").length > 0;
  if (ids.length === 0 || (known && !wantNames)) return { seen: input, names };
  const name = (m: MentionItem) => `${m.authorName ?? "An unnamed sender"} on ${m.targetId}`;
  const found = new Map<string, MentionItem>();
  let cursor: string | undefined;
  for (let page = 0; page < SEEN_PAGES && found.size < ids.length; page++) {
    const list = await source.client.mentions.list({ limit: 200, ...(cursor ? { cursor } : {}) });
    for (const m of list.items) if (ids.includes(m.id)) found.set(m.id, m);
    if (!list.nextCursor) break;
    cursor = list.nextCursor;
  }
  for (const [id, m] of found) names.set(id, name(m));
  if (known) return { seen: input, names };
  const posted = texts(input, "versions");
  const single = ids.length === 1 ? text(input, "version") : "";
  const seen: Record<string, string | string[]> = {};
  const keys = input instanceof FormData ? [...new Set(input.keys())] : Object.keys(input);
  for (const key of keys) if (key !== "ids" && key !== "versions" && key !== "statuses" && key !== "version") seen[key] = texts(input, key);
  seen.ids = ids;
  seen.versions = ids.map((id, i) => posted[i] || single || text(input, `version:${id}`) || found.get(id)?.version || "");
  seen.statuses = ids.map((id) => found.get(id)?.status ?? "");
  return { seen, names };
}

const DECIDED: Record<MentionIntent, string> = { approve: "Approved.", reject: "Rejected.", reset: "Back to waiting.", delete: "Deleted.", sweep: "" };
const DONE_MENTIONS: Record<MentionIntent, string> = { approve: "Approved", reject: "Rejected", reset: "Took back the decision on", delete: "Deleted", sweep: "Swept" };
