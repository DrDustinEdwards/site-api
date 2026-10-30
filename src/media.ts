// The upload checks the package makes before a site sees a byte (v0.2.0): the declared type must be
// one the site accepts, the body may not exceed the site's limit (read no further than that), and
// the bytes must look like the declared type where the type has a signature. The site's own checks
// (measuring an image, its storage) come after these, never instead of them.

import type { MediaKind, MediaOrientation, MediaTransformOp, MediaUploadLimits } from "./contract.js";

/** The media type without parameters, lower case: "image/png; x=1" is "image/png". */
export function essence(contentType: string | null): string {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase();
}

type UploadRefusal = { code: "invalid" | "too-large"; message: string };

/**
 * Reads the body up to `limits.maxBytes` and stops: a declared or actual size over the limit is
 * refused without buffering the rest.
 */
export async function readUpload(
  request: { headers: Headers; body: ReadableStream<Uint8Array> | null },
  limits: MediaUploadLimits,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; refusal: UploadRefusal }> {
  const tooLarge: UploadRefusal = { code: "too-large", message: `The file is larger than this site accepts (${limits.maxBytes} bytes).` };
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > limits.maxBytes) return { ok: false, refusal: tooLarge };
  if (!request.body) return { ok: false, refusal: { code: "invalid", message: "The upload is empty." } };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limits.maxBytes) {
      await reader.cancel().catch(() => {});
      return { ok: false, refusal: tooLarge };
    }
    chunks.push(value);
  }
  if (total === 0) return { ok: false, refusal: { code: "invalid", message: "The upload is empty." } };
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return { ok: true, bytes };
}

const ascii = (bytes: Uint8Array, from: number, length: number) => String.fromCharCode(...bytes.subarray(from, from + length));

/**
 * The signature each known type's bytes must carry. A type with no entry here is the site's to
 * check; the package cannot tell what it should look like.
 */
const SIGNATURES: Record<string, (b: Uint8Array) => boolean> = {
  "image/png": (b) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v),
  "image/jpeg": (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  "image/gif": (b) => ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a",
  "image/webp": (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP",
  "image/avif": (b) => ascii(b, 4, 4) === "ftyp" && /avi[fs]/.test(ascii(b, 8, 24)),
  "application/pdf": (b) => ascii(b, 0, 5) === "%PDF-",
  // Text, so no magic number: no NUL byte in the head, and an <svg element near the start.
  "image/svg+xml": (b) => {
    const head = new TextDecoder().decode(b.subarray(0, 4096));
    return !head.includes("\u0000") && /^﻿?\s*</.test(head) && /<svg[\s>]/i.test(head);
  },
};

/**
 * Content that runs when a site serves the file from its own origin: script, event handlers, embedded documents and
 * javascript: links in an SVG, and JavaScript actions in a PDF. Such a file is refused rather than cleaned, since the
 * package does not rewrite what an editor uploads.
 */
const ACTIVE: Record<string, (b: Uint8Array) => boolean> = {
  "image/svg+xml": (b) =>
    /<script\b|[\s/"']on[a-z]+\s*=|<foreignObject\b|<(iframe|embed|object)\b|javascript:|href\s*=\s*["']\s*&#/i.test(new TextDecoder().decode(b)),
  "application/pdf": (b) => /\/(JS|JavaScript)\b/.test(new TextDecoder().decode(b)),
};

/** Refuses a type the site does not accept, and bytes that are not what the type claims. */
export function checkUpload(contentType: string, bytes: Uint8Array | null, limits: MediaUploadLimits): UploadRefusal | null {
  const types = limits.types.map((t) => t.toLowerCase());
  if (!types.includes(contentType)) {
    return { code: "invalid", message: `This site does not accept ${contentType || "a file with no type"}. It accepts ${types.join(", ")}.` };
  }
  if (bytes) {
    const signed = SIGNATURES[contentType];
    if (signed && !signed(bytes)) return { code: "invalid", message: `The file is not a ${contentType}: its bytes do not match the type it was sent as.` };
    if (ACTIVE[contentType]?.(bytes)) return { code: "invalid", message: `The ${contentType} file holds script or an embedded page, which would run on the site. Export it without them.` };
  }
  return null;
}

// ---------- v0.13.0

/**
 * The SHA-256 of a file's bytes as lower case hex: the one content hash every site keys duplicates by. site-runtime's, the
 * family's one copy (v0.14.0; the same digest this package wrote itself before).
 */
export { sha256Hex } from "@dustinedwards/site-runtime/encoding";

/** What a file is, from its type, for the list's `kind` filter: image, video and audio by their type, everything else a document. */
export function kindOf(contentType: string): MediaKind {
  const top = essence(contentType).split("/")[0];
  return top === "image" || top === "video" || top === "audio" ? top : "document";
}

/**
 * Which way a picture lies, for the list's `orientation` filter: square when its edges differ by at most 1% of the longer,
 * so a 4000x3990 photo is square. null for a file with no size.
 */
export function orientationOf(width: number | null, height: number | null): MediaOrientation | null {
  if (!width || !height) return null;
  if (Math.abs(width - height) <= Math.max(width, height) / 100) return "square";
  return width > height ? "landscape" : "portrait";
}

/** True when a transform swaps a picture's width and height. */
export function turnsSize(op: MediaTransformOp): boolean {
  return op === "rotate-90" || op === "rotate-270";
}

/**
 * Where a focal point lands after a transform, so a site moves it with the picture rather than clearing it. rotate-90 is a
 * quarter turn clockwise: the top left corner goes to the top right. In focusOf's spelling, or null for none.
 */
export function transformFocus(focus: string | null, op: MediaTransformOp): string | null {
  const parsed = focus === null ? null : /^([\d.]+)x([\d.]+)$/.exec(focus);
  if (!parsed) return null;
  const [x, y] = [Number(parsed[1]), Number(parsed[2])];
  const moved: Record<MediaTransformOp, [number, number]> = {
    "rotate-90": [1 - y, x],
    "rotate-180": [1 - x, 1 - y],
    "rotate-270": [y, 1 - x],
    "flip-h": [1 - x, y],
    "flip-v": [x, 1 - y],
  };
  const spell = (n: number) => String(Math.round(n * 1000) / 1000);
  return `${spell(moved[op][0])}x${spell(moved[op][1])}`;
}

/**
 * Why an import may not fetch this address, or null when it may: https on the default port, no user name or password, and a
 * host name that is neither an IP address nor a local name, so an import never reaches into a private network.
 */
export function importRefusal(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "That is not a web address.";
  }
  if (url.protocol !== "https:") return "Only https addresses are imported.";
  if (url.username || url.password) return "An address carrying a user name or password is not imported.";
  if (url.port !== "") return "Only the default https port is imported.";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || /^[\d.]+$/.test(host) || /^0x/i.test(host)) return "An address by IP number is not imported; use its host name.";
  if (!host.includes(".") || /(^|\.)(localhost|local|internal|lan|home|arpa)$/.test(host)) return "A local address is not imported.";
  return null;
}

/** How long an import waits for the other site, and how many redirects it follows. */
const IMPORT_TIMEOUT_MS = 15_000;
const IMPORT_REDIRECTS = 3;

/**
 * Fetches an import with the given fetch, following at most three redirects by hand so each hop is checked as the first
 * was. Throws ImportRefusal with words for the person; the response is the final one, unread, with its address.
 */
export async function fetchImport(doFetch: typeof fetch, raw: string): Promise<{ response: Response; address: string }> {
  let address = raw;
  for (let hop = 0; hop <= IMPORT_REDIRECTS; hop++) {
    const refusal = importRefusal(address);
    if (refusal) throw new ImportRefusal(refusal);
    let response: Response;
    try {
      response = await doFetch(address, { redirect: "manual", signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS), headers: { accept: "*/*" } });
    } catch {
      throw new ImportRefusal("The other site did not answer.");
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => {});
      address = new URL(location, address).toString();
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ImportRefusal(`The other site answered ${response.status}.`);
    }
    return { response, address };
  }
  throw new ImportRefusal("The address redirects too many times.");
}

/** An import the package would not fetch, or that the other site did not answer. */
export class ImportRefusal extends Error {}
