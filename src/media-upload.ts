// The upload step every site's media adapter ran for itself (v0.15.0), once: the checks, HEIC and HEIF to JPEG, a
// photo's location taken out, the shrink to the site's longest edge, what the picture says about itself, the placeholder
// and main color, and the hashes. A site's `upload` calls prepareUpload and stores what it answers. readEmbedded,
// stripLocation and the PNG reader are byte work on Web APIs alone, so they run in a Worker; the conversion, the shrink
// and the placeholder go through the Images binding.

import { sha256Hex, toBase64, toHex } from "@dustinedwards/site-runtime/encoding";
import { IMAGE_QUALITY, editImage, type ImagesLike } from "@dustinedwards/site-runtime/image";

import { RefusedError, type MediaUpload } from "./adapter.js";
import { MediaPlaceholder, type MediaResize, type MediaUploadLimits } from "./contract.js";
import { checkUpload } from "./media.js";
import { toArrayBuffer } from "./media-kit.js";

const ascii = (b: Uint8Array, from: number, length: number) => String.fromCharCode(...b.subarray(from, from + length));
const u32be = (b: Uint8Array, at: number) => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0;
const u32le = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;

// ---------- Embedded metadata

/**
 * What a picture says about itself (mediaEmbedded): who made it, its copyright, its description and when it was taken.
 * The contract's takenAt: with an offset where the file names one, local time where not.
 */
export type EmbeddedFields = {
  credit?: string;
  license?: string;
  caption?: string;
  takenAt?: string;
};

const TAGS = { description: 0x010e, artist: 0x013b, copyright: 0x8298, exifIfd: 0x8769, gpsIfd: 0x8825, taken: 0x9003, offset: 0x9011 } as const;

/**
 * The four fields from whichever metadata the file's type carries: a JPEG's or a WebP's EXIF, a PNG's eXIf and text
 * chunks, a HEIC's or a HEIF's Exif item. Only these four are read; nothing else in the metadata (a camera's location, its
 * serial number) is kept or passed on. {} for none or for anything unreadable. Moved from dustinedwards.info, where five
 * other sites had copied it (v0.15.0), adding a PNG's eXIf, HEIC and HEIF.
 */
export function readEmbedded(bytes: Uint8Array, contentType: string): EmbeddedFields {
  try {
    if (contentType === "image/jpeg") return fromTiff(jpegExif(bytes));
    if (contentType === "image/webp") return fromTiff(webpExif(bytes));
    if (contentType === "image/png") return fromPng(bytes);
    if (contentType === "image/heic" || contentType === "image/heif") return fromTiff(heifExif(bytes));
  } catch {
    // A malformed block is no metadata, never a refused upload.
  }
  return {};
}

const text = (value: string | undefined, max: number) => {
  // EXIF pads with NUL, and a copyright may hold "photographer\0editor": the first part is the one that names.
  const first = value?.split("\u0000")[0]?.trim();
  return first ? first.slice(0, max) : undefined;
};

/** The TIFF block inside a JPEG's APP1 "Exif" segment, or null. */
function jpegExif(b: Uint8Array): Uint8Array | null {
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let at = 2;
  while (at + 4 <= b.length && b[at] === 0xff) {
    const marker = b[at + 1]!;
    // Start of scan: the metadata segments are all before it.
    if (marker === 0xda) return null;
    const length = (b[at + 2]! << 8) | b[at + 3]!;
    if (marker === 0xe1 && ascii(b, at + 4, 6) === "Exif\u0000\u0000") return b.subarray(at + 10, at + 2 + length);
    at += 2 + length;
  }
  return null;
}

/** The TIFF block in a WebP's EXIF chunk, or null. */
function webpExif(b: Uint8Array): Uint8Array | null {
  let at = 12;
  while (at + 8 <= b.length) {
    const size = u32le(b, at + 4);
    if (ascii(b, at, 4) === "EXIF") return tiffOf(b.subarray(at + 8, at + 8 + size));
    at += 8 + size + (size % 2);
  }
  return null;
}

/** Some writers keep the JPEG segment's "Exif\0\0" in front of the TIFF header. */
const tiffOf = (data: Uint8Array) => (ascii(data, 0, 4) === "Exif" ? data.subarray(6) : data);

/**
 * The TIFF block of a HEIC's or a HEIF's Exif item (ISO/IEC 23008-12, Annex A): the item named `Exif` in the meta box's
 * iinf, found at its iloc extent, whose first four bytes give the TIFF header's offset after them. Null for none.
 */
function heifExif(b: Uint8Array): Uint8Array | null {
  const meta = boxes(b, 0, b.length).find((box) => box.type === "meta");
  if (!meta) return null;
  // meta, iinf, infe and iloc are full boxes: a version byte and three flag bytes first.
  const children = boxes(b, meta.start + 4, meta.end);
  const iinf = children.find((box) => box.type === "iinf");
  const iloc = children.find((box) => box.type === "iloc");
  if (!iinf || !iloc) return null;
  let id: number | undefined;
  for (const infe of boxes(b, iinf.start + (b[iinf.start] === 0 ? 6 : 8), iinf.end)) {
    const version = b[infe.start]!;
    if (infe.type !== "infe" || version < 2) continue;
    const typeAt = infe.start + 4 + (version === 2 ? 2 : 4) + 2;
    if (ascii(b, typeAt, 4) === "Exif") id = version === 2 ? (b[infe.start + 4]! << 8) | b[infe.start + 5]! : u32be(b, infe.start + 4);
  }
  if (id === undefined) return null;

  const version = b[iloc.start]!;
  let at = iloc.start + 4;
  const [offsetSize, lengthSize, baseSize, indexSize] = [b[at]! >> 4, b[at]! & 15, b[at + 1]! >> 4, version > 0 ? b[at + 1]! & 15 : 0];
  at += 2;
  const read = (size: number) => {
    const value = size === 8 ? u32be(b, at) * 2 ** 32 + u32be(b, at + 4) : size === 4 ? u32be(b, at) : size === 2 ? (b[at]! << 8) | b[at + 1]! : 0;
    at += size;
    return value;
  };
  const items = read(version < 2 ? 2 : 4);
  for (let i = 0; i < items && at < iloc.end; i++) {
    const item = read(version < 2 ? 2 : 4);
    const method = version > 0 ? read(2) & 15 : 0;
    read(2);
    const base = read(baseSize);
    const extents = read(2);
    let first: { offset: number; length: number } | undefined;
    for (let e = 0; e < extents; e++) {
      if (version > 0) read(indexSize);
      const offset = read(offsetSize);
      const length = read(lengthSize);
      first ??= { offset, length };
    }
    // Construction method 0 is an offset in the file; the others (an idat box, another item) are not used for Exif.
    if (item !== id || method !== 0 || !first) continue;
    const start = base + first.offset;
    const data = b.subarray(start, first.length ? start + first.length : b.length);
    return data.subarray(4 + u32be(data, 0));
  }
  return null;
}

/** The boxes between two offsets: each one's type and where its contents start and end. */
function boxes(b: Uint8Array, from: number, to: number): { type: string; start: number; end: number }[] {
  const found = [];
  let at = from;
  while (at + 8 <= to) {
    let size = u32be(b, at);
    let header = 8;
    if (size === 1) [size, header] = [u32be(b, at + 8) * 2 ** 32 + u32be(b, at + 12), 16];
    else if (size === 0) size = to - at;
    if (size < header) break;
    found.push({ type: ascii(b, at + 4, 4), start: at + header, end: Math.min(at + size, to) });
    at += size;
  }
  return found;
}

/** IFD0's artist, copyright and description, and the EXIF IFD's original date and its offset. */
function fromTiff(tiff: Uint8Array | null): EmbeddedFields {
  if (!tiff || tiff.length < 8) return {};
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return {};
  if (view.getUint16(2, little) !== 42) return {};

  const ifd = (start: number) => {
    const entries = new Map<number, { type: number; count: number; at: number }>();
    if (start + 2 > tiff.length) return entries;
    const n = view.getUint16(start, little);
    for (let i = 0; i < n; i++) {
      const at = start + 2 + i * 12;
      if (at + 12 > tiff.length) break;
      entries.set(view.getUint16(at, little), { type: view.getUint16(at + 2, little), count: view.getUint32(at + 4, little), at: at + 8 });
    }
    return entries;
  };
  const asciiValue = (entry: { type: number; count: number; at: number } | undefined) => {
    if (!entry || entry.type !== 2 || entry.count === 0) return undefined;
    const from = entry.count <= 4 ? entry.at : view.getUint32(entry.at, little);
    if (from + entry.count > tiff.length) return undefined;
    return new TextDecoder().decode(tiff.subarray(from, from + entry.count));
  };

  const first = ifd(view.getUint32(4, little));
  const pointer = first.get(TAGS.exifIfd);
  const exif = pointer ? ifd(view.getUint32(pointer.at, little)) : new Map();
  const fields: EmbeddedFields = {};
  const credit = text(asciiValue(first.get(TAGS.artist)), 300);
  const license = text(asciiValue(first.get(TAGS.copyright)), 300);
  const caption = text(asciiValue(first.get(TAGS.description)), 2000);
  const takenAt = exifDate(text(asciiValue(exif.get(TAGS.taken)), 40), text(asciiValue(exif.get(TAGS.offset)), 10));
  if (credit) fields.credit = credit;
  if (license) fields.license = license;
  if (caption) fields.caption = caption;
  if (takenAt) fields.takenAt = takenAt;
  return fields;
}

/** EXIF's "YYYY:MM:DD HH:MM:SS" and its "+HH:MM", as an ISO date and time; undefined for a placeholder or a bad date. */
function exifDate(value: string | undefined, offset: string | undefined): string | undefined {
  const m = value && /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value);
  if (!m) return undefined;
  const local = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  // A camera with no clock writes zeros, which parse to no date.
  if (Number.isNaN(Date.parse(`${local}Z`)) || m[1] === "0000") return undefined;
  return offset && /^[+-]\d{2}:\d{2}$/.test(offset) ? `${local}${offset}` : local;
}

/** A PNG's eXIf chunk, then its tEXt and uncompressed iTXt chunks (Author, Copyright, Description, Creation Time) over it. */
function fromPng(b: Uint8Array): EmbeddedFields {
  const found: Record<string, string> = {};
  let exif: Uint8Array | null = null;
  let at = 8;
  while (at + 12 <= b.length) {
    const length = u32be(b, at);
    const type = ascii(b, at + 4, 4);
    const data = b.subarray(at + 8, at + 8 + length);
    if (type === "IEND") break;
    const nul = data.indexOf(0);
    if (type === "eXIf") {
      exif = data;
    } else if (nul > 0 && type === "tEXt") {
      found[new TextDecoder("latin1").decode(data.subarray(0, nul))] = new TextDecoder("latin1").decode(data.subarray(nul + 1));
    } else if (nul > 0 && type === "iTXt" && data[nul + 1] === 0) {
      // Keyword, compression flag and method, language tag, translated keyword, then the text.
      const lang = data.indexOf(0, nul + 3);
      const translated = lang === -1 ? -1 : data.indexOf(0, lang + 1);
      if (translated !== -1) found[new TextDecoder().decode(data.subarray(0, nul))] = new TextDecoder().decode(data.subarray(translated + 1));
    }
    at += 12 + length;
  }
  const fields = fromTiff(exif);
  const credit = text(found.Author, 300);
  const license = text(found.Copyright, 300);
  const caption = text(found.Description, 2000);
  const created = found["Creation Time"] ? Date.parse(found["Creation Time"]) : Number.NaN;
  if (credit) fields.credit = credit;
  if (license) fields.license = license;
  if (caption) fields.caption = caption;
  if (!Number.isNaN(created)) fields.takenAt = new Date(created).toISOString();
  return fields;
}

// ---------- Location

/** Bytes per value of each TIFF field type, for the size of what a GPS entry points at. */
const TYPE_BYTES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };

/**
 * Takes the GPS IFD out of a TIFF block, in place, keeping its length: IFD0 loses its GPS pointer (the entries after it
 * move up one), and the GPS IFD and every value it points at are zeroed where they lie, so no other offset moves.
 * Orientation, copyright and everything else stay. False when there was no GPS IFD.
 */
function dropGps(tiff: Uint8Array): boolean {
  if (tiff.length < 8) return false;
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return false;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  if (view.getUint16(2, little) !== 42) return false;
  const ifd0 = view.getUint32(4, little);
  if (ifd0 + 2 > tiff.length) return false;
  const n = view.getUint16(ifd0, little);
  const end = ifd0 + 2 + n * 12;
  if (end + 4 > tiff.length) return false;
  let entry = -1;
  for (let i = 0; i < n; i++) if (view.getUint16(ifd0 + 2 + i * 12, little) === TAGS.gpsIfd) entry = ifd0 + 2 + i * 12;
  if (entry === -1) return false;

  const gps = view.getUint32(entry + 8, little);
  if (gps + 2 <= tiff.length) {
    const m = view.getUint16(gps, little);
    for (let i = 0; i < m && gps + 14 + i * 12 <= tiff.length; i++) {
      const at = gps + 2 + i * 12;
      const length = (TYPE_BYTES[view.getUint16(at + 2, little)] ?? 0) * view.getUint32(at + 4, little);
      // A value of four bytes or fewer sits in the entry itself, zeroed with the IFD below.
      if (length > 4) {
        const from = view.getUint32(at + 8, little);
        tiff.fill(0, Math.min(from, tiff.length), Math.min(from + length, tiff.length));
      }
    }
    tiff.fill(0, gps, Math.min(gps + 2 + m * 12 + 4, tiff.length));
  }
  // The entries after the pointer and the next IFD's offset move up one entry; the twelve bytes freed at the end are zeroed.
  tiff.copyWithin(entry, entry + 12, end + 4);
  tiff.fill(0, end - 8, end + 4);
  view.setUint16(ifd0, n - 1, little);
  return true;
}

/** Bytes as a string of one character each, and back: every byte kept, as a TextDecoder for latin1 (windows-1252) would not. */
function byteString(b: Uint8Array): string {
  let out = "";
  for (let at = 0; at < b.length; at += 8192) out += String.fromCharCode(...b.subarray(at, at + 8192));
  return out;
}
const bytesOf = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

/**
 * An XMP packet without its GPS properties (exif:GPSLatitude, exif:GPSLongitude and the rest, under any prefix), whether
 * written as attributes or as elements. Null when it had none.
 */
function xmpWithoutGps(data: Uint8Array): Uint8Array | null {
  const xmp = byteString(data);
  const stripped = xmp
    .replace(/\s+[\w.-]+:GPS[A-Za-z]*\s*=\s*("[^"]*"|'[^']*')/g, "")
    .replace(/<([\w.-]+:GPS[A-Za-z]*)\b[^>]*\/>/g, "")
    .replace(/<([\w.-]+:GPS[A-Za-z]*)\b[^>]*>[\s\S]*?<\/\1\s*>/g, "");
  return stripped === xmp ? null : bytesOf(stripped);
}

const XMP_JPEG = "http://ns.adobe.com/xap/1.0/\u0000";
const XMP_PNG = "XML:com.adobe.xmp";

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/**
 * The picture without where it was taken: a JPEG's EXIF GPS IFD and XMP GPS properties, a PNG's eXIf GPS IFD and XMP
 * iTXt GPS properties, a WebP's EXIF GPS IFD and XMP GPS properties. Lossless: no pixel is decoded or re-encoded, and
 * orientation, the color profile and copyright stay. Bytes with no location, of another type or unreadable come back as
 * the same array; a changed file is a new one, and the input is never written to. Not covered: XMP compressed in a
 * PNG's zTXt or iTXt, a JPEG's extended XMP, and a thumbnail's own metadata.
 */
export function stripLocation(bytes: Uint8Array, contentType: string): Uint8Array {
  try {
    if (contentType === "image/jpeg") return jpegWithoutLocation(bytes);
    if (contentType === "image/png") return pngWithoutLocation(bytes);
    if (contentType === "image/webp") return webpWithoutLocation(bytes);
  } catch {
    // A block too malformed to walk is left as it came, as readEmbedded leaves it unread.
  }
  return bytes;
}

function jpegWithoutLocation(b: Uint8Array): Uint8Array {
  if (b[0] !== 0xff || b[1] !== 0xd8) return b;
  const out = b.slice();
  const parts: Uint8Array[] = [out.subarray(0, 2)];
  let changed = false;
  let at = 2;
  while (at + 4 <= out.length && out[at] === 0xff) {
    const marker = out[at + 1]!;
    // Start of scan: the metadata segments are all before it, and the rest is copied as it is.
    if (marker === 0xda) break;
    const length = (out[at + 2]! << 8) | out[at + 3]!;
    const segment = out.subarray(at, at + 2 + length);
    at += 2 + length;
    if (marker === 0xe1 && ascii(segment, 4, 6) === "Exif\u0000\u0000") {
      changed = dropGps(segment.subarray(10)) || changed;
    } else if (marker === 0xe1 && ascii(segment, 4, XMP_JPEG.length) === XMP_JPEG) {
      const xmp = xmpWithoutGps(segment.subarray(4 + XMP_JPEG.length));
      if (xmp) {
        const size = 2 + XMP_JPEG.length + xmp.length;
        parts.push(new Uint8Array([0xff, 0xe1, size >> 8, size & 0xff]), bytesOf(XMP_JPEG), xmp);
        changed = true;
        continue;
      }
    }
    parts.push(segment);
  }
  if (!changed) return b;
  parts.push(out.subarray(at));
  return concat(parts);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** One PNG chunk: its length, type, data and the CRC-32 of the type and data. */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(bytesOf(type), 4);
  chunk.set(data, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, 8 + data.length)) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  view.setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0);
  return chunk;
}

function pngWithoutLocation(b: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let changed = false;
  let at = 8;
  while (at + 12 <= b.length) {
    const length = u32be(b, at);
    const type = ascii(b, at + 4, 4);
    const end = at + 12 + length;
    if (end > b.length) break;
    const data = b.subarray(at + 8, at + 8 + length);
    let chunk: Uint8Array = b.subarray(at, end);
    if (type === "eXIf") {
      const exif = data.slice();
      if (dropGps(exif)) [chunk, changed] = [pngChunk(type, exif), true];
    } else if (type === "iTXt" && ascii(data, 0, XMP_PNG.length + 2) === `${XMP_PNG}\u0000\u0000`) {
      // Uncompressed: keyword, compression flag 0 and method, language tag, translated keyword, then the packet.
      const lang = data.indexOf(0, XMP_PNG.length + 3);
      const translated = lang === -1 ? -1 : data.indexOf(0, lang + 1);
      const xmp = translated === -1 ? null : xmpWithoutGps(data.subarray(translated + 1));
      if (xmp) [chunk, changed] = [pngChunk(type, concat([data.subarray(0, translated + 1), xmp])), true];
    }
    parts.push(chunk);
    at = end;
    if (type === "IEND") break;
  }
  if (!changed) return b;
  parts.push(b.subarray(at));
  return concat(parts);
}

function webpWithoutLocation(b: Uint8Array): Uint8Array {
  if (ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return b;
  const parts: Uint8Array[] = [b.slice(0, 12)];
  let changed = false;
  let at = 12;
  while (at + 8 <= b.length) {
    const size = u32le(b, at + 4);
    const end = Math.min(at + 8 + size + (size % 2), b.length);
    const fourcc = ascii(b, at, 4);
    let chunk: Uint8Array = b.subarray(at, end);
    if (fourcc === "EXIF") {
      const copy = chunk.slice();
      if (dropGps(tiffOf(copy.subarray(8, 8 + size)))) [chunk, changed] = [copy, true];
    } else if (fourcc === "XMP ") {
      const xmp = xmpWithoutGps(b.subarray(at + 8, at + 8 + size));
      if (xmp) {
        const header = new Uint8Array(8);
        header.set(bytesOf(fourcc));
        new DataView(header.buffer).setUint32(4, xmp.length, true);
        [chunk, changed] = [concat([header, xmp, new Uint8Array(xmp.length % 2)]), true];
      }
    }
    parts.push(chunk);
    at = end;
  }
  if (!changed) return b;
  const out = concat(parts);
  // The RIFF size counts everything after its own eight bytes.
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return out;
}

// ---------- Placeholder and main color

/**
 * The placeholder fits inside this square, so a tall or a wide picture's stays as small as a square one's. Moved from
 * dustinedwards.info's placeholderFor (v0.15.0), the one site that made one, at 20 pixels wide and unblurred.
 */
const PLACEHOLDER_EDGE = 16;

/** The placeholder's encoding: always with a quality, without which the binding writes a lossless WebP, and one still frame of a GIF. */
const PLACEHOLDER_OUTPUT = { format: "image/webp", quality: 60, anim: false };

/** The bytes of one transform through the binding, or null where it failed. */
async function transformed(images: ImagesLike, bytes: Uint8Array, transform: object, output: { format: string; quality?: number }): Promise<Uint8Array | null> {
  try {
    const result = await images.input(new Response(toArrayBuffer(bytes)).body!).transform(transform).output(output);
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
  const row = new Uint8Array(await new Response(new Blob([toArrayBuffer(concat(idat))]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
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
export async function placeholderAndColor(images: ImagesLike, bytes: Uint8Array): Promise<{ placeholder: string | null; color: string | null }> {
  // A light blur: the page scales these few pixels up, and a soft edge reads as loading rather than as a blocky picture.
  const tiny = await transformed(images, bytes, { width: PLACEHOLDER_EDGE, height: PLACEHOLDER_EDGE, fit: "scale-down", blur: 2 }, PLACEHOLDER_OUTPUT);
  const placeholder = tiny && `data:image/webp;base64,${toBase64(tiny)}`;
  if (!tiny || !MediaPlaceholder.safeParse(placeholder).success) return { placeholder: null, color: null };
  const pixel = await transformed(images, tiny, { width: 1, height: 1, fit: "squeeze" }, { format: "image/png" });
  try {
    return { placeholder, color: pixel && (await pngColor(pixel)) };
  } catch {
    // A PNG too malformed to read is no color, never a refused upload.
    return { placeholder, color: null };
  }
}

// ---------- The upload step

/** The Images binding as prepareUpload uses it: site-runtime's ImagesLike, and `info`, which measures a picture for free. */
export interface UploadImages extends ImagesLike {
  info(stream: ReadableStream): Promise<object>;
}

/** Types the Images binding re-encodes in their own type. A GIF is left out: it may be animated, and a shrink would keep one frame. */
const REENCODED = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);
type Encoded = "image/jpeg" | "image/png" | "image/webp" | "image/avif";

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
  /** The bytes to store: converted, without a location, shrunk. */
  bytes: Uint8Array;
  /** The stored type: image/jpeg for a HEIC or HEIF upload, else the upload's. */
  contentType: string;
  /** The upload's name, ending .jpg where the picture was converted. */
  filename: string;
  /** The stored picture's size, as the Images binding measures it; null for a file it cannot measure. */
  width: number | null;
  height: number | null;
  /** The SHA-256 of `bytes`, the stored file. */
  sha256: string;
  /** The SHA-256 of the bytes as sent: the hash the package's route asked findByHash about. */
  uploadSha256: string;
  /** What the picture says about itself, read before anything changed it. The site fills each only where it is empty. */
  embedded: EmbeddedFields;
  /** True when a HEIC or HEIF upload was converted to JPEG. */
  converted: boolean;
  /** True when a location was taken out of the file without re-encoding it. */
  located: boolean;
  /** A 16 pixel blurred WebP as a data: URI (MediaPlaceholder); null for a file the binding cannot read, as an SVG. */
  placeholder: string | null;
  /** The picture's main color, #rrggbb in lower case (MediaColor); null where there is no placeholder or no reading of it. */
  color: string | null;
  /** The picture's size before the shrink, for the upload's answer. */
  resizedFrom?: { width: number; height: number; bytes: number };
  /** The bytes before the shrink (converted, without a location), for the site's backup and the file's history. */
  original?: Uint8Array;
}

/** The picture's width and height by the binding; null when it reports none or cannot read the file. */
async function measure(images: UploadImages, bytes: Uint8Array): Promise<{ width: number; height: number } | null> {
  try {
    const info = (await images.info(new Response(toArrayBuffer(bytes)).body!)) as { width?: unknown; height?: unknown };
    return typeof info.width === "number" && typeof info.height === "number" && info.width > 0 && info.height > 0 ? { width: info.width, height: info.height } : null;
  } catch {
    return null;
  }
}

/**
 * The upload step for a site's adapter, in order: the site's limits where given (type, size, signature); the embedded
 * metadata, read first because every re-encode by the binding drops it; HEIC and HEIF to JPEG through the Images binding,
 * which applies the EXIF orientation and keeps only the copyright; the location taken out of what is not re-encoded
 * (stripLocation); the shrink to `resize.maxEdge` where the upload asked for it (site-runtime's editImage, in the
 * picture's own type, the binding applying the orientation again); the stored size; the placeholder and main color, from
 * the stored bytes where the binding could measure them; and the hashes. Throws RefusedError
 * for bytes outside the limits or a HEIC the binding cannot convert.
 */
export async function prepareUpload(images: UploadImages, input: MediaUpload, options: PrepareUploadOptions = {}): Promise<PreparedUpload> {
  if (options.limits) {
    if (input.bytes.byteLength > options.limits.maxBytes) throw new RefusedError(`The file is larger than this site accepts (${options.limits.maxBytes} bytes).`);
    const refusal = checkUpload(input.contentType, input.bytes, options.limits);
    if (refusal) throw new RefusedError(refusal.message);
  }
  const embedded = readEmbedded(input.bytes, input.contentType);
  const quality = options.resize?.quality ?? IMAGE_QUALITY;

  let bytes = input.bytes;
  let contentType = input.contentType;
  let filename = input.filename;
  const converted = CONVERTED.has(contentType);
  if (converted) {
    // Not editImage, which asks for a turn, a mirror or a maxEdge: this is a change of format alone.
    try {
      const result = await images.input(new Response(toArrayBuffer(bytes)).body!).transform({}).output({ format: "image/jpeg", quality });
      bytes = new Uint8Array(await result.response().arrayBuffer());
    } catch (error) {
      throw new RefusedError(`Cloudflare Images could not convert the picture to JPEG, so nothing was stored (${error instanceof Error ? error.message : String(error)}).`);
    }
    contentType = "image/jpeg";
    filename = /\.hei[cf]$/i.test(filename) ? filename.replace(/\.hei[cf]$/i, ".jpg") : `${filename}.jpg`;
  }

  const kept = stripLocation(bytes, contentType);
  const located = kept !== bytes;
  bytes = kept;

  let size = await measure(images, bytes);
  let resizedFrom: PreparedUpload["resizedFrom"];
  let original: Uint8Array | undefined;
  const maxEdge = options.resize?.maxEdge;
  if (input.resize && maxEdge && size && REENCODED.has(contentType) && Math.max(size.width, size.height) > maxEdge) {
    original = bytes;
    resizedFrom = { width: size.width, height: size.height, bytes: bytes.byteLength };
    const response = await editImage(images, toArrayBuffer(bytes), { maxEdge, format: contentType as Encoded, quality });
    bytes = new Uint8Array(await response.arrayBuffer());
    const scale = maxEdge / Math.max(size.width, size.height);
    size = (await measure(images, bytes)) ?? { width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
  }

  const { placeholder, color } = size ? await placeholderAndColor(images, bytes) : { placeholder: null, color: null };
  const sha256 = await sha256Hex(bytes);
  const uploadSha256 = input.sha256 ?? (bytes === input.bytes ? sha256 : await sha256Hex(input.bytes));
  return {
    bytes,
    contentType,
    filename,
    width: size?.width ?? null,
    height: size?.height ?? null,
    sha256,
    uploadSha256,
    embedded,
    converted,
    located,
    placeholder,
    color,
    ...(resizedFrom ? { resizedFrom, original } : {}),
  };
}
