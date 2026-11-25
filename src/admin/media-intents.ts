// Runs one posted media intent: the checks every intent shares, the bulk path, and the outcome words.

import { plural } from "@drdustinedwards/site-helpers/text";

import { MediaId, type MediaDetail } from "../contract.js";
import {
  type Permissions,
  type ContentSource,
  type IntentInput,
  type Outcome,
  type IntentResult,
  NOT_YOURS,
  texts,
  text,
  refused,
  askFirst,
  changeId,
  recordDone,
  targetsOf,
  checkCount,
  parseMediaTags,
  summarize,
  result,
  Conflict,
  eachItem,
} from "./kit.js";
import { mediaOffers } from "./media.js";
import { decorativeOf, importOne, suggestFor, uploadOne } from "./media-import.js";
import {
  emptyTrash,
  focusField,
  replaceFile,
  resizeFiles,
  revertFile,
  setAlt,
  setCaption,
  setCredit,
  setFileTags,
  setFocus,
  transformFile,
} from "./media-files.js";

const MEDIA_INTENTS = [
  "upload",
  "alt",
  "tags",
  "tag-add",
  "tag-remove",
  "trash",
  "restore",
  "delete",
  "empty-trash",
  "focus",
  "caption",
  "replace",
  "import",
  "credit",
  "transform",
  "revert",
  "resize",
  "suggest",
] as const;
type MediaIntent = (typeof MEDIA_INTENTS)[number];

/**
 * Runs one posted intent on one site's media library. Bulk intents go to the site as one bulk
 * request; the site answers file by file, and every file gets an outcome.
 */
export async function runMediaIntent(
  source: ContentSource,
  input: IntentInput,
): Promise<IntentResult> {
  const intent = text(input, "intent") as MediaIntent;
  if (!MEDIA_INTENTS.includes(intent))
    return refused("That is not something the media library can do.");
  // A replace changes every live page that uses the file and the old bytes are gone, so it is the Owner's, like a delete.
  // A transform, a revert and a resize change every live page that uses the file too (v0.13.0), so they are the Owner's.
  const bytes =
    intent === "replace" || intent === "transform" || intent === "revert" || intent === "resize";
  const need: keyof Permissions =
    intent === "delete" || intent === "empty-trash" || bytes ? "deleteMedia" : "edit";
  if (!source.can[need])
    return refused(
      intent === "replace"
        ? "Replacing a file is the Owner's step."
        : bytes
          ? "Changing a file's picture is the Owner's step."
          : NOT_YOURS[need],
    );
  const offers = mediaOffers((await source.client.meta()).capabilities);
  if (!offers.media) return refused("This site has no media library.");
  const lacking =
    (intent === "alt" && !offers.alt) ||
    ((intent === "tags" || intent === "tag-add" || intent === "tag-remove") && !offers.tags) ||
    ((intent === "trash" || intent === "restore" || intent === "empty-trash") && !offers.trash) ||
    (intent === "focus" && !offers.focus) ||
    (intent === "caption" && !offers.caption) ||
    (intent === "replace" && !offers.replace) ||
    (intent === "import" && !offers.import) ||
    (intent === "credit" && !offers.credit) ||
    (intent === "transform" && !offers.transform) ||
    (intent === "revert" && !offers.history) ||
    (intent === "resize" && !offers.resizePass) ||
    (intent === "suggest" && !offers.uploadSuggestions);
  if (lacking) return refused("This site does not offer that.");

  if (intent === "upload") return uploadOne(source, input, offers.upload!);
  if (intent === "suggest") return suggestFor(source, input);
  if (intent === "import") return importOne(source, input);
  if (intent === "empty-trash") {
    const trash = await source.client.media.list({ trashed: "only", limit: 200 });
    if (trash.items.length === 0)
      return { ok: true, message: "The trash was already empty.", outcomes: [] };
    const ask = askFirst(input, {
      intent,
      title: `Delete ${plural(trash.items.length, "file")} in the trash for good?`,
      lead:
        "Each file leaves the site's storage, and nothing can bring it back. A file a page still uses stays in the trash." +
        (trash.nextCursor ? " The trash holds more than these; empty it again for the rest." : ""),
      action: "Empty the trash",
      items: trash.items.map((i) => i.filename ?? i.id),
      fields: {},
    });
    return ask ?? emptyTrash(source);
  }

  const { targets, invalid } = targetsOf(input, MediaId);
  const tooMany = checkCount(targets.length + invalid.length, "file");
  if (tooMany) return tooMany;
  const early: Outcome[] = invalid.map((id) => ({
    id,
    ok: false,
    message: "That is not a file id, so it was not sent to the site.",
  }));
  // A write needs the version the person saw; without one the site could not tell a stale write from a fresh one.
  const sendable = targets.filter((t) => intent === "delete" || t.version !== null);
  for (const t of targets) {
    if (!sendable.includes(t))
      early.push({
        id: t.id,
        ok: false,
        message:
          "The page did not say which version of this file you saw, so nothing was sent. Reload and try again.",
      });
  }

  if (
    intent === "alt" ||
    intent === "tags" ||
    intent === "focus" ||
    intent === "caption" ||
    intent === "replace" ||
    intent === "credit" ||
    intent === "transform" ||
    intent === "revert"
  ) {
    if (sendable.length !== 1 || targets.length !== 1) return result(early, "Choose one file.");
    const file = { id: sendable[0]!.id, version: sendable[0]!.version! };
    // The words on a file a page uses show on that page, so changing them there is a publish (Carrel's publishing review,
    // finding 7): someone who may not publish changes them only on a file nothing uses yet.
    if (
      (intent === "alt" || intent === "caption" || intent === "credit") &&
      !source.can.publish &&
      (await source.client.media.get(file.id)).usedBy.length > 0
    )
      return refused(
        "A page uses this file, so changing its words changes that page, which is not yours to do here.",
      );
    if (intent === "alt") return setAlt(source, file, text(input, "alt"), decorativeOf(input));
    if (intent === "tags") return setFileTags(source, file, texts(input, "tags"));
    if (intent === "focus") return setFocus(source, file, focusField(input));
    if (intent === "caption") return setCaption(source, file, text(input, "caption"));
    if (intent === "credit") return setCredit(source, input, file);
    if (intent === "transform") return transformFile(source, input, file, offers.history);
    if (intent === "revert") return revertFile(source, file, text(input, "to"));
    return replaceFile(source, input, file, offers.upload!);
  }
  if (intent === "resize") return resizeFiles(source, input, sendable, early);

  let tags: string[] = [];
  if (intent === "tag-add" || intent === "tag-remove") {
    const parsed = parseMediaTags(texts(input, "tags"));
    if (!parsed.ok) return refused(parsed.message);
    if (parsed.tags.length === 0) return refused("Name at least one tag.");
    tags = parsed.tags;
  }

  // Each file is read first where the kit needs what the site holds: which tags would really change
  // (so Undo touches only those), and, on a site with a trash, that a delete is from the trash.
  const before = new Map<string, MediaDetail>();
  const plan: Array<{ id: string; version: string | null }> = [];
  const { outcomes: checks, conflict: staleRead } = await eachItem(
    source,
    sendable,
    "file",
    async (t): Promise<Outcome> => {
      if (
        intent === "tag-add" ||
        intent === "tag-remove" ||
        (intent === "delete" && offers.trash)
      ) {
        const detail = await source.client.media.get(t.id);
        if (t.version !== null && detail.version !== t.version)
          throw new Conflict(detail.version ?? null);
        before.set(t.id, detail);
        if (intent === "delete" && !detail.trashedAt) {
          return {
            id: t.id,
            ok: false,
            message:
              "Move this file to the trash first: files are deleted for good only from the trash.",
          };
        }
        if (intent === "tag-add" || intent === "tag-remove") {
          const held = detail.tags ?? [];
          const changes =
            intent === "tag-add"
              ? tags.some((g) => !held.includes(g))
              : tags.some((g) => held.includes(g));
          if (!changes)
            return {
              id: t.id,
              ok: true,
              message:
                intent === "tag-add"
                  ? "Already had those tags. Not changed."
                  : "Had none of those tags. Not changed.",
            };
        }
      }
      plan.push(t);
      return { id: t.id, ok: true, message: "" };
    },
  );
  const settled = checks.filter((c) => !c.ok || c.message !== "");
  const all: Outcome[] = [...early, ...settled];
  if (plan.length === 0)
    return result(
      all,
      summarize(all, MEDIA_DONE[intent], "file"),
      staleRead ? { conflict: staleRead } : {},
    );

  if (intent === "delete") {
    // Asked once the kit knows which files would really go: none still in the library, none refused above.
    const ids = plan.map((p) => p.id);
    const ask = askFirst(input, {
      intent,
      title: `Delete ${plural(ids.length, "file")} for good?`,
      lead: "Each file leaves the site's storage, and nothing can bring it back. A file a page still uses is kept.",
      action: "Delete for good",
      items: ids,
      fields: { ids },
    });
    if (ask) return ask;
  }

  const op = intent === "tag-add" ? "add-tags" : intent === "tag-remove" ? "remove-tags" : intent;
  const sent = plan.map((p) => ({ ...p, changeId: changeId() }));
  const answer = await source.client.media.bulk({
    op,
    ...(tags.length > 0 ? { tags } : {}),
    items: sent.map((s) => ({
      id: s.id,
      changeId: s.changeId,
      ...(op !== "delete" && s.version ? { expectedVersion: s.version } : {}),
    })),
  });
  const undoIds: string[] = [];
  const undoVersions: string[] = [];
  const undoTags = new Set<string>();
  let conflict: IntentResult["conflict"] = staleRead;
  for (const outcome of answer.results) {
    if (outcome.ok) {
      const note = await recordDone(source, `media-${intent}`, outcome.id, outcome.changeId);
      all.push({ id: outcome.id, ok: true, message: MEDIA_DONE_ONE[intent] + note });
      if (outcome.version) {
        undoIds.push(outcome.id);
        undoVersions.push(outcome.version);
        const held = before.get(outcome.id)?.tags ?? [];
        for (const g of tags)
          if (intent === "tag-add" ? !held.includes(g) : held.includes(g))
            undoTags.add(`${outcome.id}\u0000${g}`);
      }
    } else {
      if (outcome.error === "version-conflict" && !conflict)
        conflict = { id: outcome.id, currentVersion: outcome.currentVersion ?? null };
      all.push({
        id: outcome.id,
        ok: false,
        message:
          outcome.error === "version-conflict"
            ? "This file changed on the site since the page loaded. It was left as it was."
            : outcome.message,
        ...(outcome.usedBy && outcome.usedBy.length > 0 ? { usedBy: outcome.usedBy } : {}),
      });
    }
  }
  const extra: Partial<IntentResult> = conflict ? { conflict } : {};
  let tail = "";
  if (undoIds.length > 0 && (intent === "trash" || intent === "restore")) {
    extra.undo = {
      intent: intent === "trash" ? "restore" : "trash",
      fields: { ids: undoIds, versions: undoVersions },
    };
  } else if (undoIds.length > 0 && (intent === "tag-add" || intent === "tag-remove")) {
    // Undo applies the inverse to the files that changed, and only those: one bulk request when every
    // file changed by the same tags, which a single tag always does.
    const changed = undoIds.map((id) =>
      tags.filter((g) => undoTags.has(`${id}\u0000${g}`)).join(","),
    );
    if (changed.every((c) => c === changed[0])) {
      extra.undo = {
        intent: intent === "tag-add" ? "tag-remove" : "tag-add",
        fields: { ids: undoIds, versions: undoVersions, tags: changed[0]!.split(",") },
      };
    } else
      tail =
        " The files changed by different tags, so there is no single Undo; change them one at a time to reverse it.";
  }
  return result(all, summarize(all, MEDIA_DONE[intent], "file") + tail, extra);
}

const MEDIA_DONE: Record<MediaIntent, string> = {
  upload: "Uploaded",
  alt: "Saved alt text on",
  tags: "Saved tags on",
  "tag-add": "Tagged",
  "tag-remove": "Untagged",
  trash: "Moved to the trash",
  restore: "Restored",
  delete: "Deleted",
  "empty-trash": "Deleted",
  focus: "Saved the focal point on",
  caption: "Saved the caption on",
  replace: "Replaced",
  import: "Imported",
  credit: "Saved the credit on",
  transform: "Turned",
  revert: "Reverted",
  resize: "Shrank",
  suggest: "Suggested alt text for",
};

const MEDIA_DONE_ONE: Record<MediaIntent, string> = {
  upload: "Uploaded.",
  alt: "Alt text saved.",
  tags: "Tags saved.",
  "tag-add": "Tags added.",
  "tag-remove": "Tags removed.",
  trash: "Moved to the trash.",
  restore: "Restored to the library.",
  delete: "Deleted from the site.",
  "empty-trash": "Deleted from the site.",
  focus: "Focal point saved.",
  caption: "Caption saved.",
  replace: "Replaced.",
  import: "Imported.",
  credit: "Credit saved.",
  transform: "Turned.",
  revert: "Reverted.",
  resize: "Shrunk.",
  suggest: "Suggested.",
};

/**
 * Uploads one file. The kit checks the site's own limits first, so a file the site would refuse is
 * not sent at all; the site API checks them again, and the bytes, before the site's code.
 */
