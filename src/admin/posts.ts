// The posts half of the content kit: PostsList's view data and its intents.

import { Timestamp } from "../contract/base.js";
import { ContentId, ContentTag, type Capabilities, type ContentDoc } from "../contract.js";
import { plural } from "@drdustinedwards/site-helpers/text";
import {
  type Permissions,
  type ContentSource,
  type IntentInput,
  type Outcome,
  type IntentResult,
  NOT_YOURS,
  text,
  refused,
  askFirst,
  texts,
  targetsOf,
  checkCount,
  summarize,
  result,
  orNull,
  Conflict,
  eachItem,
  actingClient,
} from "./kit.js";
import type { ContentFilter, ContentStatus, SortDir } from "../contract.js";
import type { PostRow, PostSort } from "./posts/data.js";
import { POST_INTENTS, hasTrash, type PostIntent } from "./posts/data.js";
import { applyPostIntent, type PostRun } from "./posts/items.js";

/** A tag as a post's frontmatter list can hold it: one short piece of text with nothing that would break the list. */
function cleanPostTag(raw: string): string | null {
  const tag = raw.trim();
  return ContentTag.safeParse(tag).success ? tag : null;
}

/**
 * Runs one posted intent on one site's posts, each post its own write, in order. The person's
 * permission is checked once before the site is asked anything; a post whose own state needs more
 * (a live post, for someone who may not publish) is refused alone and the rest go on.
 */
export async function runPostsIntent(
  source: ContentSource,
  input: IntentInput,
): Promise<IntentResult> {
  const intent = text(input, "intent") as PostIntent;
  if (!POST_INTENTS.includes(intent))
    return refused("That is not something the posts list can do.");
  const need: keyof Permissions =
    intent === "delete"
      ? "deleteContent"
      : intent === "unpublish" ||
          intent === "republish" ||
          intent === "reschedule" ||
          intent === "cancel-schedule" ||
          // A preview link shows the post to anyone who has it, so it sends the post out: a publish.
          intent === "preview-link"
        ? "publish"
        : "edit";
  if (!source.can[need]) return refused(NOT_YOURS[need]);
  // Rename and a preview link name one post, and a rename one new id for it.
  if ((intent === "rename" || intent === "preview-link") && texts(input, "ids").length !== 1)
    return refused("Choose one post.");
  const newId = intent === "rename" ? text(input, "newId").trim() : "";
  if (intent === "rename" && !ContentId.safeParse(newId).success) {
    return refused(
      "A new id is letters, digits, dots, underscores and hyphens, and starts with a letter or digit.",
    );
  }

  const { targets, invalid } = targetsOf(input, ContentId);
  const tooMany = checkCount(targets.length + invalid.length, "post");
  if (tooMany) return tooMany;
  const early: Outcome[] = invalid.map((id) => ({
    id,
    ok: false,
    message: "That is not a post id, so it was not sent to the site.",
  }));

  let tag: string | null = null;
  if (intent === "tag-add" || intent === "tag-remove") {
    tag = cleanPostTag(text(input, "tag"));
    if (tag === null)
      return refused(
        "A tag is one short piece of text, with no commas, brackets, quotes or colons.",
      );
  }
  // A reschedule names one new time for every post, or (its Undo) one time per post in the order of `ids`.
  const times = texts(input, "publishAts");
  const time = text(input, "publishAt");
  if (
    intent === "reschedule" &&
    !(times.length > 0
      ? times.every((t) => Timestamp.safeParse(t).success)
      : Timestamp.safeParse(time).success)
  ) {
    return refused("Choose the new time, with its time zone.");
  }
  const newTime = (id: string) =>
    (times.length > 0 ? times[texts(input, "ids").indexOf(id)] : time) ?? time;
  const undoTimes: string[] = [];
  let capabilities: Capabilities | null = null;
  if (intent !== "unpublish" && intent !== "republish")
    capabilities = (await source.client.meta()).capabilities;
  if (intent === "delete" && capabilities?.contentDelete !== true)
    return refused("This site does not delete posts through the site API.");
  if ((intent === "trash" || intent === "restore") && !hasTrash(capabilities))
    return refused("This site has no trash for posts.");
  if (intent === "rename" && capabilities?.contentRename !== true)
    return refused("This site does not rename posts through the site API.");
  if (intent === "preview-link" && capabilities?.previewLinks !== true)
    return refused("This site does not make preview links.");
  // v0.22.0: where the site lists backlinks, the posts that link to each one about to go, for the confirm to warn with.
  const linked = async () => {
    if (capabilities?.backlinks !== true || text(input, "confirm") !== "") return [];
    const found = await Promise.all(
      targets.map(async (t) => ({
        id: t.id,
        linkedFrom: (await orNull(source.client.backlinks(t.id)))?.items ?? [],
      })),
    );
    return found.filter((b) => b.linkedFrom.length > 0);
  };
  const warning = (backlinks: Array<{ linkedFrom: unknown[] }>) => {
    const linking = backlinks.reduce((n, b) => n + b.linkedFrom.length, 0);
    return linking > 0
      ? ` ${plural(linking, "link")} from other posts will break: the list is below.`
      : "";
  };
  if (intent === "delete" && targets.length > 0) {
    const backlinks = await linked();
    const ask = askFirst(input, {
      intent,
      title: `Delete ${plural(targets.length, "post")} for good?`,
      lead: "Each post leaves the site, and nothing here can bring it back." + warning(backlinks),
      action: "Delete for good",
      items: targets.map((t) => t.id),
      fields: { ids: targets.map((t) => t.id), versions: targets.map((t) => t.version ?? "") },
    });
    if (ask)
      return backlinks.length > 0 ? { ...ask, confirm: { ...ask.confirm!, backlinks } } : ask;
  }
  // A trash can be undone, so it asks only when other posts link to one of them.
  if (intent === "trash" && targets.length > 0) {
    const backlinks = await linked();
    if (backlinks.length > 0) {
      const ask = askFirst(input, {
        intent,
        title: `Move ${plural(targets.length, "post")} to the Trash?`,
        lead: `A live post leaves the site.${warning(backlinks)}`,
        action: "Move to the Trash",
        items: targets.map((t) => t.id),
        fields: { ids: targets.map((t) => t.id), versions: targets.map((t) => t.version ?? "") },
      });
      if (ask) return { ...ask, confirm: { ...ask.confirm!, backlinks } };
    }
  }

  const client = actingClient(source.client, source.actor);
  const read = async (id: string, version: string | null): Promise<ContentDoc> => {
    const doc = await client.get(id);
    if (version !== null && doc.version !== version) throw new Conflict(doc.version);
    return doc;
  };
  const held = async (id: string): Promise<string | null> =>
    source.hold ? source.hold(intent, id) : null;
  const run: PostRun = {
    intent,
    source,
    input,
    capabilities,
    client,
    read,
    held,
    tag,
    newId,
    newTime,
    undoIds: [],
    undoVersions: [],
    undoTimes,
    renamed: {},
    notUndoable: 0,
    previewLink: undefined,
  };
  const { undoIds, undoVersions, renamed } = run;

  const { outcomes, conflict } = await eachItem(source, targets, "post", (item) =>
    applyPostIntent(run, item),
  );

  const all = [...early, ...outcomes];
  const extra: Partial<IntentResult> = {
    ...(conflict ? { conflict } : {}),
    ...(run.previewLink ? { previewLink: run.previewLink } : {}),
  };
  let tail = "";
  if (undoIds.length > 0) {
    const inverse = undoIntent(intent, capabilities, source.can);
    if (inverse) {
      extra.undo = {
        intent: inverse,
        fields: {
          ids: undoIds,
          versions: undoVersions,
          ...(tag ? { tag } : {}),
          ...(undoTimes.length ? { publishAts: undoTimes } : {}),
          ...(renamed.from ? { newId: renamed.from } : {}),
          ...(inverse === "delete" ? { confirm: String(undoIds.length) } : {}),
        },
      };
    } else if (intent === "duplicate") {
      tail =
        capabilities?.contentDelete === true
          ? " Deleting a post is the Owner's step, so ask the Owner to remove a copy you do not want."
          : " This site does not delete posts through the site API, so remove a copy you do not want in the site's own admin.";
    }
  }
  if (run.notUndoable > 0) {
    tail +=
      intent === "cancel-schedule"
        ? " A canceled schedule has no Undo; schedule it again from the editor."
        : " A post that was only scheduled has no Undo; schedule it again from the editor.";
  }
  return result(all, summarize(all, DONE[intent], "post") + tail, extra);
}

const DONE: Record<PostIntent, string> = {
  "tag-add": "Tagged",
  "tag-remove": "Untagged",
  duplicate: "Copied",
  unpublish: "Unpublished",
  republish: "Republished",
  delete: "Deleted",
  reschedule: "Rescheduled",
  "cancel-schedule": "Canceled the schedule of",
  trash: "Moved to the Trash",
  restore: "Restored",
  rename: "Renamed",
  "preview-link": "Made a preview link for",
};

/** The inverse of a posts intent, or null when it has none here. */
function undoIntent(
  intent: PostIntent,
  capabilities: Capabilities | null,
  can: Permissions,
): string | null {
  switch (intent) {
    case "tag-add":
      return "tag-remove";
    case "tag-remove":
      return "tag-add";
    case "unpublish":
      return "republish";
    case "republish":
      return "unpublish";
    case "duplicate":
      // Undo trashes the copy where the site has a trash; else deletes it, at the version the duplicate made, where the site deletes and the person may.
      if (hasTrash(capabilities)) return "trash";
      return capabilities?.contentDelete === true && can.deleteContent ? "delete" : null;
    case "trash":
      return "restore";
    case "restore":
      return "trash";
    case "rename":
      // Back to the old id; the redirect the first rename left stays, which is harmless.
      return "rename";
    case "reschedule":
      // Back to the times they had, one per post.
      return "reschedule";
    case "delete":
    case "cancel-schedule":
    case "preview-link":
      return null;
  }
}

export { liveSaveWarning, loadPosts, loadScheduledUpdate, readPostQuery } from "./posts/data.js";

export interface PostQuery {
  q?: string;
  status?: ContentStatus;
  kind?: string;
  tag?: string;
  /** v0.17.0, where the site filters by them: one of the post's authors, and a published range in whole days (YYYY-MM-DD, both included). */
  author?: string;
  from?: string;
  to?: string;
  /** v0.17.0, where the site has a trash: "1" lists only the trash. */
  trashed?: "1";
  sort?: PostSort;
  dir?: SortDir;
  cursor?: string;
}

export interface PostsData {
  site: { id: string; name: string };
  query: PostQuery;
  rows: PostRow[];
  page: {
    nextCursor: string | null;
    total?: number;
    /** True when the rows were sorted on this page only, because the site's list does not sort. */
    sortedOnPage?: boolean;
  };
  counts?: Partial<Record<ContentStatus | "all" | "trash", number>>;
  kinds: string[];
  /**
   * `scheduledUpdates` (v0.10.0): the site keeps an update waiting on a live post, so reschedule and cancel work on it.
   * v0.17.0: `trash`, `rename` and `previewLinks` as the site's capabilities say, the list `filters` it applies, and the
   * `authors` on this page for the Author select.
   */
  offers: {
    delete: boolean;
    schedule: boolean;
    tags: boolean;
    duplicate: boolean;
    scheduledUpdates: boolean;
    trash: boolean;
    rename: boolean;
    previewLinks: boolean;
    /** v0.22.0: the site lists the posts that link to one, so a delete or a trash warns with them first. */
    backlinks: boolean;
    filters: ContentFilter[];
    authors: string[];
  };
  can: Permissions;
}

/** The update waiting on a live post, with what it changes, for the page that shows its source (v0.10.0). */
export interface ScheduledUpdateView {
  id: string;
  title: string;
  publishAt: string;
  /** "2030-01-01 15:00 UTC". */
  when: string;
  scheduledAt: string;
  /** The update's own source, and the live one it replaces, for a side-by-side compare. */
  source: string;
  live: { source: string; version: string; href: string | null };
  /** A unified diff from the live source to the update's. */
  patch: string;
  editorHref: string;
  can: Permissions;
}
