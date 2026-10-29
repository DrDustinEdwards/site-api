// The R2 half of a media adapter's v0.10.0 writes, for a site that keeps its files in an R2 bucket: the focal point,
// kept where site-runtime's ./image reads it for its crops, and new bytes under the same key. The site's own index (its
// version, alt, caption, size) is the adapter's; these touch only the object.
//
// R2 has no metadata-only update, so a focal point is written by putting the object again with its own bytes. Each put
// is conditional on the etag that was read, so a write that raced another is refused rather than lost.

import { FOCUS_METADATA, focusOf } from "@dustinedwards/site-runtime/image";

import { NotFoundError, RefusedError } from "./adapter.js";

/** The parts of an R2 object these read. */
export interface R2ObjectLike {
  etag: string;
  httpEtag: string;
  httpMetadata?: { contentType?: string; [field: string]: unknown };
  customMetadata?: Record<string, string>;
}

/** The parts of an R2 bucket binding these use, so a site passes its binding straight in. */
export interface R2BucketLike {
  head(key: string): Promise<R2ObjectLike | null>;
  get(key: string): Promise<(R2ObjectLike & { arrayBuffer(): Promise<ArrayBuffer> }) | null>;
  put(
    key: string,
    value: ArrayBuffer | Uint8Array,
    options: { httpMetadata?: R2ObjectLike["httpMetadata"]; customMetadata?: Record<string, string>; onlyIf: { etagMatches: string } },
  ): Promise<R2ObjectLike | null>;
}

const RACED = "The file changed on the site while this was being written. Nothing was changed; try again.";

/**
 * Sets the object's focal point (customMetadata `focus`, FOCUS_METADATA, in `focusOf`'s spelling), or removes it for
 * null, keeping its bytes and every other metadata field. Answers the object as written; its etag moves, so the
 * image route's cached sizes (keyed by etag from site-runtime 0.28.0) are made afresh around the new point.
 */
export async function writeFocus(bucket: R2BucketLike, key: string, focus: string | null): Promise<R2ObjectLike> {
  const point = focus === null ? null : focusOf(focus);
  if (focus !== null && point === null) throw new RefusedError(`"${focus}" is not a focal point: write it as XxY, each from 0 to 1.`);
  const object = await bucket.get(key);
  if (!object) throw new NotFoundError("No such media.");
  const { [FOCUS_METADATA]: _old, ...rest } = object.customMetadata ?? {};
  const written = await bucket.put(key, await object.arrayBuffer(), {
    ...(object.httpMetadata ? { httpMetadata: object.httpMetadata } : {}),
    customMetadata: point ? { ...rest, [FOCUS_METADATA]: point } : rest,
    onlyIf: { etagMatches: object.etag },
  });
  if (!written) throw new RefusedError(RACED);
  return written;
}

/**
 * Puts new bytes under the same key, keeping the object's HTTP metadata (its type and cache-control) and its custom
 * metadata, less the focal point, which named a place in the old picture. Refuses bytes of another type: the key names
 * the type. Answers the object as written.
 */
export async function replaceObject(bucket: R2BucketLike, key: string, input: { bytes: Uint8Array; contentType: string }): Promise<R2ObjectLike> {
  const object = await bucket.head(key);
  if (!object) throw new NotFoundError("No such media.");
  const held = (object.httpMetadata?.contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (held && held !== input.contentType) throw new RefusedError(`This file is ${held}, and the replacement is ${input.contentType}. Upload it as a new file instead.`);
  const { [FOCUS_METADATA]: _old, ...rest } = object.customMetadata ?? {};
  const written = await bucket.put(key, input.bytes, {
    httpMetadata: { ...object.httpMetadata, contentType: input.contentType },
    customMetadata: rest,
    onlyIf: { etagMatches: object.etag },
  });
  if (!written) throw new RefusedError(RACED);
  return written;
}
