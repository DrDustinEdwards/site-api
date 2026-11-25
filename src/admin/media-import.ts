// The media intents that bring a file in: upload, import, and the model's alt text for a new file.

import { mediaType } from "@dustinedwards/site-runtime/http";

import { SiteApiError } from "../client.js";
import { altRefusal } from "../media.js";
import { type MediaUploadLimits } from "../contract.js";
import {
  type ContentSource,
  type IntentInput,
  type IntentResult,
  fieldOf,
  text,
  refused,
  changeId,
  recordDone,
  result,
  megabytes,
} from "./kit.js";

export async function uploadOne(
  source: ContentSource,
  input: IntentInput,
  limits: MediaUploadLimits,
): Promise<IntentResult> {
  const file = fieldOf(input, "file").find((v): v is Blob => typeof v !== "string");
  if (!file) return refused("Choose a file to upload.");
  const name = (file as Blob & { name?: string }).name || "upload";
  const type = mediaType(file.type);
  if (!limits.types.includes(type)) {
    return refused(
      `${name} is ${type || "an unknown type"}; this site accepts ${limits.types.map((t) => t.split("/")[1]).join(", ")}.`,
    );
  }
  if (file.size > limits.maxBytes)
    return refused(
      `${name} is ${megabytes(file.size)}; this site accepts files up to ${megabytes(limits.maxBytes)}.`,
    );
  if (file.size === 0) return refused(`${name} is empty.`);
  const alt = altOf(input, name);
  if (!alt.ok) return refused(`${name}: ${alt.message}`);
  const change = changeId();
  try {
    const item = await source.client.media.upload({
      bytes: new Uint8Array(await file.arrayBuffer()),
      contentType: type,
      filename: name.replace(/[/\\]/g, "-").slice(0, 200),
      ...alt.fields,
      changeId: change,
      ...(text(input, "resize") === "no" ? { resize: "no" as const } : {}),
    });
    if (item.duplicateOf) return stored(source, item, `${name} is already in the library`, change);
    return stored(source, item, `Uploaded ${name}`, change, "media-upload");
  } catch (error) {
    if (error instanceof SiteApiError && error.body)
      return refused(`The site refused ${name}: ${error.body.message}`);
    throw error;
  }
}

const EMBEDDED_WORDS: Record<string, string> = {
  credit: "credit",
  license: "license",
  caption: "caption",
  takenAt: "date taken",
  copyright: "copyright",
  licenseUrl: "license page",
  acquireLicenseUrl: "licensing page",
};

/** A form's "decorative" box (v0.19.0), checked. */
export const decorativeOf = (input: IntentInput) =>
  ["yes", "on", "1", "true"].includes(text(input, "decorative"));

/** The alt an upload or an import sends, or decorative (v0.19.0), or neither (v0.30.0): checked as the site checks it. */
function altOf(
  input: IntentInput,
  filename: string | null,
): { ok: true; fields: { alt: string } | { decorative: true } } | { ok: false; message: string } {
  const alt = text(input, "alt").trim();
  const decorative = decorativeOf(input);
  const wrong = altRefusal(alt, decorative, filename, false);
  return wrong
    ? { ok: false, message: wrong }
    : { ok: true, fields: decorative ? { decorative: true } : { alt } };
}

/**
 * The site's model's alt text and tags for a file the form holds, or an address to import (v0.19.0): what the upload form
 * puts in its alt field, marked as a suggestion, for the person to keep, change or replace. Nothing is stored.
 */
export async function suggestFor(source: ContentSource, input: IntentInput): Promise<IntentResult> {
  const file = fieldOf(input, "file").find((v): v is Blob => typeof v !== "string");
  const url = text(input, "url").trim();
  if (!file && !/^https:\/\//i.test(url))
    return refused("Choose a file, or give its https address.");
  try {
    const found = await source.client.media.suggestFile(
      file
        ? {
            bytes: new Uint8Array(await file.arrayBuffer()),
            contentType: mediaType(file.type),
          }
        : { url },
    );
    const message = found.alt
      ? "Suggested alt text. Check it says what matters here, then upload."
      : "The model had no alt text to suggest. Say what the picture shows.";
    return { ok: true, message, suggestion: found };
  } catch (error) {
    if (error instanceof SiteApiError && error.body)
      return refused(`The site did not suggest alt text: ${error.body.message}`);
    throw error;
  }
}

/**
 * What an upload or an import did, said in one sentence: a duplicate names the file it already was (nothing is recorded,
 * since nothing changed), and a new file says what the site shrank or filled in from the file itself.
 */
async function stored(
  source: ContentSource,
  item: {
    id: string;
    filename: string | null;
    duplicateOf?: string;
    embedded?: string[];
    resizedFrom?: { width: number; height: number };
    width: number | null;
    height: number | null;
  },
  lead: string,
  change: string,
  kind?: string,
): Promise<IntentResult> {
  if (item.duplicateOf) {
    const message = `${lead} as ${item.filename ?? item.id}, so no second copy was stored.`;
    return result([{ id: item.id, ok: true, message, duplicate: true }], message);
  }
  const notes = [
    item.resizedFrom && item.width && item.height
      ? ` Shrunk from ${item.resizedFrom.width}x${item.resizedFrom.height} to ${item.width}x${item.height}.`
      : "",
    item.embedded && item.embedded.length > 0
      ? ` Filled in from the file: ${item.embedded.map((f) => EMBEDDED_WORDS[f] ?? f).join(", ")}.`
      : "",
  ].join("");
  const note = await recordDone(source, kind!, item.id, change);
  const done = kind === "media-import" ? "Imported." : "Uploaded.";
  return result(
    [{ id: item.id, ok: true, message: done + notes + note }],
    `${lead}.` + notes + note,
  );
}

/** Has the site fetch a file from the web into its own storage (v0.13.0): `url`, and optional `filename` and `alt`. */
export async function importOne(source: ContentSource, input: IntentInput): Promise<IntentResult> {
  const url = text(input, "url").trim();
  if (!/^https:\/\//i.test(url)) return refused("Give the file's https address.");
  const filename = text(input, "filename").trim().replace(/[/\\]/g, "-").slice(0, 200);
  const alt = altOf(input, filename || null);
  if (!alt.ok) return refused(alt.message);
  const change = changeId();
  try {
    const item = await source.client.media.importUrl({
      url,
      ...(filename ? { filename } : {}),
      ...alt.fields,
      changeId: change,
      ...(text(input, "resize") === "no" ? { resize: "no" as const } : {}),
    });
    return stored(
      source,
      item,
      item.duplicateOf
        ? "That file is already in the library"
        : `Imported ${item.filename ?? item.id}`,
      change,
      "media-import",
    );
  } catch (error) {
    if (error instanceof SiteApiError && error.body)
      return refused(`The site did not import it: ${error.body.message}`);
    throw error;
  }
}
