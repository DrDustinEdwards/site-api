// The upload step every site's media adapter ran for itself (v0.15.0), once: the checks, HEIC and HEIF to JPEG, a
// photo's private metadata taken out, the shrink to the site's longest edge, what the picture says about itself, a file
// name in words, the placeholder and main color, and the hashes. A site's `upload` calls prepareUpload and stores what it
// answers. readEmbedded, stripMetadata and the PNG reader are byte work on Web APIs alone, so they run in a Worker; the
// conversion, the shrink and the placeholder go through the Images binding.

import { sha256Hex, toBase64, toHex } from "@dustinedwards/site-runtime/encoding";
import { IMAGE_QUALITY, editImage, type ImagesLike } from "@dustinedwards/site-runtime/image";

import { RefusedError, type MediaUpload } from "./adapter.js";
import { MediaPlaceholder, type MediaResize, type MediaUploadLimits } from "./contract.js";
import { ascii, checkUpload } from "./media.js";
import { toArrayBuffer } from "./media-kit.js";
import { concat, u32be } from "./media-upload/bytes.js";
import { type EmbeddedFields } from "./media-upload/types.js";
import { readEmbedded } from "./media-upload/fields.js";
import { duplicateKey, stripMetadata } from "./media-upload/strip.js";
export { readEmbedded } from "./media-upload/fields.js";
export type { EmbeddedFields } from "./media-upload/types.js";
export { duplicateKey, stripMetadata } from "./media-upload/strip.js";

/**
 * The placeholder fits inside this square, so a tall or a wide picture's stays as small as a square one's. */
const PLACEHOLDER_EDGE = 16;

/** The placeholder's encoding: always with a quality, without which the binding writes a lossless WebP, and one still frame of a GIF. */
const PLACEHOLDER_OUTPUT = { format: "image/webp", quality: 60, anim: false };

/** The bytes of one transform through the binding, or null where it failed. */
async function transformed(
  images: ImagesLike,
  bytes: Uint8Array,
  transform: object,
  output: { format: string; quality?: number },
): Promise<Uint8Array | null> {
  try {
    const result = await images
      .input(new Response(toArrayBuffer(bytes)).body!)
      .transform(transform)
      .output(output);
    return new Uint8Array(await result.response().arrayBuffer());
  } catch {
    return null;
  }
}

/**
 * The single pixel of a one-pixel PNG as #rrggbb, or null: any bit depth and color type, the zlib stream inflated by
 * DecompressionStream. With one pixel in one row, every PNG filter predicts zero, so the bytes after the filter byte are
 * the pixel itself. A pixel with no opacity (alpha 0, or a palette entry tRNS makes clear) has no color.
 */
async function pngColor(b: Uint8Array): Promise<string | null> {
  if (u32be(b, 0) !== 0x89504e47 || ascii(b, 12, 4) !== "IHDR") return null;
  const [depth, type] = [b[24]!, b[25]!];
  const idat: Uint8Array[] = [];
  let palette: Uint8Array | undefined;
  let alphas: Uint8Array | undefined;
  for (let at = 8; at + 12 <= b.length; at += 12 + u32be(b, at)) {
    const chunk = ascii(b, at + 4, 4);
    const data = b.subarray(at + 8, at + 8 + u32be(b, at));
    if (chunk === "IDAT") idat.push(data);
    else if (chunk === "PLTE") palette = data;
    else if (chunk === "tRNS") alphas = data;
    else if (chunk === "IEND") break;
  }
  const row = new Uint8Array(
    await new Response(
      new Blob([toArrayBuffer(concat(idat))])
        .stream()
        .pipeThrough(new DecompressionStream("deflate")),
    ).arrayBuffer(),
  );
  // A sample is its first byte (the high one of a 16-bit sample), or for a smaller depth the top bits of that byte.
  const step = depth === 16 ? 2 : 1;
  const sample = (i: number) => (depth < 8 ? row[1]! >> (8 - depth) : row[1 + i * step]!);
  const scale = (v: number) => (depth < 8 ? Math.round((v * 255) / (2 ** depth - 1)) : v);
  let rgb: number[];
  let alpha = 255;
  if (type === 3) {
    const i = sample(0);
    if (!palette || palette.length < i * 3 + 3) return null;
    rgb = [palette[i * 3]!, palette[i * 3 + 1]!, palette[i * 3 + 2]!];
    alpha = alphas?.[i] ?? 255;
  } else if (type === 0 || type === 4) {
    rgb = Array(3).fill(scale(sample(0)));
    if (type === 4) alpha = sample(1);
  } else if (type === 2 || type === 6) {
    rgb = [sample(0), sample(1), sample(2)];
    if (type === 6) alpha = sample(3);
  } else {
    return null;
  }
  return alpha === 0 || rgb.some((v) => v === undefined) ? null : `#${toHex(new Uint8Array(rgb))}`;
}

/**
 * A tiny blurred WebP of the stored picture, as a data: URI the contract carries (MediaPlaceholder), and the picture's
 * main color: two transforms through the binding, each billed, the second from the placeholder's few bytes rather than
 * the picture. The color is the blurred placeholder squeezed to one pixel, so every part of the picture weighs in, and
 * read from a PNG (WebP needs a decoder a Worker does not have). Null for either where the binding fails or the result
 * is outside the contract; no color without a placeholder, so a picture the binding cannot read costs one call.
 * prepareUpload calls it for every picture the binding measured; a site calls it alone to fill files stored before.
 */
export async function placeholderAndColor(
  images: ImagesLike,
  bytes: Uint8Array,
): Promise<{ placeholder: string | null; color: string | null }> {
  // A light blur: the page scales these few pixels up, and a soft edge reads as loading rather than as a blocky picture.
  const tiny = await transformed(
    images,
    bytes,
    { width: PLACEHOLDER_EDGE, height: PLACEHOLDER_EDGE, fit: "scale-down", blur: 2 },
    PLACEHOLDER_OUTPUT,
  );
  const placeholder = tiny && `data:image/webp;base64,${toBase64(tiny)}`;
  if (!tiny || !MediaPlaceholder.safeParse(placeholder).success)
    return { placeholder: null, color: null };
  const pixel = await transformed(
    images,
    tiny,
    { width: 1, height: 1, fit: "squeeze" },
    { format: "image/png" },
  );
  try {
    return { placeholder, color: pixel && (await pngColor(pixel)) };
  } catch {
    // A PNG too malformed to read is no color, never a refused upload.
    return { placeholder, color: null };
  }
}

/** The words of a camera's, a phone's or a screenshot tool's own file name, which say nothing a search can use. */
const CAMERA_WORDS = new Set([
  "img",
  "image",
  "dsc",
  "dscn",
  "dscf",
  "dcim",
  "pxl",
  "mvimg",
  "mp",
  "photo",
  "pic",
  "picture",
  "screenshot",
  "screen",
  "shot",
  "whatsapp",
  "signal",
  "at",
  "am",
  "pm",
  "p",
  "gopr",
  "dji",
  "mg",
  "wp",
  "unnamed",
  "untitled",
  "download",
  "edited",
  "scaled",
]);

/** The extensions each stored type may carry, the first the one given where the name has another. */
const EXTENSIONS: Record<string, string[]> = {
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "image/avif": ["avif"],
  "image/gif": ["gif"],
  "image/svg+xml": ["svg"],
};

/**
 * The name a file is stored under (C10): a camera's own name (IMG_0001, DSC01234, PXL_20260101_..., Screenshot 2026-...
 * at 10.22.33 AM, a UUID) replaced by `words` (the alt text, else the caption) as lower case words joined by hyphens, at
 * most 60 characters, a leading article dropped; any other name kept. The extension is the stored type's, so a name never
 * says .heic or .png over a JPEG. Exported for a site's own upload path.
 */
export function fileNameFor(filename: string, contentType: string, words: string): string {
  const dot = filename.lastIndexOf(".");
  let stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
  const camera =
    /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}/i.test(stem) ||
    stem
      .toLowerCase()
      .split(/[^a-z]+/)
      .every((w) => w === "" || CAMERA_WORDS.has(w));
  const slug = words
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^(?:an?|the)-/, "")
    .replace(/^-+|-+$/g, "");
  if (camera && slug)
    stem =
      slug.length > 60
        ? slug.slice(0, slug.lastIndexOf("-", 60) > 20 ? slug.lastIndexOf("-", 60) : 60)
        : slug;
  const allowed = EXTENSIONS[contentType];
  return (
    allowed && !allowed.includes(ext)
      ? `${stem}.${allowed[0]}`
      : dot > 0
        ? `${stem}.${filename.slice(dot + 1)}`
        : stem
  ).slice(0, 200);
}

/** The Images binding as prepareUpload uses it: site-runtime's ImagesLike, and `info`, which measures a picture for free. */
export interface UploadImages extends ImagesLike {
  info(stream: ReadableStream): Promise<object>;
}

/** Types the Images binding re-encodes in their own type. A GIF is left out: it may be animated, and a shrink would keep one frame. */
export const REENCODED = new Set<string>(["image/jpeg", "image/png", "image/webp", "image/avif"]);
export type Encoded = "image/jpeg" | "image/png" | "image/webp" | "image/avif";

/** Types stored as JPEG: no browser but Safari shows them. */
const CONVERTED = new Set(["image/heic", "image/heif"]);

export interface PrepareUploadOptions {
  /** The site's `resize`. With the upload's `resize: true` (the package sends false for `resize=no`), a longer picture is shrunk. */
  resize?: MediaResize;
  /** The site's limits, checked again for a site's own upload path, which the package's route did not check. */
  limits?: MediaUploadLimits;
}

/** What a site stores for one upload, and what its answer and history say about it. */
export interface PreparedUpload {
  /** The bytes to store: converted, without private metadata, shrunk. */
  bytes: Uint8Array;
  /** The stored type: image/jpeg for a HEIC or HEIF upload, else the upload's. */
  contentType: string;
  /**
   * The name to store (v0.19.0): a camera's or a phone's own name (IMG_0001, DSC01234, PXL_..., Screenshot ...) becomes
   * words from the alt text, else the embedded caption, and the extension is the stored type's (.jpg for a converted HEIC).
   */
  filename: string;
  /** The stored picture's size, as the Images binding measures it; null for a file it cannot measure. */
  width: number | null;
  height: number | null;
  /** The SHA-256 of `bytes`, the stored file. */
  sha256: string;
  /**
   * The upload's duplicates key (duplicateKey, v0.21.0; before, the SHA-256 of the bytes as sent): what the package's route
   * asked findByHash about and records for the file in the site's store. Equal to `sha256` unless the picture was
   * converted or shrunk.
   */
  uploadSha256: string;
  /** What the picture says about itself, read before anything changed it. The site fills each only where it is empty. */
  embedded: EmbeddedFields;
  /** True when a HEIC or HEIF upload was converted to JPEG. */
  converted: boolean;
  /** True when private metadata (a location, a serial number, a MakerNote, a thumbnail) was taken out without re-encoding. */
  stripped: boolean;
  /** A 16 pixel blurred WebP as a data: URI (MediaPlaceholder); null for a file the binding cannot read, as an SVG. */
  placeholder: string | null;
  /** The picture's main color, #rrggbb in lower case (MediaColor); null where there is no placeholder or no reading of it. */
  color: string | null;
  /** The picture's size before the shrink, for the upload's answer. */
  resizedFrom?: { width: number; height: number; bytes: number };
  /** The bytes before the shrink (converted, without private metadata), for the site's backup and the file's history. */
  original?: Uint8Array;
}

/** The picture's width and height by the binding; null when it reports none or cannot read the file. */
async function measure(
  images: UploadImages,
  bytes: Uint8Array,
): Promise<{ width: number; height: number } | null> {
  try {
    const info = (await images.info(new Response(toArrayBuffer(bytes)).body!)) as {
      width?: unknown;
      height?: unknown;
    };
    return typeof info.width === "number" &&
      typeof info.height === "number" &&
      info.width > 0 &&
      info.height > 0
      ? { width: info.width, height: info.height }
      : null;
  } catch {
    return null;
  }
}

/**
 * The upload step for a site's adapter, in order: the site's limits where given (type, size, signature); the embedded
 * metadata, read first because every re-encode by the binding drops it; HEIC and HEIF to JPEG through the Images binding,
 * which applies the EXIF orientation and keeps only the copyright; the private metadata taken out of what is not
 * re-encoded (stripMetadata); a camera's file name made words (fileNameFor); the shrink to `resize.maxEdge` where the upload asked for it (site-runtime's editImage, in the
 * picture's own type, the binding applying the orientation again); the stored size; the placeholder and main color, from
 * the stored bytes where the binding could measure them; and the hashes. Throws RefusedError
 * for bytes outside the limits or a HEIC the binding cannot convert.
 */
export async function prepareUpload(
  images: UploadImages,
  input: MediaUpload,
  options: PrepareUploadOptions = {},
): Promise<PreparedUpload> {
  if (options.limits) {
    if (input.bytes.byteLength > options.limits.maxBytes)
      throw new RefusedError(
        `The file is larger than this site accepts (${options.limits.maxBytes} bytes).`,
      );
    const refusal = checkUpload(input.contentType, input.bytes, options.limits);
    if (refusal) throw new RefusedError(refusal.message);
  }
  const embedded = readEmbedded(input.bytes, input.contentType);
  const quality = options.resize?.quality ?? IMAGE_QUALITY;

  let bytes = input.bytes;
  let contentType = input.contentType;
  const converted = CONVERTED.has(contentType);
  if (converted) {
    try {
      bytes = new Uint8Array(
        await (
          await editImage(images, toArrayBuffer(bytes), { format: "image/jpeg", quality })
        ).arrayBuffer(),
      );
    } catch (error) {
      throw new RefusedError(
        `Cloudflare Images could not convert the picture to JPEG, so nothing was stored (${error instanceof Error ? error.message : String(error)}).`,
      );
    }
    contentType = "image/jpeg";
  }

  const kept = stripMetadata(bytes, contentType);
  const stripped = kept !== bytes;
  bytes = kept;
  const filename = fileNameFor(input.filename, contentType, input.alt || embedded.caption || "");

  let size = await measure(images, bytes);
  let resizedFrom: PreparedUpload["resizedFrom"];
  let original: Uint8Array | undefined;
  const maxEdge = options.resize?.maxEdge;
  if (
    input.resize &&
    maxEdge &&
    size &&
    REENCODED.has(contentType) &&
    Math.max(size.width, size.height) > maxEdge
  ) {
    original = bytes;
    resizedFrom = { width: size.width, height: size.height, bytes: bytes.byteLength };
    const response = await editImage(images, toArrayBuffer(bytes), {
      maxEdge,
      format: contentType as Encoded,
      quality,
    });
    bytes = new Uint8Array(await response.arrayBuffer());
    const scale = maxEdge / Math.max(size.width, size.height);
    size = (await measure(images, bytes)) ?? {
      width: Math.round(size.width * scale),
      height: Math.round(size.height * scale),
    };
  }

  const { placeholder, color } = size
    ? await placeholderAndColor(images, bytes)
    : { placeholder: null, color: null };
  const hash = await sha256Hex(bytes);
  const uploadSha256 =
    input.sha256 ??
    (!converted && !resizedFrom ? hash : await duplicateKey(input.bytes, input.contentType));
  return {
    bytes,
    contentType,
    filename,
    width: size?.width ?? null,
    height: size?.height ?? null,
    sha256: hash,
    uploadSha256,
    embedded,
    converted,
    stripped,
    placeholder,
    color,
    ...(resizedFrom ? { resizedFrom, original } : {}),
  };
}
