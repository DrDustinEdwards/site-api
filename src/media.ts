// The upload checks the package makes before a site sees a byte (v0.2.0): the declared type must be
// one the site accepts, the body may not exceed the site's limit (read no further than that), and
// the bytes must look like the declared type where the type has a signature. The site's own checks
// (measuring an image, its storage) come after these, never instead of them.

import type { MediaUploadLimits } from "./contract.js";

/** The media type without parameters, lower case: "image/png; x=1" is "image/png". */
export function essence(contentType: string | null): string {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase();
}

export type UploadRefusal = { code: "invalid" | "too-large"; message: string };

/**
 * Reads the body up to `limits.maxBytes` and stops: a declared or actual size over the limit is
 * refused without buffering the rest.
 */
export async function readUpload(
  request: Request,
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

/** Refuses a type the site does not accept, and bytes that are not what the type claims. */
export function checkUpload(contentType: string, bytes: Uint8Array | null, limits: MediaUploadLimits): UploadRefusal | null {
  const types = limits.types.map((t) => t.toLowerCase());
  if (!types.includes(contentType)) {
    return { code: "invalid", message: `This site does not accept ${contentType || "a file with no type"}. It accepts ${types.join(", ")}.` };
  }
  if (bytes) {
    const signed = SIGNATURES[contentType];
    if (signed && !signed(bytes)) return { code: "invalid", message: `The file is not a ${contentType}: its bytes do not match the type it was sent as.` };
  }
  return null;
}
