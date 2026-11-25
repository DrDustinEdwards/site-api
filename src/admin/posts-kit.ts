// What the posts view data and the posts intents share: the intent list, the outcome words, the inverse of each intent.

import { ContentId, ContentTag, type Capabilities } from "../contract.js";
import { plural } from "@drdustinedwards/site-helpers/text";
import {
  type Permissions,
  type ContentSource,
  type IntentInput,
  type IntentResult,
  askFirst,
  orNull,
  text,
} from "./kit.js";

/** True where the site has the content trash: trash and restore, and delete for good from it. */
export const hasTrash = (capabilities: Capabilities | null) => capabilities?.contentTrash === true;

/** A time as the kit's messages say it: "2030-01-01 15:00 UTC", the same wherever the host runs. */
export function scheduleLabel(publishAt: string): string {
  return `${new Date(publishAt).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export const POST_INTENTS = [
  "tag-add",
  "tag-remove",
  "duplicate",
  "unpublish",
  "republish",
  "delete",
  "reschedule",
  "cancel-schedule",
  "trash",
  "restore",
  "rename",
  "preview-link",
] as const;
export type PostIntent = (typeof POST_INTENTS)[number];

/** A tag as a post's frontmatter list can hold it: one short piece of text with nothing that would break the list. */
export function cleanPostTag(raw: string): string | null {
  const tag = raw.trim();
  return ContentTag.safeParse(tag).success ? tag : null;
}

export const sameTag = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const COPY_TRIES = 50;

export const DONE: Record<PostIntent, string> = {
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

export const LIVE_POST =
  "Changing a live post is a publish, which is not yours to do here, so this one was left as it was.";

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

/** The first of id-copy, id-copy-2, ... that neither the site nor the host already uses. */
export async function freeCopyId(
  source: ContentSource,
  id: string,
): Promise<{ id: string; n: number } | null> {
  for (let n = 1; n <= COPY_TRIES; n++) {
    const candidate = n === 1 ? `${id}-copy` : `${id}-copy-${n}`;
    if (!ContentId.safeParse(candidate).success) return null;
    if (source.taken && (await source.taken(candidate))) continue;
    if ((await orNull(source.client.get(candidate))) === null) return { id: candidate, n };
  }
  return null;
}

/** The Undo an intent leaves, and the sentence for what it cannot undo. */
export function undoOf(o: {
  intent: PostIntent;
  capabilities: Capabilities | null;
  can: Permissions;
  undoIds: string[];
  undoVersions: string[];
  undoTimes: string[];
  tag: string | null;
  renamedFrom: string | undefined;
  notUndoable: number;
}): { undo?: IntentResult["undo"]; tail: string } {
  const { intent, capabilities, undoIds, undoVersions, undoTimes, tag } = o;
  let undo: IntentResult["undo"];
  let tail = "";
  if (undoIds.length > 0) {
    const inverse = undoIntent(intent, capabilities, o.can);
    if (inverse) {
      undo = {
        intent: inverse,
        fields: {
          ids: undoIds,
          versions: undoVersions,
          ...(tag ? { tag } : {}),
          ...(undoTimes.length ? { publishAts: undoTimes } : {}),
          ...(o.renamedFrom ? { newId: o.renamedFrom } : {}),
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
  if (o.notUndoable > 0) {
    tail +=
      intent === "cancel-schedule"
        ? " A canceled schedule has no Undo; schedule it again from the editor."
        : " A post that was only scheduled has no Undo; schedule it again from the editor.";
  }
  return { undo, tail };
}

/** The confirm a delete, or a trash that would break links, asks first; null when nothing needs asking. */
export async function askBeforeRemoving(
  source: ContentSource,
  input: IntentInput,
  intent: PostIntent,
  targets: Array<{ id: string; version: string | null }>,
  capabilities: Capabilities | null,
): Promise<IntentResult | null> {
  if (targets.length === 0 || (intent !== "delete" && intent !== "trash")) return null;
  // Where the site lists backlinks, the posts that link to each one about to go, for the confirm to warn with.
  const backlinks =
    capabilities?.backlinks !== true || text(input, "confirm") !== ""
      ? []
      : (
          await Promise.all(
            targets.map(async (t) => ({
              id: t.id,
              linkedFrom: (await orNull(source.client.backlinks(t.id)))?.items ?? [],
            })),
          )
        ).filter((b) => b.linkedFrom.length > 0);
  const linking = backlinks.reduce((n, b) => n + b.linkedFrom.length, 0);
  const warning =
    linking > 0
      ? ` ${plural(linking, "link")} from other posts will break: the list is below.`
      : "";
  // A trash can be undone, so it asks only when other posts link to one of them.
  if (intent === "trash" && backlinks.length === 0) return null;
  const ask = askFirst(
    input,
    intent === "delete"
      ? {
          intent,
          title: `Delete ${plural(targets.length, "post")} for good?`,
          lead: "Each post leaves the site, and nothing here can bring it back." + warning,
          action: "Delete for good",
          items: targets.map((t) => t.id),
          fields: { ids: targets.map((t) => t.id), versions: targets.map((t) => t.version ?? "") },
        }
      : {
          intent,
          title: `Move ${plural(targets.length, "post")} to the Trash?`,
          lead: `A live post leaves the site.${warning}`,
          action: "Move to the Trash",
          items: targets.map((t) => t.id),
          fields: { ids: targets.map((t) => t.id), versions: targets.map((t) => t.version ?? "") },
        },
  );
  if (!ask) return null;
  return backlinks.length > 0 ? { ...ask, confirm: { ...ask.confirm!, backlinks } } : ask;
}
