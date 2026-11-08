// The media kit (v0.14.0): the pieces every site's media adapter wrote for itself, once. A file's version spelled from its
// index row's rev, a versioned write's outcome as the contract's answer or error, a fresh ArrayBuffer for R2 and the Images
// binding, the AI suggester behind `suggest`, and the plain page a preview renders into.

import { MODEL_IDS, structured } from "@dustinedwards/site-runtime/anthropic";
import { toBase64 } from "@dustinedwards/site-runtime/encoding";
import { escapeHtml } from "@dustinedwards/site-runtime/html";
import { editImage, type ImagesLike } from "@dustinedwards/site-runtime/image";
import { checkProse } from "@dustinedwards/site-runtime/prose";

import { NotFoundError, RefusedError, VersionConflictError } from "./adapter.js";

// ---------- Versions

/** A version this package's sites answer: `r` and the row's rev, a whole number without a leading zero. */
export const MEDIA_VERSION_PATTERN = /^r(0|[1-9]\d{0,15})$/;

/**
 * A file's version from its index row's `rev`, which every write moves in the statement that checks it, so two writes in
 * one second still differ.
 */
export function mediaVersion(rev: number): string {
  return `r${rev}`;
}

/** The rev a version names, or -1 (which no row holds) for anything the site never answered. */
export function mediaRev(version: string): number {
  return MEDIA_VERSION_PATTERN.test(version) ? Number(version.slice(1)) : -1;
}

/**
 * What one versioned write to a file's row did: the new rev (`changed: false` when the row was already as asked), no such
 * file, a stale version with the rev the row holds, or the site's own refusal in words for the person.
 */
export type MediaWrite =
  | { ok: true; rev: number; changed?: boolean }
  | { ok: false; reason: "missing" }
  | { ok: false; reason: "stale"; rev: number | null }
  | { ok: false; reason: "refused"; message: string };

/** A write's outcome as the contract's answer, or the error the handler turns into 404, 409 or 422. */
export function answerWrite(write: MediaWrite): { version: string } {
  if (write.ok) return { version: mediaVersion(write.rev) };
  switch (write.reason) {
    case "missing":
      throw new NotFoundError("No such media.");
    case "stale":
      throw new VersionConflictError(
        write.rev === null ? null : mediaVersion(write.rev),
        "The file changed since it was loaded.",
      );
    case "refused":
      throw new RefusedError(write.message);
  }
}

/** A fresh ArrayBuffer of a view's bytes, not `bytes.buffer`, which may be a larger allocation shared with other views. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

// ---------- AI suggestions

/** The vision model: Claude's fast role (site-runtime's MODEL_IDS.fast, Haiku 5.5), called straight at Anthropic. */
export const SUGGEST_MODEL = MODEL_IDS.fast;

/** The longest edge the model is shown: enough to name what is in a picture, and a small request. */
const VIEW_EDGE = 768;

/** The feature on each `anthropic_call` log line, beside the site's `app`, so the suggester's cost splits from the site's other calls. */
export const SUGGEST_FEATURE = "media-suggest";

/** How long a suggestion may take before the call is abandoned; a person is waiting on it. */
const SUGGEST_TIMEOUT_MS = 30_000;

/** The answer's shape, asked of the model through structured outputs (`output_config.format`). */
const SUGGESTION_SCHEMA = {
  type: "object",
  properties: { alt: { type: "string" }, tags: { type: "array", items: { type: "string" } } },
  required: ["alt", "tags"],
  additionalProperties: false,
};

/** The bindings and variables the suggester reads. */
export interface SuggestEnv {
  /** The site's Anthropic key. Without it the suggester throws, and the site should leave `suggest` off its adapter. */
  ANTHROPIC_API_KEY?: string;
  /** The Images binding, for the smaller copy the model is shown. */
  IMAGES: ImagesLike;
}

/** The tokens one suggestion spent, as Anthropic reports them (site-runtime's `Usage`, plus the model). */
export interface SuggestUsage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface MediaSuggesterOptions<E extends SuggestEnv> {
  /** The site's name on each `anthropic_call` log line ("example"). */
  app: string;
  /** Where the picture is, finishing "...one picture ": "on a personal website", "in a travel blog". */
  describe: string;
  /** More sentences for the prompt, the site's own rules ("Do not use em dashes."). */
  rules?: string[];
  /** Runs before the model is called; throw to stop it (a daily cost cap). */
  beforeCall?: (env: E, id: string | undefined) => Promise<void> | void;
  /** Runs after the model answers, with what it spent, to meter it. A failure here is the site's to catch; it fails the call. */
  afterCall?: (env: E, usage: SuggestUsage, id: string | undefined) => Promise<void> | void;
}

/** What the model suggests for one picture: its tags and alt text as it wrote them (the package cleans both), and the model. */
export interface MediaSuggestion {
  tags: string[];
  alt: string | null;
  model: string;
}

/**
 * The house rule for alt text: what the picture shows, plainly, and nothing more, so a reader who cannot see it learns what
 * a sighted reader sees. No interpretation, no praise, no "image of".
 */
function promptFor(describe: string, rules: string[]): string {
  return [
    `You write alt text and library tags for one picture ${describe}.`,
    "alt: one plain sentence, at most 25 words, describing what the picture shows: the subject, what it is doing,",
    "and any text that is legible in it. Say only what can be seen. Do not begin with 'Image of', 'Picture of' or",
    "'Photo of'. Do not interpret, praise or guess at feelings, names or places that are not written in the picture.",
    ...rules,
    "tags: three to eight short lower case nouns for what is in the picture, words joined by hyphens, no duplicates.",
  ].join(" ");
}

/**
 * The model's answer as tags and alt: the parsed object structured outputs return. Anything that is not that object
 * reads as no suggestion.
 */
export function readSuggestion(answer: unknown): { tags: string[]; alt: string | null } {
  const record = (typeof answer === "object" && answer !== null ? answer : {}) as {
    alt?: unknown;
    tags?: unknown;
  };
  const alt = typeof record.alt === "string" && record.alt.trim() ? record.alt.trim() : null;
  const tags = Array.isArray(record.tags)
    ? record.tags.filter((t): t is string => typeof t === "string")
    : [];
  return { tags, alt };
}

/**
 * The AI tag and alt-text suggester every site wrote behind its adapter's `suggest`: a 768px JPEG of the picture (through
 * site-runtime's editImage) shown to Claude Haiku 5.5, called straight at Anthropic with the site's ANTHROPIC_API_KEY
 * (never through AI Gateway). Nothing here writes: a suggestion reaches the file only when a person accepts it. Send only
 * the site's own uploads, never a visitor's data. The returned function takes the env, the picture (a stream or an R2
 * object) and, for the hooks, its id.
 */
export function mediaSuggester<E extends SuggestEnv>(options: MediaSuggesterOptions<E>) {
  const prompt = promptFor(options.describe, options.rules ?? []);
  return async function suggest(
    env: E,
    picture: ReadableStream | { body: ReadableStream },
    id?: string,
  ): Promise<MediaSuggestion> {
    if (!env.ANTHROPIC_API_KEY)
      throw new Error("This site has no ANTHROPIC_API_KEY, so it cannot suggest tags or alt text.");
    await options.beforeCall?.(env, id);
    const stream = "getReader" in picture ? picture : picture.body;
    const view = await editImage(env.IMAGES, stream, {
      maxEdge: VIEW_EDGE,
      format: "image/jpeg",
      quality: 80,
    });
    const data = toBase64(await view.arrayBuffer());
    const result = await structured<{ alt?: unknown; tags?: unknown }>(
      env,
      options.app,
      {
        model: SUGGEST_MODEL,
        max_tokens: 300,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
              { type: "text", text: prompt },
            ],
          },
        ],
      },
      SUGGESTION_SCHEMA,
      { feature: SUGGEST_FEATURE, timeoutMs: SUGGEST_TIMEOUT_MS },
    );
    // A failed call still spent what it spent where Anthropic reported it, so it is metered before it throws.
    if (options.afterCall)
      await options.afterCall(env, { model: SUGGEST_MODEL, ...result.usage }, id);
    if (!result.ok) throw new Error(result.error);
    const { tags, alt } = readSuggestion(result.value);
    // Alt text with a high or critical prose finding (a refusal, a cutoff note, a blank, citation markup) is not offered.
    const flagged =
      alt !== null &&
      checkProse(alt, { model: SUGGEST_MODEL }).some(
        (issue) => issue.severity === "high" || issue.severity === "critical",
      );
    return { tags, alt: flagged ? null : alt, model: SUGGEST_MODEL };
  };
}

// ---------- Preview

export interface PreviewDocumentInput {
  /** The page's title, written escaped. */
  title: string;
  /** The page's body HTML, from the site's own renderer and sanitizer, written as it is. */
  body: string;
  /** The page's language, "en" by default. */
  lang?: string;
  /** Stylesheet addresses, absolute or resolved against `origin`: the preview is shown on Carrel's origin, not the site's. */
  stylesheets?: string[];
  /** The site's origin, for relative stylesheet addresses. */
  origin?: string;
  /** More attributes on `<html>` (a theme, a family), each value escaped. */
  attributes?: Record<string, string>;
  /** CSS for the preview alone, such as showing what the site's script would reveal. */
  style?: string;
}

/**
 * The plain page a preview renders into: the site's body under its title, `noindex` so a preview found by a crawler is
 * never listed, every value but the body escaped. A full themed route needs a saved row; an unsaved source does not have
 * one, so sites preview the body in this page.
 */
export function previewDocument(input: PreviewDocumentInput): string {
  const attributes = Object.entries(input.attributes ?? {})
    .map(([name, value]) => ` ${name.replace(/[^\w:-]/g, "")}="${escapeHtml(value)}"`)
    .join("");
  const css = (input.stylesheets ?? [])
    .map(
      (href) =>
        `<link rel="stylesheet" href="${escapeHtml(input.origin ? new URL(href, input.origin).href : href)}">`,
    )
    .join("");
  const style = input.style
    ? `<style>${input.style.replace(/<\/style/gi, "<\\/style")}</style>`
    : "";
  return (
    `<!doctype html><html lang="${escapeHtml(input.lang ?? "en")}"${attributes}><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">` +
    `<title>${escapeHtml(input.title)}</title>${css}${style}</head><body>${input.body}</body></html>`
  );
}
