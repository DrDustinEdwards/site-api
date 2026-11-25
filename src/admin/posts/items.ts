import { ContentId } from "../../contract.js";
import { orNull } from "../kit.js";
import type { PostIntent } from "./data.js";
import { SiteApiError } from "../../client.js";
import { type Capabilities, type ContentDoc } from "../../contract.js";
import {
  joinSource,
  readKey,
  setRawKey,
  splitSource,
} from "@drdustinedwards/site-helpers/frontmatter";
import { setTags, tagsOf } from "../../frontmatter.js";
import {
  type ContentSource,
  type IntentInput,
  type Outcome,
  type IntentResult,
  text,
  changeId,
  recordDone,
  actingClient,
} from "../kit.js";
import { hasTrash, liveSaveWarning, sameTag, scheduleLabel } from "./data.js";

/** What one run of a posts intent shares across its posts: the person's input, the site, and what the run records. */
export interface PostRun {
  intent: PostIntent;
  source: ContentSource;
  input: IntentInput;
  capabilities: Capabilities | null;
  client: ReturnType<typeof actingClient>;
  read: (id: string, version: string | null) => Promise<ContentDoc>;
  held: (id: string) => Promise<string | null>;
  tag: string | null;
  newId: string;
  newTime: (id: string) => string;
  undoIds: string[];
  undoVersions: string[];
  undoTimes: string[];
  renamed: { from?: string };
  notUndoable: number;
  previewLink: IntentResult["previewLink"];
}

/** One post's share of an intent: the write, its outcome, and what Undo would need. */
export async function applyPostIntent(
  run: PostRun,
  { id, version }: { id: string; version: string | null },
): Promise<Outcome> {
  const {
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
    undoIds,
    undoVersions,
    undoTimes,
    renamed,
  } = run;
  const hold = await held(id);
  if (hold) return { id, ok: false, message: hold };
  switch (intent) {
    case "tag-add":
    case "tag-remove": {
      const doc = await read(id, version);
      if (doc.status !== "draft" && !source.can.publish)
        return { id, ok: false, message: LIVE_POST };
      // A site that keeps tags (v0.6.0) writes them through its own route; otherwise the frontmatter is rewritten.
      const viaRoute = capabilities?.contentTags === true;
      const parts = splitSource(doc.source);
      if (!viaRoute && parts.front === null)
        return {
          id,
          ok: false,
          message: "This post has no frontmatter, so it has no tags to change.",
        };
      const tags = viaRoute ? (doc.tags ?? []) : tagsOf(parts.front);
      const has = tags.some((t) => sameTag(t, tag!));
      if (intent === "tag-add" && has)
        return { id, ok: true, message: `Already tagged "${tag}". Not changed.` };
      if (intent === "tag-remove" && !has)
        return { id, ok: true, message: `Did not have the tag "${tag}". Not changed.` };
      const next = intent === "tag-add" ? [...tags, tag!] : tags.filter((t) => !sameTag(t, tag!));
      const change = changeId();
      const written = viaRoute
        ? await client.setTags(id, {
            tags: next,
            expectedVersion: doc.version,
            changeId: change,
          })
        : await client.saveDraft(id, {
            source: joinSource({ ...parts, front: setTags(parts.front!, next) }),
            expectedVersion: doc.version,
            changeId: change,
          });
      undoIds.push(id);
      undoVersions.push(written.version);
      const note = await recordDone(source, `post-${intent}`, id, change);
      const warning = liveSaveWarning(doc);
      return {
        id,
        ok: true,
        message:
          (intent === "tag-add" ? `Added the tag "${tag}".` : `Removed the tag "${tag}".`) +
          note +
          (warning ? ` ${warning}` : ""),
      };
    }
    case "duplicate": {
      const doc = await read(id, version);
      const parts = splitSource(doc.source);
      if (parts.front === null)
        return {
          id,
          ok: false,
          message: "This post has no frontmatter, so it cannot be copied as a draft.",
        };
      const copy = await freeCopyId(source, id);
      if (!copy)
        return {
          id,
          ok: false,
          message: "No unused id was found for the copy. Rename an earlier copy and try again.",
        };
      let front = setRawKey(
        parts.front,
        "title",
        JSON.stringify(
          `${readKey(parts.front, "title") || id} (copy${copy.n > 1 ? ` ${copy.n}` : ""})`,
        ),
      );
      // The site's own copy of the id sits in the file as well; a copy that kept the old one would clash with the original.
      if (/^slug:/m.test(front)) front = setRawKey(front, "slug", copy.id);
      front = setRawKey(front, "draft", "true");
      const change = changeId();
      let written;
      try {
        written = await client.saveDraft(copy.id, {
          source: joinSource({ ...parts, front }),
          expectedVersion: null,
          changeId: change,
        });
      } catch (error) {
        if (error instanceof SiteApiError && error.body?.error === "version-conflict") {
          return {
            id,
            ok: false,
            message: "The id chosen for the copy was taken while this ran. Nothing was copied.",
          };
        }
        throw error;
      }
      undoIds.push(copy.id);
      undoVersions.push(written.version);
      const note = await recordDone(source, "post-duplicate", copy.id, change);
      return {
        id,
        ok: true,
        message: `Copied as a draft with the id "${copy.id}".` + note,
        copyId: copy.id,
      };
    }
    case "unpublish": {
      const doc = await read(id, version);
      if (doc.status === "draft")
        return { id, ok: true, message: "Not published, so there was nothing to unpublish." };
      const change = changeId();
      const written = await client.unpublish(id, {
        expectedVersion: doc.version,
        changeId: change,
      });
      // Undo republishes, so only a post that has been public before gets one: never a first publication.
      if (doc.status === "published" && doc.publishedAt !== null) {
        undoIds.push(id);
        undoVersions.push(written.version);
      } else run.notUndoable++;
      const note = await recordDone(source, "post-unpublish", id, change);
      return {
        id,
        ok: true,
        message:
          (doc.status === "scheduled"
            ? "Unscheduled; it is a draft again."
            : "Unpublished; it is a draft again.") + note,
      };
    }
    case "republish": {
      const doc = await read(id, version);
      if (doc.status !== "draft") return { id, ok: true, message: "Already live. Not changed." };
      if (doc.publishedAt === null) {
        return {
          id,
          ok: false,
          message:
            "This post has never been published, so it was not published here. A first publication is made from the editor.",
        };
      }
      const change = changeId();
      const written = await client.publish(id, {
        expectedVersion: doc.version,
        changeId: change,
      });
      undoIds.push(id);
      undoVersions.push(written.version);
      const note = await recordDone(source, "post-republish", id, change);
      return { id, ok: true, message: "Published again." + note };
    }
    case "reschedule": {
      const doc = await read(id, version);
      const publishAt = newTime(id)!;
      const change = changeId();
      let before: string;
      let written;
      if (doc.status === "published" && doc.scheduledUpdate) {
        // The update keeps its own source; only its time moves.
        const update = await client.scheduledUpdate(id);
        before = update.publishAt;
        written = await client.schedule(id, {
          expectedVersion: doc.version,
          changeId: change,
          publishAt,
          source: update.source,
        });
      } else if (doc.status === "scheduled" && doc.publishAt) {
        before = doc.publishAt;
        written = await client.schedule(id, {
          expectedVersion: doc.version,
          changeId: change,
          publishAt,
        });
      } else
        return {
          id,
          ok: false,
          message: "Nothing is scheduled for this post. Schedule it from the editor.",
        };
      undoIds.push(id);
      undoVersions.push(written.version);
      undoTimes.push(before);
      const note = await recordDone(source, "post-reschedule", id, change);
      return { id, ok: true, message: `Rescheduled for ${scheduleLabel(publishAt)}.` + note };
    }
    case "cancel-schedule": {
      const doc = await read(id, version);
      const change = changeId();
      let message: string;
      if (doc.status === "published" && doc.scheduledUpdate) {
        await client.cancelSchedule(id, { expectedVersion: doc.version, changeId: change });
        message = "Canceled the scheduled update; the live post stays as it is.";
      } else if (doc.status === "scheduled") {
        // A site with no scheduled updates cancels a scheduled post by returning it to draft, as unpublish does.
        if (capabilities?.scheduledUpdates === true)
          await client.cancelSchedule(id, { expectedVersion: doc.version, changeId: change });
        else await client.unpublish(id, { expectedVersion: doc.version, changeId: change });
        message = "Unscheduled; it is a draft again.";
      } else return { id, ok: true, message: "Nothing was scheduled. Not changed." };
      run.notUndoable++;
      const note = await recordDone(source, "post-cancel-schedule", id, change);
      return { id, ok: true, message: message + note };
    }
    case "delete": {
      const doc = await read(id, version);
      // Where the site has a trash, only a post already in it is deleted for good.
      if (hasTrash(capabilities) && !doc.trashedAt)
        return {
          id,
          ok: false,
          message: "Move this post to the Trash first; it is deleted for good from there.",
        };
      const change = changeId();
      await client.delete(id, { expectedVersion: doc.version, changeId: change });
      const note = await recordDone(source, "post-delete", id, change);
      return { id, ok: true, message: "Deleted from the site." + note };
    }
    case "trash": {
      const doc = await read(id, version);
      if (doc.trashedAt) return { id, ok: true, message: "Already in the Trash. Not changed." };
      if (doc.status !== "draft" && !source.can.publish)
        return { id, ok: false, message: LIVE_POST };
      const change = changeId();
      const written = await client.trash(id, {
        expectedVersion: doc.version,
        changeId: change,
      });
      undoIds.push(id);
      undoVersions.push(written.version);
      const note = await recordDone(source, "post-trash", id, change);
      return {
        id,
        ok: true,
        message:
          (doc.status === "draft"
            ? "Moved to the Trash."
            : "Taken off the site and moved to the Trash.") + note,
      };
    }
    case "restore": {
      const doc = await read(id, version);
      if (!doc.trashedAt) return { id, ok: true, message: "Not in the Trash. Not changed." };
      const change = changeId();
      const written = await client.restore(id, {
        expectedVersion: doc.version,
        changeId: change,
      });
      undoIds.push(id);
      undoVersions.push(written.version);
      const note = await recordDone(source, "post-restore", id, change);
      return { id, ok: true, message: "Restored as a draft." + note };
    }
    case "rename": {
      const doc = await read(id, version);
      if (doc.status !== "draft" && !source.can.publish)
        return {
          id,
          ok: false,
          message:
            "Renaming a live post changes its public address, which is a publish, so it was left as it was.",
        };
      if (newId === id) return { id, ok: true, message: "That is its id already. Not changed." };
      const change = changeId();
      const written = await client.rename(id, {
        newId,
        expectedVersion: doc.version,
        changeId: change,
      });
      undoIds.push(newId);
      undoVersions.push(written.version);
      renamed.from = id;
      const note = await recordDone(source, "post-rename", newId, change);
      const moved = written.previousPath
        ? ` Its old address ${written.previousPath} now redirects to the new one.`
        : "";
      return { id, ok: true, message: `Renamed to "${newId}".` + moved + note };
    }
    case "preview-link": {
      await read(id, version);
      // v0.22.0: how long it lives, where the form says and the site takes it; else the site's 48 hours.
      const hours = Number(text(input, "expiresInHours"));
      const max = capabilities?.previewLinkHours?.max;
      const expiresInHours =
        max && Number.isInteger(hours) && hours >= 1 && hours <= max ? hours : undefined;
      const change = changeId();
      const link = await client.previewLinks.create({
        id,
        changeId: change,
        ...(expiresInHours ? { expiresInHours } : {}),
      });
      run.previewLink = { url: link.url, expiresAt: link.expiresAt };
      const note = await recordDone(source, "post-preview-link", id, change);
      return {
        id,
        ok: true,
        message: `Made a preview link that works until ${scheduleLabel(link.expiresAt)}.` + note,
      };
    }
  }
}

const COPY_TRIES = 50;

const LIVE_POST =
  "Changing a live post is a publish, which is not yours to do here, so this one was left as it was.";

/** The first of id-copy, id-copy-2, ... that neither the site nor the host already uses. */
async function freeCopyId(
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
