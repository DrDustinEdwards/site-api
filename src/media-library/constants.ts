import { slugify } from "@drdustinedwards/site-helpers/slug";

import {
  type MediaLens,
  type MediaResize,
  type MediaTransformOp,
  type MediaUploadLimits,
} from "../contract.js";
import { type MediaKeyInput } from "./types.js";

/**
 * The picture types every site takes (v0.27.0). No SVG, which would be script on the site's own origin. HEIC and HEIF (an
 * iPhone's photos) are taken too and stored as JPEG.
 */
export const PICTURE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/gif",
  "image/heic",
  "image/heif",
] as const;

/** The upload limits every site starts from (v0.27.0): pictures only, 20 MiB each; a site passes its own `maxBytes` to change the size. */
export function pictureLimits(maxBytes = 20 * 1024 * 1024): MediaUploadLimits {
  return { maxBytes, types: [...PICTURE_TYPES] };
}

/**
 * What an upload shrinks to unless it says `resize=no` (v0.27.0): a phone photo (4032 pixels) keeps its size, a larger
 * camera file is shrunk and its original is kept in the file's history.
 */
export const PICTURE_RESIZE: MediaResize = { maxEdge: 2560, quality: 85 };

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "text/csv": "csv",
  "text/plain": "txt",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "video/mp4": "mp4",
};

/** The extension a stored type is named with: the known one, else the file's own, else "bin". */
export function extensionFor(contentType: string, filename: string): string {
  const own = /\.([A-Za-z0-9]{1,8})$/.exec(filename)?.[1]?.toLowerCase();
  return EXTENSIONS[contentType] ?? own ?? "bin";
}

/**
 * The network's key for a new file: <prefix><yyyy>/<mm>/<name>-<hash>.<ext>, the name a slug of the stored name (at most
 * 60 characters, "file" when none is left) and the hash the first 8 of the upload's, with -2, -3 and on for a taken key.
 */
export function datedKey(prefix: string): (file: MediaKeyInput, attempt: number) => string {
  return (file, attempt) => {
    const name = slugify(file.filename.replace(/\.[^./]*$/, ""), { max: 60 }) || "file";
    return `${prefix}${file.at.slice(0, 4)}/${file.at.slice(5, 7)}/${name}-${file.sha256.slice(0, 8)}${attempt === 1 ? "" : `-${attempt}`}.${extensionFor(file.contentType, file.filename)}`;
  };
}

export const LIBRARY_LENSES = [
  "no-alt",
  "large",
  "duplicates",
  "license-expired",
] as const satisfies readonly MediaLens[];

/** The quality a turn or a mirror encodes at: high, since each one re-encodes a lossy picture. */
export const TRANSFORM_QUALITY = 92;

/** Each transform as editImage's options. A quarter turn is clockwise, as the contract's rotate-90 is. */
export const TRANSFORMS: Record<MediaTransformOp, { rotate?: 90 | 180 | 270; flip?: "h" | "v" }> = {
  "rotate-90": { rotate: 90 },
  "rotate-180": { rotate: 180 },
  "rotate-270": { rotate: 270 },
  "flip-h": { flip: "h" },
  "flip-v": { flip: "v" },
};

export const OFFSET = /^(0|[1-9]\d{0,8})$/;
export const SEQ = /^(0|[1-9]\d{0,15})$/;
export const RACED =
  "The file changed on the site while this was being written, so its bytes were kept as they were. Reload it and try again.";

/** Every revision a delete or a revert looks through; the history panel shows the newest 100. */
export const ALL_REVISIONS = 10_000;

export const positive = (n: number | null): number | null => (n !== null && n > 0 ? n : null);
