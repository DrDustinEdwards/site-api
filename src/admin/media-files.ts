// The media intents that change one file already in the library, and emptying the trash.

import { mediaType } from "@dustinedwards/site-runtime/http";
import { plural } from "@drdustinedwards/site-helpers/text";
import { focusOf } from "@dustinedwards/site-runtime/image";

import { altRefusal } from "../media.js";
import {
  MAX_RESIZE_PASS,
  MediaSourceUrl,
  MediaTransformOp,
  type MediaTransformOp as TransformOp,
  type MediaUploadLimits,
} from "../contract.js";
import {
  type ContentSource,
  type IntentInput,
  type Outcome,
  type IntentResult,
  fieldOf,
  text,
  refused,
  askFirst,
  changeId,
  recordDone,
  summarize,
  result,
  Conflict,
  eachItem,
  megabytes,
  parseMediaTags,
} from "./kit.js";

/** The most rounds one empty-trash intent sends; each round deletes up to the site's limit. */
const EMPTY_ROUNDS = 20;

/** Saves a file's credit, license, source address and license end (v0.13.0), each the whole value after it. */
export async function setCredit(
  source: ContentSource,
  input: IntentInput,
  file: { id: string; version: string },
): Promise<IntentResult> {
  const sourceUrl = text(input, "sourceUrl").trim();
  if (sourceUrl !== "" && !MediaSourceUrl.safeParse(sourceUrl).success)
    return refused("The source is not a web address.");
  const licenseExpires = text(input, "licenseExpires").trim();
  if (licenseExpires !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(licenseExpires))
    return refused("The license end is not a date.");
  const { outcomes, conflict } = await eachItem(source, [file], "file", async ({ id, version }) => {
    const change = changeId();
    const written = await source.client.media.setCredit(id, {
      credit: text(input, "credit").trim().slice(0, 300),
      license: text(input, "license").trim().slice(0, 300),
      sourceUrl: sourceUrl || null,
      licenseExpires: licenseExpires || null,
      expectedVersion: version,
      changeId: change,
    });
    return {
      id,
      ok: true,
      version: written.version,
      message: "Credit saved." + (await recordDone(source, "media-credit", id, change)),
    };
  });
  return result(outcomes, outcomes[0]!.message, conflict ? { conflict } : {});
}

const INVERSE: Record<TransformOp, TransformOp> = {
  "rotate-90": "rotate-270",
  "rotate-180": "rotate-180",
  "rotate-270": "rotate-90",
  "flip-h": "flip-h",
  "flip-v": "flip-v",
};

/**
 * Turns or mirrors one picture (v0.13.0), `op` one of MEDIA_TRANSFORMS. Undo puts the old bytes back where the site keeps
 * history (a revert, so nothing is encoded twice), else turns it back. A quarter turn the site saves as a new file has no
 * Undo: the old file is as it was, and the message says so.
 */
export async function transformFile(
  source: ContentSource,
  input: IntentInput,
  file: { id: string; version: string },
  history: boolean,
): Promise<IntentResult> {
  const op = MediaTransformOp.safeParse(text(input, "op"));
  if (!op.success) return refused("Choose a turn or a mirror.");
  let undo: IntentResult["undo"];
  const { outcomes, conflict } = await eachItem(source, [file], "file", async ({ id, version }) => {
    const before = history
      ? (await source.client.media.history(id)).revisions.find((r) => r.current)?.rev
      : undefined;
    const change = changeId();
    const done = await source.client.media.transform(id, {
      op: op.data,
      expectedVersion: version,
      changeId: change,
    });
    const note = await recordDone(source, "media-transform", done.id, change);
    if (done.asNewFile) {
      return {
        id,
        ok: true,
        copyId: done.id,
        message:
          `Saved the turned picture as a new file, ${done.filename ?? done.id}, since this site's addresses carry the size. The pages that use the old one still show it.` +
          note,
      };
    }
    undo = before
      ? { intent: "revert", fields: { ids: [id], versions: [done.version!], to: before } }
      : {
          intent: "transform",
          fields: { ids: [id], versions: [done.version!], op: INVERSE[op.data] },
        };
    const stale = done.sizesNeedPurge
      ? " The site's cache may still serve sizes of the old picture until they are purged."
      : "";
    return {
      id,
      ok: true,
      ...(done.version ? { version: done.version } : {}),
      message: "Turned. Every page that uses it shows the new picture." + stale + note,
    };
  });
  return result(outcomes, outcomes[0]!.message, {
    ...(conflict ? { conflict } : {}),
    ...(undo ? { undo } : {}),
  });
}

/** Puts a file's earlier bytes back (v0.13.0), `to` a revision from the inspector's history. Undo puts back the bytes it had. */
export async function revertFile(
  source: ContentSource,
  file: { id: string; version: string },
  to: string,
): Promise<IntentResult> {
  if (to.trim() === "") return refused("Choose the version to go back to.");
  let undo: IntentResult["undo"];
  const { outcomes, conflict } = await eachItem(source, [file], "file", async ({ id, version }) => {
    const before = (await source.client.media.history(id)).revisions.find((r) => r.current)?.rev;
    const change = changeId();
    const done = await source.client.media.revert(id, {
      to: to.trim(),
      expectedVersion: version,
      changeId: change,
    });
    if (before && done.version)
      undo = { intent: "revert", fields: { ids: [id], versions: [done.version], to: before } };
    const stale = done.sizesNeedPurge
      ? " The site's cache may still serve sizes of the newer picture until they are purged."
      : "";
    return {
      id,
      ok: true,
      ...(done.version ? { version: done.version } : {}),
      message:
        "Reverted. Every page that uses it shows that version; set its focal point again if it had one." +
        stale +
        (await recordDone(source, "media-revert", id, change)),
    };
  });
  return result(outcomes, outcomes[0]!.message, {
    ...(conflict ? { conflict } : {}),
    ...(undo ? { undo } : {}),
  });
}

/**
 * Shrinks the chosen stored pictures to the site's size (v0.13.0), after asking: each changes every page that uses it. Sent
 * in requests of the site's limit, each file with its own change id; one file's refusal is its own outcome.
 */
export async function resizeFiles(
  source: ContentSource,
  input: IntentInput,
  files: Array<{ id: string; version: string | null }>,
  early: Outcome[],
): Promise<IntentResult> {
  if (files.length === 0) return result(early, summarize(early, "Shrank", "file"));
  const ids = files.map((f) => f.id);
  const ask = askFirst(input, {
    intent: "resize",
    title: `Shrink ${plural(ids.length, "picture")} to this site's size?`,
    lead:
      "Each picture is stored again at the smaller size, and every page that uses it shows the smaller one." +
      " Where the site keeps a file's history, the inspector can put the original back.",
    action: "Shrink",
    items: ids,
    fields: { ids, versions: files.map((f) => f.version!) },
  });
  if (ask) return ask;
  const all: Outcome[] = [...early];
  let conflict: IntentResult["conflict"];
  for (let at = 0; at < files.length; at += MAX_RESIZE_PASS) {
    const sent = files
      .slice(at, at + MAX_RESIZE_PASS)
      .map((f) => ({ id: f.id, expectedVersion: f.version!, changeId: changeId() }));
    const answer = await source.client.media.resizePass({ items: sent });
    for (const outcome of answer.results) {
      if (outcome.ok) {
        const note = outcome.resized
          ? await recordDone(source, "media-resize", outcome.id, outcome.changeId)
          : "";
        all.push({
          id: outcome.id,
          ok: true,
          ...(outcome.version ? { version: outcome.version } : {}),
          message: outcome.resized
            ? `Shrunk to ${outcome.width}x${outcome.height}.` + note
            : "Already within the size. Not changed.",
        });
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
        });
      }
    }
  }
  return result(all, summarize(all, "Shrank", "file"), conflict ? { conflict } : {});
}

export async function setAlt(
  source: ContentSource,
  file: { id: string; version: string },
  alt: string,
  decorative: boolean,
): Promise<IntentResult> {
  const wrong = altRefusal(alt, decorative, null);
  if (wrong) return refused(wrong);
  const { outcomes, conflict } = await eachItem(source, [file], "file", async ({ id, version }) => {
    const change = changeId();
    const written = await source.client.media.setAlt(id, {
      alt: decorative ? "" : alt.trim(),
      ...(decorative ? { decorative: true as const } : {}),
      expectedVersion: version,
      changeId: change,
    });
    return {
      id,
      ok: true,
      version: written.version,
      message: "Alt text saved." + (await recordDone(source, "media-alt", id, change)),
    };
  });
  return result(outcomes, outcomes[0]!.message, conflict ? { conflict } : {});
}

/**
 * The focal point a form posted: `clear=yes` clears it; `x` and `y`, each a percent from the top left, are what a form
 * with no script sends (MediaLibrary's focal point); otherwise `focus` as "XxY". "" clears it.
 */
export function focusField(input: IntentInput): string {
  if (text(input, "clear") === "yes") return "";
  const x = text(input, "x").trim();
  const y = text(input, "y").trim();
  if (x === "" && y === "") return text(input, "focus");
  const part = (v: string) => {
    const n = Number(v);
    return v !== "" && n >= 0 && n <= 100 ? String(Math.round(n * 10) / 1000) : "bad";
  };
  return `${part(x)}x${part(y)}`;
}

/** Sets the point a file's crops are cut around: `focus` is "XxY", each 0 to 1 from the top left, or "" to clear it. */
export async function setFocus(
  source: ContentSource,
  file: { id: string; version: string },
  raw: string,
): Promise<IntentResult> {
  const focus = raw.trim() === "" ? null : focusOf(raw);
  if (raw.trim() !== "" && focus === null) return refused("That is not a point on the picture.");
  const { outcomes, conflict } = await eachItem(source, [file], "file", async ({ id, version }) => {
    const change = changeId();
    const written = await source.client.media.setFocus(id, {
      focus,
      expectedVersion: version,
      changeId: change,
    });
    return {
      id,
      ok: true,
      version: written.version,
      message:
        (focus ? "Focal point saved." : "Focal point cleared.") +
        (await recordDone(source, "media-focus", id, change)),
    };
  });
  return result(outcomes, outcomes[0]!.message, conflict ? { conflict } : {});
}

export async function setCaption(
  source: ContentSource,
  file: { id: string; version: string },
  caption: string,
): Promise<IntentResult> {
  const { outcomes, conflict } = await eachItem(source, [file], "file", async ({ id, version }) => {
    const change = changeId();
    const written = await source.client.media.setCaption(id, {
      caption: caption.trim().slice(0, 2000),
      expectedVersion: version,
      changeId: change,
    });
    return {
      id,
      ok: true,
      version: written.version,
      message: "Caption saved." + (await recordDone(source, "media-caption", id, change)),
    };
  });
  return result(outcomes, outcomes[0]!.message, conflict ? { conflict } : {});
}

/**
 * New bytes for one file under its own id and address, checked against the site's limits first as an upload is. Alt,
 * caption and tags stay; the focal point is cleared. Says so when the site's cache may still serve the old sizes.
 */
export async function replaceFile(
  source: ContentSource,
  input: IntentInput,
  file: { id: string; version: string },
  limits: MediaUploadLimits,
): Promise<IntentResult> {
  const upload = fieldOf(input, "file").find((v): v is Blob => typeof v !== "string");
  if (!upload) return refused("Choose the new file.");
  const name = (upload as Blob & { name?: string }).name || "upload";
  const type = mediaType(upload.type);
  if (!limits.types.includes(type))
    return refused(
      `${name} is ${type || "an unknown type"}; this site accepts ${limits.types.map((t) => t.split("/")[1]).join(", ")}.`,
    );
  if (upload.size > limits.maxBytes)
    return refused(
      `${name} is ${megabytes(upload.size)}; this site accepts files up to ${megabytes(limits.maxBytes)}.`,
    );
  if (upload.size === 0) return refused(`${name} is empty.`);
  const { outcomes, conflict } = await eachItem(source, [file], "file", async ({ id, version }) => {
    const change = changeId();
    const done = await source.client.media.replace(id, {
      bytes: new Uint8Array(await upload.arrayBuffer()),
      contentType: type,
      filename: name.replace(/[/\\]/g, "-").slice(0, 200),
      expectedVersion: version,
      changeId: change,
    });
    const stale = done.sizesNeedPurge
      ? " The site's cache may still serve sizes of the old picture until they are purged."
      : "";
    return {
      id,
      ok: true,
      ...(done.version ? { version: done.version } : {}),
      message:
        "Replaced. Every page that uses it shows the new file; set its focal point again if it had one." +
        stale +
        (await recordDone(source, "media-replace", id, change)),
    };
  });
  return result(outcomes, outcomes[0]!.message, conflict ? { conflict } : {});
}

/** Sets a file's whole tag set. Undo sets back the set it held, at the version this write made. */
export async function setFileTags(
  source: ContentSource,
  file: { id: string; version: string },
  raw: string[],
): Promise<IntentResult> {
  const parsed = parseMediaTags(raw);
  if (!parsed.ok) return refused(parsed.message);
  let undo: IntentResult["undo"];
  const { outcomes, conflict } = await eachItem(source, [file], "file", async ({ id, version }) => {
    const detail = await source.client.media.get(id);
    if (detail.version !== version) throw new Conflict(detail.version ?? null);
    const change = changeId();
    const written = await source.client.media.setTags(id, {
      tags: parsed.tags,
      expectedVersion: version,
      changeId: change,
    });
    undo = {
      intent: "tags",
      fields: { ids: [id], versions: [written.version], tags: (detail.tags ?? []).join(", ") },
    };
    return {
      id,
      ok: true,
      version: written.version,
      message: "Tags saved." + (await recordDone(source, "media-tags", id, change)),
    };
  });
  return result(outcomes, outcomes[0]!.message, {
    ...(conflict ? { conflict } : {}),
    ...(undo ? { undo } : {}),
  });
}

/**
 * Deletes for good every file in the trash, each through the site's own reference check: a file a
 * post still uses is refused and stays in the trash. Sends again while the site says more remain and
 * the last round deleted something.
 */
export async function emptyTrash(source: ContentSource): Promise<IntentResult> {
  const outcomes: Outcome[] = [];
  const refusedIds = new Set<string>();
  let more = false;
  for (let round = 0; round < EMPTY_ROUNDS; round++) {
    // The site records file n under `<change id>-<n>` in the order it lists the trash, refused files
    // included, so the kit lists the same trash first to record the same ids.
    const order = source.record
      ? (await source.client.media.list({ trashed: "only", limit: 200 })).items.map((i) => i.id)
      : [];
    const change = changeId();
    const answer = await source.client.media.emptyTrash({ changeId: change });
    for (const id of answer.deleted) {
      const n = order.indexOf(id);
      const note = await recordDone(
        source,
        "media-delete",
        id,
        n >= 0 ? `${change}-${n + 1}` : `${change}:${id}`,
      );
      outcomes.push({ id, ok: true, message: "Deleted from the site." + note });
    }
    for (const r of answer.refused) {
      if (refusedIds.has(r.id)) continue;
      refusedIds.add(r.id);
      outcomes.push({
        id: r.id,
        ok: false,
        message: r.message,
        ...(r.usedBy && r.usedBy.length > 0 ? { usedBy: r.usedBy } : {}),
      });
    }
    more = answer.more;
    if (!answer.more || answer.deleted.length === 0) break;
  }
  if (outcomes.length === 0) return { ok: true, message: "The trash was already empty.", outcomes };
  const deleted = outcomes.filter((o) => o.ok).length;
  const kept = outcomes.length - deleted;
  const message =
    `Deleted ${plural(deleted, "file")} from the trash for good.` +
    (kept > 0
      ? ` ${plural(kept, "file")} ${kept === 1 ? "is" : "are"} still used and stayed in the trash.`
      : "") +
    (more ? " More remain; empty the trash again." : "");
  return { ok: kept === 0 && !more, message, outcomes };
}
