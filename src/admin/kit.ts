// What the host supplies, what an intent returns, and the plumbing the posts, media and mentions halves share.

import { SiteApiError, type SiteClient } from "../client.js";
import { Version, type ContentList, type ListQuery, type MediaUse } from "../contract.js";

// ---------- what the host supplies

/** What this person may do on this site. The kit refuses an intent the person may not run, whatever the form says. */
export interface Permissions {
  /** Tag, duplicate, upload, edit alt text and tags, trash and restore. */
  edit: boolean;
  /** Change what the public sees: unpublish, republish, reschedule, cancel a schedule, and any write to a post that is not a draft. */
  publish: boolean;
  deleteContent: boolean;
  deleteMedia: boolean;
  decideMentions: boolean;
}

/** A host-supplied fact about one row, such as "2 AI drafts waiting" or "New draft". */
export interface RowNote {
  text: string;
  tone?: "info" | "warning";
}

export interface ContentSource {
  site: { id: string; name: string; origin: string };
  /** createSiteClient({ baseUrl, key }) in Carrel; localClient(adapter) in a site's own admin. */
  client: SiteClient;
  can: Permissions;
  /** Where a row's title links: Carrel's editor, or the site's own. */
  editorHref(id: string): string;
  /** Optional (v0.10.0): where a row's scheduled update is shown, its source beside the live one. Defaults to the editor. */
  scheduleHref?(id: string): string;
  /** Optional: a faster list than the site's own, such as Carrel's search index. Same answer as client.list. */
  postIndex?: { list(query: Partial<ListQuery> & { limit: number }): Promise<ContentList> };
  /** Optional: notes per post id, for the rows on this page. */
  notes?(ids: string[]): Promise<Record<string, RowNote[]>>;
  /** Optional: how many posts the host has something waiting on (Carrel's AI drafts), for summary(). */
  waiting?(): Promise<number>;
  /** Optional: a host reason to leave one post alone, such as Carrel's unsaved working draft of it. null lets it go on. */
  hold?(intent: string, id: string): Promise<string | null>;
  /** Optional: true for an id the host already uses that the site does not know yet, so a copy never takes it. */
  taken?(id: string): Promise<boolean>;
  /** Optional: records who did what. Called once per item the site carried out, with the change id sent for it. */
  record?(change: { kind: string; ids: string[]; changeId: string }): Promise<void>;
  /** Where unexpected failures are logged. Defaults to console.error. */
  log?(entry: Record<string, unknown>): void;
}

// ---------- what an intent returns

/** The fields a form posts. A list (ids, versions) is an array; one value is a string. An upload's file is a Blob. */
export type Fields = Record<string, string | string[]>;
export type IntentInput = FormData | Record<string, string | string[] | Blob>;

export interface Outcome {
  id: string;
  ok: boolean;
  message: string;
  usedBy?: MediaUse[];
  /** The new copy's id, after a duplicate. */
  copyId?: string;
  /** True when an upload or import matched a file already stored, which is `id` (v0.13.0); nothing new was stored. */
  duplicate?: boolean;
  /** The version this item's write made, so the screen's next write to it (another field of the same file) sends it. */
  version?: string;
}

export interface IntentResult {
  ok: boolean;
  /** One sentence for the message region. */
  message: string;
  outcomes?: Outcome[];
  /** The inverse, as the fields to post with it, versions included. Absent when the action cannot be undone. */
  undo?: { intent: string; fields: Fields };
  /** Set when one item changed on the site since the person saw it. */
  conflict?: { id: string; currentVersion: string | null };
  /** Set instead of acting, for a step nothing can undo: what to ask, and the fields to post again with `confirm`. */
  confirm?: ConfirmRequest;
  /** Set by the posts list's `preview-link` (v0.15.0): the link to show once, and when it stops working. */
  previewLink?: { url: string; expiresAt: string };
}

/** What a one-way intent asks before it runs (Capsomer's confirm dialog with script, its confirm page without). */
export interface ConfirmRequest {
  intent: string;
  title: string;
  lead?: string;
  /** The button that does it. */
  action: string;
  /** Typed into the dialog and posted back as `confirm`: the number of items, so the count is read. */
  typeToConfirm?: string;
  /** Every item it will change, one line each. Never shortened. */
  items: string[];
  fields: Fields;
}

/** The most items one intent acts on, as the site's own bulk route allows. */
const MAX_INTENT_ITEMS = 100;
export const PER_PAGE = 50;

// ---------- shared plumbing

export function fieldOf(input: IntentInput, name: string): Array<string | Blob> {
  if (input instanceof FormData) return input.getAll(name) as Array<string | Blob>;
  const value = input[name];
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

export function texts(input: IntentInput, name: string): string[] {
  return fieldOf(input, name).filter((v): v is string => typeof v === "string");
}

export function text(input: IntentInput, name: string): string {
  return texts(input, name)[0] ?? "";
}

/**
 * Asks before a step nothing can undo, unless the form already carries the answer: `confirm` equal to
 * the number of items, which the person typed. null means go on.
 */
export function askFirst(input: IntentInput, ask: Omit<ConfirmRequest, "typeToConfirm">): IntentResult | null {
  const count = String(ask.items.length);
  if (text(input, "confirm").trim() === count) return null;
  return { ok: false, message: ask.title, confirm: { ...ask, typeToConfirm: count } };
}

export function refused(message: string): IntentResult {
  return { ok: false, message };
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function changeId(): string {
  return crypto.randomUUID();
}

function logOf(source: ContentSource) {
  return (entry: Record<string, unknown>) => (source.log ? source.log(entry) : console.error(JSON.stringify(entry)));
}

/** Records one done item. A record that cannot be written is said in the outcome, never hidden. */
export async function recordDone(source: ContentSource, kind: string, id: string, change: string): Promise<string> {
  if (!source.record) return "";
  try {
    await source.record({ kind, ids: [id], changeId: change });
    return "";
  } catch (error) {
    logOf(source)({ contentKit: "record-failed", kind, id, changeId: change, error: String(error) });
    return " The record of it could not be saved.";
  }
}

/**
 * The ids and their versions, as the form sent them: `ids` and, when the person saw them, `versions`
 * in the same order, or each one's own `version:<id>` field (a form with no script cannot line a list
 * of versions up with the boxes ticked, so each box's version is posted under its id). Unique, each shaped as the site could hold it; anything else is reported, not sent.
 */
export function targetsOf(
  input: IntentInput,
  shape: { safeParse(v: unknown): { success: boolean } },
): { targets: Array<{ id: string; version: string | null; status: string | null }>; invalid: string[] } {
  const ids = texts(input, "ids");
  const versions = texts(input, "versions");
  const statuses = texts(input, "statuses");
  const targets: Array<{ id: string; version: string | null; status: string | null }> = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  ids.forEach((id, i) => {
    if (seen.has(id)) return;
    seen.add(id);
    const version = versions[i] ?? text(input, `version:${id}`);
    if (!shape.safeParse(id).success || (version !== "" && !Version.safeParse(version).success)) invalid.push(id || "(no id)");
    else targets.push({ id, version: version === "" ? null : version, status: statuses[i] || null });
  });
  return { targets, invalid };
}

export function checkCount(total: number, noun: string): IntentResult | null {
  if (total === 0) return refused(`Choose at least one ${noun}.`);
  if (total > MAX_INTENT_ITEMS) return refused(`At most ${MAX_INTENT_ITEMS} ${noun}s at a time.`);
  return null;
}

/** The message for a whole run: what was done, and how many were left as they were. */
export function summarize(outcomes: Outcome[], done: string, noun: string): string {
  const ok = outcomes.filter((o) => o.ok).length;
  const left = outcomes.length - ok;
  if (left === 0) return `${done} ${plural(ok, noun)}.`;
  if (ok === 0) return `Nothing was changed: ${plural(left, noun)} left as ${left === 1 ? "it was" : "they were"}.`;
  return `${done} ${plural(ok, noun)}; ${left} left as ${left === 1 ? "it was" : "they were"}.`;
}

export function result(outcomes: Outcome[], message: string, extra: Partial<IntentResult> = {}): IntentResult {
  return { ok: outcomes.length > 0 && outcomes.every((o) => o.ok), message, outcomes, ...extra };
}

/** A 404 from the site, as null; anything else is the caller's to handle. */
export async function orNull<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof SiteApiError && (error.status === 404 || error.status === 400)) return null;
    throw error;
  }
}

export class Conflict extends Error {
  constructor(readonly currentVersion: string | null) {
    super("conflict");
  }
}

/** What went wrong for one item, said plainly. Anything unexpected is logged and reported, never dropped. */
export function failure(source: ContentSource, id: string, error: unknown, noun: string): Outcome & { currentVersion?: string | null } {
  if (error instanceof Conflict) {
    return { id, ok: false, message: `This ${noun} changed on the site since the page loaded. It was left as it was.`, currentVersion: error.currentVersion };
  }
  if (error instanceof SiteApiError) {
    if (error.body?.error === "version-conflict") {
      return { id, ok: false, message: `This ${noun} changed on the site since the page loaded. It was left as it was.`, currentVersion: error.body.currentVersion ?? null };
    }
    if (error.status === 404) return { id, ok: false, message: `The site does not have this ${noun}. It may have been deleted.` };
    if (error.status === 501) return { id, ok: false, message: "This site does not offer that." };
    if (error.body?.error === "refused") return { id, ok: false, message: error.body.message, ...(error.body.usedBy ? { usedBy: error.body.usedBy } : {}) };
  }
  logOf(source)({ contentKit: "item-failed", id, error: error instanceof SiteApiError ? `site ${error.status} ${error.body?.error ?? ""}` : String(error) });
  return { id, ok: false, message: `The site did not accept this change. The ${noun} was left as it was.` };
}

/** Runs each item in order. One failing never stops the rest; the first conflict is named on the result. */
export async function eachItem<T extends { id: string }>(
  source: ContentSource,
  items: T[],
  noun: string,
  run: (item: T) => Promise<Outcome>,
): Promise<{ outcomes: Outcome[]; conflict?: { id: string; currentVersion: string | null } }> {
  const outcomes: Outcome[] = [];
  let conflict: { id: string; currentVersion: string | null } | undefined;
  for (const item of items) {
    try {
      outcomes.push(await run(item));
    } catch (error) {
      const { currentVersion, ...outcome } = failure(source, item.id, error, noun);
      if (currentVersion !== undefined && !conflict) conflict = { id: item.id, currentVersion };
      outcomes.push(outcome);
    }
  }
  return { outcomes, ...(conflict ? { conflict } : {}) };
}

export function absolute(origin: string, url: string): string {
  return url.startsWith("/") ? `${origin.replace(/\/+$/, "")}${url}` : url;
}

export const NOT_YOURS: Record<keyof Permissions, string> = {
  edit: "You may not change posts on this site.",
  publish: "Changing what the public sees is not yours to do on this site.",
  deleteContent: "Deleting a post is the Owner's step.",
  deleteMedia: "Deleting a file for good is the Owner's step.",
  decideMentions: "Deciding mentions is not yours to do on this site.",
};
