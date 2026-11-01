// The upload step every site's media adapter ran for itself (v0.15.0), once: the checks, HEIC and HEIF to JPEG, a
// photo's private metadata taken out, the shrink to the site's longest edge, what the picture says about itself, a file
// name in words, the placeholder and main color, and the hashes. A site's `upload` calls prepareUpload and stores what it
// answers. readEmbedded, stripMetadata and the PNG reader are byte work on Web APIs alone, so they run in a Worker; the
// conversion, the shrink and the placeholder go through the Images binding.

import { escapeXml } from "@drdustinedwards/site-helpers/xml";
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
 * What a picture says about itself (mediaEmbedded), read from its XMP, its IPTC and its EXIF, in that order of trust.
 * `credit` is the credit line, else the creator; `license` the usage terms, else the copyright notice (what it held before
 * v0.19.0); `takenAt` with an offset where the file names one, local time where not. v0.19.0 adds the copyright notice
 * alone and the two addresses Google Images reads for its Licensable badge: the license (`licenseUrl`, XMP's
 * WebStatement) and where to get one (`acquireLicenseUrl`, PLUS's LicensorURL).
 */
export type EmbeddedFields = {
  credit?: string;
  license?: string;
  caption?: string;
  takenAt?: string;
  copyright?: string;
  licenseUrl?: string;
  acquireLicenseUrl?: string;
};

/** Each fact apart, as the metadata holds it: the fresh XMP a cleaned file keeps is written from these. */
type Facts = {
  creator?: string;
  creditLine?: string;
  copyright?: string;
  terms?: string;
  licenseUrl?: string;
  acquireLicenseUrl?: string;
  caption?: string;
  takenAt?: string;
};

/** The metadata blocks one file carries, each null where it has none. */
type Blocks = { tiff: Uint8Array | null; xmp: string | null; iptc: Uint8Array | null; text: Record<string, string> };

const NONE: Blocks = { tiff: null, xmp: null, iptc: null, text: {} };

const TAGS = { description: 0x010e, artist: 0x013b, copyright: 0x8298, exifIfd: 0x8769, taken: 0x9003, offset: 0x9011 } as const;

/**
 * The fields from whichever metadata the file's type carries: a JPEG's EXIF, XMP and IPTC (APP13), a PNG's eXIf, XMP and
 * text chunks, a WebP's EXIF and XMP, and a HEIC's, a HEIF's or an AVIF's Exif and XMP items. Only these fields are read;
 * nothing else in the metadata (a camera's location, its serial number) is kept or passed on. {} for none or for anything
 * unreadable. Moved from dustinedwards.info (v0.15.0); IPTC, XMP and AVIF are v0.19.0.
 */
export function readEmbedded(bytes: Uint8Array, contentType: string): EmbeddedFields {
  const f = factsOf(blocksOf(bytes, contentType));
  const fields: EmbeddedFields = {
    credit: f.creditLine ?? f.creator,
    license: f.terms ?? f.copyright,
    caption: f.caption,
    takenAt: f.takenAt,
    copyright: f.copyright,
    licenseUrl: f.licenseUrl,
    acquireLicenseUrl: f.acquireLicenseUrl,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
}

function blocksOf(bytes: Uint8Array, contentType: string): Blocks {
  try {
    if (contentType === "image/jpeg") return jpegBlocks(bytes);
    if (contentType === "image/webp") return webpBlocks(bytes);
    if (contentType === "image/png") return pngBlocks(bytes);
    if (HEIF.has(contentType)) return heifBlocks(bytes);
  } catch {
    // A malformed block is no metadata, never a refused upload.
  }
  return NONE;
}

/** The facts from each block, the first one found winning: XMP, then IPTC, then a PNG's text, then EXIF. */
function factsOf(blocks: Blocks): Facts {
  const found: Facts = {};
  for (const source of [safely(fromXmp, blocks.xmp), safely(fromIptc, blocks.iptc), fromPngText(blocks.text), safely(fromTiff, blocks.tiff)]) {
    for (const [key, value] of Object.entries(source) as [keyof Facts, string | undefined][]) if (value && !found[key]) found[key] = value;
  }
  return found;
}

function safely<T>(read: (block: T) => Facts, block: T | null): Facts {
  try {
    return block === null ? {} : read(block);
  } catch {
    return {};
  }
}

const text = (value: string | undefined, max: number) => {
  // EXIF pads with NUL, and a copyright may hold "photographer\0editor": the first part is the one that names.
  const first = value?.split("\u0000")[0]?.trim();
  return first ? first.slice(0, max) : undefined;
};

const address = (value: string | undefined) => {
  const v = value?.trim();
  return v && /^https?:\/\/\S+$/i.test(v) && v.length <= 2000 ? v : undefined;
};

const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);

/** One JPEG metadata segment: its marker, where it starts and ends, and its data after the length. */
type Segment = { marker: number; at: number; end: number; data: Uint8Array };

/** The segments before the first scan, and where that scan starts (b.length when there is none). */
function jpegSegments(b: Uint8Array): { segments: Segment[]; scan: number } {
  const segments: Segment[] = [];
  let at = 2;
  while (at + 4 <= b.length && b[at] === 0xff) {
    const marker = b[at + 1]!;
    if (marker === 0xda) return { segments, scan: at };
    // A fill byte before a marker.
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    const end = at + 2 + ((b[at + 2]! << 8) | b[at + 3]!);
    segments.push({ marker, at, end, data: b.subarray(at + 4, end) });
    at = end;
  }
  return { segments, scan: b.length };
}

const EXIF_JPEG = "Exif\u0000\u0000";
const XMP_JPEG = "http://ns.adobe.com/xap/1.0/\u0000";
const IPTC_JPEG = "Photoshop 3.0\u0000";
const XMP_PNG = "XML:com.adobe.xmp";

const isExif = (s: Segment) => s.marker === 0xe1 && ascii(s.data, 0, 6) === EXIF_JPEG;
const isXmp = (s: Segment) => s.marker === 0xe1 && ascii(s.data, 0, XMP_JPEG.length) === XMP_JPEG;
const isIptc = (s: Segment) => s.marker === 0xed && ascii(s.data, 0, IPTC_JPEG.length) === IPTC_JPEG;

function jpegBlocks(b: Uint8Array): Blocks {
  if (b[0] !== 0xff || b[1] !== 0xd8) return NONE;
  const { segments } = jpegSegments(b);
  const exif = segments.find(isExif);
  const xmp = segments.find(isXmp);
  const iptc = segments.find(isIptc);
  return {
    tiff: exif ? exif.data.subarray(6) : null,
    xmp: xmp ? utf8(xmp.data.subarray(XMP_JPEG.length)) : null,
    iptc: iptc ? iptc.data.subarray(IPTC_JPEG.length) : null,
    text: {},
  };
}

/** One RIFF chunk of a WebP: its FourCC, where it starts and ends (padding included), and its data. */
function riffChunks(b: Uint8Array): { fourcc: string; at: number; end: number; data: Uint8Array }[] {
  const chunks = [];
  let at = 12;
  while (at + 8 <= b.length) {
    const size = u32le(b, at + 4);
    const end = Math.min(at + 8 + size + (size % 2), b.length);
    chunks.push({ fourcc: ascii(b, at, 4), at, end, data: b.subarray(at + 8, Math.min(at + 8 + size, b.length)) });
    at = end;
  }
  return chunks;
}

function webpBlocks(b: Uint8Array): Blocks {
  if (ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return NONE;
  const chunks = riffChunks(b);
  const exif = chunks.find((c) => c.fourcc === "EXIF");
  const xmp = chunks.find((c) => c.fourcc === "XMP ");
  return { tiff: exif ? tiffOf(exif.data) : null, xmp: xmp ? utf8(xmp.data) : null, iptc: null, text: {} };
}

/** Some writers keep the JPEG segment's "Exif\0\0" in front of the TIFF header. */
const tiffOf = (data: Uint8Array) => (ascii(data, 0, 4) === "Exif" ? data.subarray(6) : data);

/** One PNG chunk: its type, where it starts and ends, and its data. */
function pngChunks(b: Uint8Array): { type: string; at: number; end: number; data: Uint8Array }[] {
  const chunks = [];
  let at = 8;
  while (at + 12 <= b.length) {
    const end = at + 12 + u32be(b, at);
    if (end > b.length) break;
    const type = ascii(b, at + 4, 4);
    chunks.push({ type, at, end, data: b.subarray(at + 8, end - 4) });
    at = end;
    if (type === "IEND") break;
  }
  return chunks;
}

/** A text chunk's keyword, and its text where it is not compressed (tEXt, or an iTXt with compression flag 0). */
function pngText(type: string, data: Uint8Array): { keyword: string; value?: string } | null {
  const nul = data.indexOf(0);
  if (nul < 1 || !["tEXt", "iTXt", "zTXt"].includes(type)) return null;
  const keyword = new TextDecoder("latin1").decode(data.subarray(0, nul));
  if (type === "tEXt") return { keyword, value: new TextDecoder("latin1").decode(data.subarray(nul + 1)) };
  if (type === "zTXt" || data[nul + 1] !== 0) return { keyword };
  // Keyword, compression flag and method, language tag, translated keyword, then the text.
  const lang = data.indexOf(0, nul + 3);
  const translated = lang === -1 ? -1 : data.indexOf(0, lang + 1);
  return translated === -1 ? { keyword } : { keyword, value: utf8(data.subarray(translated + 1)) };
}

function pngBlocks(b: Uint8Array): Blocks {
  const blocks: Blocks = { tiff: null, xmp: null, iptc: null, text: {} };
  for (const chunk of pngChunks(b)) {
    if (chunk.type === "eXIf") blocks.tiff = chunk.data;
    const found = pngText(chunk.type, chunk.data);
    if (found?.value === undefined) continue;
    if (found.keyword === XMP_PNG) blocks.xmp = found.value;
    else blocks.text[found.keyword] = found.value;
  }
  return blocks;
}

function fromPngText(found: Record<string, string>): Facts {
  const created = found["Creation Time"] ? Date.parse(found["Creation Time"]) : Number.NaN;
  return {
    creator: text(found.Author, 300),
    copyright: text(found.Copyright, 300),
    caption: text(found.Description, 2000),
    takenAt: Number.isNaN(created) ? undefined : new Date(created).toISOString(),
  };
}

const HEIF = new Set(["image/heic", "image/heif", "image/avif"]);

/** One metadata item of a HEIF file (ISO/IEC 23008-12): an Exif item or an XMP one, and where its bytes lie. */
type HeifItem = { kind: "exif" | "xmp"; data: Uint8Array };

/**
 * The Exif and XMP (a `mime` item of type application/rdf+xml) items of a HEIC, a HEIF or an AVIF: named in the meta
 * box's iinf, found at their iloc extent, in the file (construction method 0) or in the meta box's idat (method 1).
 */
function heifItems(b: Uint8Array): HeifItem[] {
  const meta = boxes(b, 0, b.length).find((box) => box.type === "meta");
  if (!meta) return [];
  // meta, iinf, infe and iloc are full boxes: a version byte and three flag bytes first.
  const children = boxes(b, meta.start + 4, meta.end);
  const iinf = children.find((box) => box.type === "iinf");
  const iloc = children.find((box) => box.type === "iloc");
  const idat = children.find((box) => box.type === "idat");
  if (!iinf || !iloc) return [];
  const kinds = new Map<number, HeifItem["kind"]>();
  for (const infe of boxes(b, iinf.start + (b[iinf.start] === 0 ? 6 : 8), iinf.end)) {
    const version = b[infe.start]!;
    if (infe.type !== "infe" || version < 2) continue;
    const id = version === 2 ? (b[infe.start + 4]! << 8) | b[infe.start + 5]! : u32be(b, infe.start + 4);
    const typeAt = infe.start + 4 + (version === 2 ? 2 : 4) + 2;
    const type = ascii(b, typeAt, 4);
    // A mime item: its name, then its content type, each ending in NUL.
    const nameEnd = b.indexOf(0, typeAt + 4);
    const mime = nameEnd === -1 ? "" : ascii(b, nameEnd + 1, Math.max(0, b.indexOf(0, nameEnd + 1) - nameEnd - 1));
    if (type === "Exif") kinds.set(id, "exif");
    else if (type === "mime" && mime === "application/rdf+xml") kinds.set(id, "xmp");
  }
  if (kinds.size === 0) return [];

  const version = b[iloc.start]!;
  let at = iloc.start + 4;
  const [offsetSize, lengthSize, baseSize, indexSize] = [b[at]! >> 4, b[at]! & 15, b[at + 1]! >> 4, version > 0 ? b[at + 1]! & 15 : 0];
  at += 2;
  const read = (size: number) => {
    const value = size === 8 ? u32be(b, at) * 2 ** 32 + u32be(b, at + 4) : size === 4 ? u32be(b, at) : size === 2 ? (b[at]! << 8) | b[at + 1]! : 0;
    at += size;
    return value;
  };
  const items: HeifItem[] = [];
  const count = read(version < 2 ? 2 : 4);
  for (let i = 0; i < count && at < iloc.end; i++) {
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
    const kind = kinds.get(item);
    // Method 2 (another item's bytes) is not used for metadata.
    if (!kind || !first || method > 1 || (method === 1 && !idat)) continue;
    const start = (method === 1 ? idat!.start : 0) + base + first.offset;
    const end = first.length ? start + first.length : method === 1 ? idat!.end : b.length;
    if (end <= b.length) items.push({ kind, data: b.subarray(start, end) });
  }
  return items;
}

/** An Exif item's TIFF block: its first four bytes give the TIFF header's offset after them. */
const heifTiff = (data: Uint8Array) => data.subarray(4 + u32be(data, 0));

function heifBlocks(b: Uint8Array): Blocks {
  const items = heifItems(b);
  const exif = items.find((i) => i.kind === "exif");
  const xmp = items.find((i) => i.kind === "xmp");
  return { tiff: exif ? heifTiff(exif.data) : null, xmp: xmp ? utf8(xmp.data) : null, iptc: null, text: {} };
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

/** One TIFF directory entry: its tag, type, count and value bytes, wherever they lie. */
type Entry = { tag: number; type: number; count: number; value: Uint8Array };

/** Bytes per value of each TIFF field type. */
const TYPE_BYTES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };

/** A TIFF block's byte order and its IFD0 and EXIF IFD entries; null for anything that is not one. */
function tiffEntries(tiff: Uint8Array): { little: boolean; ifd0: Entry[]; exif: Entry[] } | null {
  if (tiff.length < 8) return null;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const little = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!little && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return null;
  if (view.getUint16(2, little) !== 42) return null;
  const ifd = (start: number) => {
    const entries: Entry[] = [];
    if (start + 2 > tiff.length) return entries;
    const n = view.getUint16(start, little);
    for (let i = 0; i < n; i++) {
      const at = start + 2 + i * 12;
      if (at + 12 > tiff.length) break;
      const [tag, type, count] = [view.getUint16(at, little), view.getUint16(at + 2, little), view.getUint32(at + 4, little)];
      const length = (TYPE_BYTES[type] ?? 0) * count;
      const from = length <= 4 ? at + 8 : view.getUint32(at + 8, little);
      if (length === 0 || from + length > tiff.length) continue;
      entries.push({ tag, type, count, value: tiff.subarray(from, from + length) });
    }
    return entries;
  };
  const ifd0 = ifd(view.getUint32(4, little));
  const pointer = ifd0.find((e) => e.tag === TAGS.exifIfd && e.value.length === 4);
  const exif = pointer ? ifd(new DataView(pointer.value.buffer, pointer.value.byteOffset, 4).getUint32(0, little)) : [];
  return { little, ifd0, exif };
}

/** IFD0's artist, copyright and description, and the EXIF IFD's original date and its offset. */
function fromTiff(tiff: Uint8Array): Facts {
  const read = tiffEntries(tiff);
  if (!read) return {};
  const value = (entries: Entry[], tag: number, max: number) => {
    const entry = entries.find((e) => e.tag === tag && e.type === 2);
    return entry ? text(new TextDecoder().decode(entry.value), max) : undefined;
  };
  return {
    creator: value(read.ifd0, TAGS.artist, 300),
    copyright: value(read.ifd0, TAGS.copyright, 300),
    caption: value(read.ifd0, TAGS.description, 2000),
    takenAt: exifDate(value(read.exif, TAGS.taken, 40), value(read.exif, TAGS.offset, 10)),
  };
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

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unxml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e] ?? m),
  );

/**
 * One property of an XMP packet, written as an attribute or as an element: a plain value, a URL as rdf:resource, or an
 * rdf:Alt, Seq or Bag (the x-default entry of an Alt; every entry of a Seq or Bag, joined with commas, as dc:creator lists
 * its creators). A regex reader, not an XML parser: it reads the few properties below and nothing else.
 */
function xmpValue(xmp: string, name: string): string | undefined {
  const attribute = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(xmp);
  if (attribute) return unxml(attribute[1] ?? attribute[2] ?? "");
  const element = new RegExp(`<${name}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${name}\\s*>)`).exec(xmp);
  if (!element) return undefined;
  const resource = /rdf:resource\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(element[1] ?? "");
  if (resource) return unxml(resource[1] ?? resource[2] ?? "");
  const inner = element[2] ?? "";
  const items = [...inner.matchAll(/<rdf:li\b([^>]*)>([\s\S]*?)<\/rdf:li>/g)];
  const plain = (s: string) => unxml(s.replace(/<[^>]+>/g, "")).trim();
  if (items.length === 0) return plain(inner);
  if (/<rdf:Alt\b/.test(inner)) return plain((items.find((i) => /xml:lang\s*=\s*["']x-default/.test(i[1]!)) ?? items[0]!)[2]!);
  return items.map((i) => plain(i[2]!)).filter(Boolean).join(", ");
}

/** The IPTC Photo Metadata properties in XMP: Dublin Core, Photoshop, XMP Rights and PLUS. */
function fromXmp(xmp: string): Facts {
  const created = xmpValue(xmp, "exif:DateTimeOriginal") ?? xmpValue(xmp, "photoshop:DateCreated");
  return {
    creator: text(xmpValue(xmp, "dc:creator"), 300),
    creditLine: text(xmpValue(xmp, "photoshop:Credit"), 300),
    copyright: text(xmpValue(xmp, "dc:rights"), 300),
    terms: text(xmpValue(xmp, "xmpRights:UsageTerms"), 300),
    licenseUrl: address(xmpValue(xmp, "xmpRights:WebStatement")),
    acquireLicenseUrl: address(xmpValue(xmp, "plus:LicensorURL")),
    caption: text(xmpValue(xmp, "dc:description"), 2000),
    takenAt: created && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.test(created) ? created : undefined,
  };
}

/**
 * The IPTC IIM in a JPEG's Photoshop segment (its 8BIM resource 0x0404): By-line (2:80), Credit (2:110), Copyright Notice
 * (2:116) and Caption (2:120), as UTF-8.
 */
function fromIptc(resources: Uint8Array): Facts {
  const found = new Map<number, string[]>();
  let at = 0;
  while (at + 12 <= resources.length && ascii(resources, at, 4) === "8BIM") {
    const id = (resources[at + 4]! << 8) | resources[at + 5]!;
    // A Pascal string name, its length byte included, padded to an even size.
    const sizeAt = at + 6 + ((resources[at + 6]! + 2) & ~1);
    const size = u32be(resources, sizeAt);
    const data = resources.subarray(sizeAt + 4, sizeAt + 4 + size);
    for (let i = 0; id === 0x0404 && i + 5 <= data.length && data[i] === 0x1c; ) {
      const length = (data[i + 3]! << 8) | data[i + 4]!;
      // An extended length (the top bit) is only for large binary data sets, never these.
      if (length & 0x8000) break;
      if (data[i + 1] === 2) found.set(data[i + 2]!, [...(found.get(data[i + 2]!) ?? []), utf8(data.subarray(i + 5, i + 5 + length))]);
      i += 5 + length;
    }
    at = sizeAt + 4 + size + (size % 2);
  }
  return {
    creator: text(found.get(80)?.join(", "), 300),
    creditLine: text(found.get(110)?.[0], 300),
    copyright: text(found.get(116)?.[0], 300),
    caption: text(found.get(120)?.[0], 2000),
  };
}

// ---------- Private metadata

/** IFD0 tags a cleaned file keeps: description, orientation, resolution, chroma siting, artist and copyright. */
const KEEP_IFD0 = new Set([TAGS.description, 0x0112, 0x011a, 0x011b, 0x0128, 0x0213, TAGS.artist, TAGS.copyright]);
/** EXIF IFD tags it keeps: the EXIF version and the color space. */
const KEEP_EXIF = new Set([0x9000, 0xa001]);

/**
 * A TIFF block with only the tags above, in the original byte order: no location, no camera or lens serial number, no
 * owner's name, no MakerNote, no dates, no thumbnail (IFD1, whose own metadata would stay otherwise). Null for none of them.
 */
function keptTiff(tiff: Uint8Array): Uint8Array | null {
  const read = tiffEntries(tiff);
  if (!read) return null;
  const exif = read.exif.filter((e) => KEEP_EXIF.has(e.tag));
  const ifd0 = read.ifd0.filter((e) => KEEP_IFD0.has(e.tag));
  if (ifd0.length === 0) return null;
  if (exif.length > 0) ifd0.push({ tag: TAGS.exifIfd, type: 4, count: 1, value: new Uint8Array(4) });
  ifd0.sort((a, b) => a.tag - b.tag);

  const little = read.little;
  const outside = (entries: Entry[]) => entries.reduce((sum, e) => sum + (e.value.length > 4 ? (e.value.length + 1) & ~1 : 0), 0);
  const size = (entries: Entry[]) => 2 + entries.length * 12 + 4;
  const exifAt = 8 + size(ifd0) + outside(ifd0);
  const out = new Uint8Array(exifAt + (exif.length > 0 ? size(exif) + outside(exif) : 0));
  const view = new DataView(out.buffer);
  out.set(little ? [0x49, 0x49, 42, 0] : [0x4d, 0x4d, 0, 42]);
  view.setUint32(4, 8, little);
  const write = (at: number, entries: Entry[]) => {
    view.setUint16(at, entries.length, little);
    let values = at + size(entries);
    entries.forEach((e, i) => {
      const p = at + 2 + i * 12;
      view.setUint16(p, e.tag, little);
      view.setUint16(p + 2, e.type, little);
      view.setUint32(p + 4, e.count, little);
      if (e.tag === TAGS.exifIfd) view.setUint32(p + 8, exifAt, little);
      else if (e.value.length <= 4) out.set(e.value, p + 8);
      else {
        view.setUint32(p + 8, values, little);
        out.set(e.value, values);
        values += (e.value.length + 1) & ~1;
      }
    });
  };
  write(8, ifd0);
  if (exif.length > 0) write(exifAt, exif);
  return out;
}

/**
 * A fresh XMP packet holding only who made the picture and its terms, in the IPTC Photo Metadata properties Google Images
 * reads for its credit and Licensable badge; null when there is none of them.
 */
function xmpPacket(f: Facts): Uint8Array | null {
  const alt = (v: string) => `<rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(v)}</rdf:li></rdf:Alt>`;
  const props = [
    f.creator && `<dc:creator><rdf:Seq><rdf:li>${escapeXml(f.creator)}</rdf:li></rdf:Seq></dc:creator>`,
    f.copyright && `<dc:rights>${alt(f.copyright)}</dc:rights>`,
    f.caption && `<dc:description>${alt(f.caption)}</dc:description>`,
    f.creditLine && `<photoshop:Credit>${escapeXml(f.creditLine)}</photoshop:Credit>`,
    f.terms && `<xmpRights:UsageTerms>${alt(f.terms)}</xmpRights:UsageTerms>`,
    f.licenseUrl && `<xmpRights:WebStatement>${escapeXml(f.licenseUrl)}</xmpRights:WebStatement>`,
    f.acquireLicenseUrl &&
      `<plus:Licensor><rdf:Seq><rdf:li rdf:parseType="Resource"><plus:LicensorURL>${escapeXml(f.acquireLicenseUrl)}</plus:LicensorURL></rdf:li></rdf:Seq></plus:Licensor>`,
  ].filter(Boolean);
  if (props.length === 0) return null;
  const body = props.join("");
  // Only the namespaces used, and no xpacket wrapper (optional in XMP), so a packet fits where a HEIF's old one lay.
  const namespaces = Object.entries(XMP_NAMESPACES)
    .filter(([prefix]) => body.includes(`<${prefix}:`))
    .map(([prefix, uri]) => ` xmlns:${prefix}="${uri}"`)
    .join("");
  return new TextEncoder().encode(
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""${namespaces}>${body}</rdf:Description></rdf:RDF></x:xmpmeta>`,
  );
}

const XMP_NAMESPACES = {
  dc: "http://purl.org/dc/elements/1.1/",
  photoshop: "http://ns.adobe.com/photoshop/1.0/",
  xmpRights: "http://ns.adobe.com/xap/1.0/rights/",
  plus: "http://ns.useplus.org/ldf/xmp/1.0/",
};

/** The XMP a cleaned file keeps: written only where the file had XMP or IPTC, which the clean removes. */
const freshXmp = (blocks: Blocks) => (blocks.xmp !== null || blocks.iptc !== null ? xmpPacket(factsOf(blocks)) : null);

const bytesOf = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * The picture without its private metadata (v0.19.0; v0.15.0's stripLocation took out only the location): no GPS, camera
 * or lens serial number, owner's name, MakerNote, dates, thumbnail, IPTC, editing history or vendor block. Kept: the
 * orientation, the color profile (ICC, sRGB, gamma, CICP, the color space), the resolution, a JPEG's Adobe color transform,
 * a WebP's or PNG's animation, and who made it and its terms (EXIF artist and copyright, and a fresh XMP of the IPTC
 * credit, creator, copyright, usage terms and license addresses where the file had XMP or IPTC). Lossless: no pixel is
 * decoded or re-encoded. A JPEG keeps its first picture only, so a phone's appended images (an MPF gain or depth map, with
 * their own metadata) go. A HEIC, HEIF or AVIF is cleaned in place, its item offsets kept: the Exif item rewritten and
 * padded with zeros, the XMP item rewritten and padded with spaces. Bytes with nothing private, of another type or too
 * malformed to walk come back as the same array; a changed file is a new one, and the input is never written to.
 */
export function stripMetadata(bytes: Uint8Array, contentType: string): Uint8Array {
  try {
    const out = contentType === "image/jpeg" ? cleanJpeg(bytes) : contentType === "image/png" ? cleanPng(bytes) : contentType === "image/webp" ? cleanWebp(bytes) : HEIF.has(contentType) ? cleanHeif(bytes) : bytes;
    return same(out, bytes) ? bytes : out;
  } catch {
    // A block too malformed to walk is left as it came, as readEmbedded leaves it unread.
    return bytes;
  }
}

/** @deprecated v0.19.0: stripMetadata, which takes out every private field, not only the location. */
export const stripLocation = stripMetadata;

const jpegSegment = (marker: number, data: Uint8Array) => concat([new Uint8Array([0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 0xff]), data]);

/** Where a JPEG's first picture ends, after its EOI, from the start of its first scan; the file's end where it has none. */
function jpegEnd(b: Uint8Array, scan: number): number {
  let at = scan;
  while (at + 3 < b.length) {
    if (b[at] !== 0xff) {
      at += 1;
      continue;
    }
    const marker = b[at + 1]!;
    if (marker === 0xd9) return at + 2;
    // Stuffed bytes, restart markers and fill bytes lie inside the entropy-coded data; any other marker is a segment.
    if (marker === 0x00 || marker === 0xff || (marker >= 0xd0 && marker <= 0xd7)) at += marker === 0xff ? 1 : 2;
    else at += 2 + ((b[at + 2]! << 8) | b[at + 3]!);
  }
  return b.length;
}

/** Kept: JFIF, a new EXIF, the ICC profile, Adobe's color transform and every segment that is not metadata (tables, frame). */
function cleanJpeg(b: Uint8Array): Uint8Array {
  if (b[0] !== 0xff || b[1] !== 0xd8) return b;
  const { segments, scan } = jpegSegments(b);
  if (scan >= b.length) return b;
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let xmpAt = 1;
  for (const s of segments) {
    if (isExif(s)) {
      const tiff = keptTiff(s.data.subarray(6));
      if (tiff) xmpAt = parts.push(jpegSegment(0xe1, concat([bytesOf(EXIF_JPEG), tiff])));
    } else if (s.marker === 0xe0 && ascii(s.data, 0, 5) === "JFIF\u0000") {
      xmpAt = parts.push(b.subarray(s.at, s.end));
    } else if ((s.marker === 0xe2 && ascii(s.data, 0, 12) === "ICC_PROFILE\u0000") || s.marker === 0xee || s.marker < 0xe0) {
      parts.push(b.subarray(s.at, s.end));
    }
  }
  const xmp = freshXmp(jpegBlocks(b));
  if (xmp) parts.splice(xmpAt, 0, jpegSegment(0xe1, concat([bytesOf(XMP_JPEG), xmp])));
  parts.push(b.subarray(scan, jpegEnd(b, scan)));
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

/** The PNG chunks a cleaned file keeps: the picture, its color, its size on paper and its animation (APNG). */
const PNG_KEPT = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS", "cHRM", "gAMA", "iCCP", "sBIT", "sRGB", "cICP", "mDCv", "cLLi", "bKGD", "hIST", "pHYs", "sPLT", "acTL", "fcTL", "fdAT"]);
/** The text chunks it keeps, by keyword: the picture's title, author, copyright and description. */
const PNG_TEXT_KEPT = new Set(["Title", "Author", "Copyright", "Description"]);

function cleanPng(b: Uint8Array): Uint8Array {
  const chunks = pngChunks(b);
  // A file that does not walk to its IEND is not one the clean can rewrite.
  if (u32be(b, 0) !== 0x89504e47 || chunks.at(-1)?.type !== "IEND") return b;
  const parts: Uint8Array[] = [b.subarray(0, 8)];
  const xmp = freshXmp(pngBlocks(b));
  let wroteXmp = false;
  for (const c of chunks) {
    // The XMP goes before the picture data, as the PNG specification asks of eXIf too.
    if (xmp && !wroteXmp && (c.type === "IDAT" || c.type === "IEND")) {
      parts.push(pngChunk("iTXt", concat([bytesOf(XMP_PNG), new Uint8Array(5), xmp])));
      wroteXmp = true;
    }
    const keyword = pngText(c.type, c.data)?.keyword;
    if (c.type === "eXIf") {
      const tiff = keptTiff(c.data);
      if (tiff) parts.push(pngChunk("eXIf", tiff));
    } else if (keyword !== undefined ? PNG_TEXT_KEPT.has(keyword) : PNG_KEPT.has(c.type)) {
      parts.push(b.subarray(c.at, c.end));
    }
  }
  return concat(parts);
}

const RIFF_KEPT = new Set(["VP8X", "ICCP", "ANIM", "ANMF", "ALPH", "VP8 ", "VP8L"]);

function riffChunk(fourcc: string, data: Uint8Array): Uint8Array {
  const head = new Uint8Array(8);
  head.set(bytesOf(fourcc));
  new DataView(head.buffer).setUint32(4, data.length, true);
  return concat([head, data, new Uint8Array(data.length % 2)]);
}

/** Kept: the picture's chunks (VP8X, ICCP, ANIM, ANMF, ALPH, VP8, VP8L), then a new EXIF and XMP, flagged in VP8X. */
function cleanWebp(b: Uint8Array): Uint8Array {
  if (ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return b;
  const chunks = riffChunks(b);
  const exif = chunks.find((c) => c.fourcc === "EXIF");
  // Only an extended file (VP8X) holds metadata, and its flags say which.
  const extended = chunks[0]?.fourcc === "VP8X";
  const tiff = extended && exif ? keptTiff(tiffOf(exif.data)) : null;
  const xmp = extended ? freshXmp(webpBlocks(b)) : null;
  const parts: Uint8Array[] = [b.slice(0, 12)];
  for (const c of chunks) if (RIFF_KEPT.has(c.fourcc)) parts.push(c.fourcc === "VP8X" ? b.slice(c.at, c.end) : b.subarray(c.at, c.end));
  if (tiff) parts.push(riffChunk("EXIF", tiff));
  if (xmp) parts.push(riffChunk("XMP ", xmp));
  if (extended) parts[1]![8] = (parts[1]![8]! & ~0x0c) | (tiff ? 0x08 : 0) | (xmp ? 0x04 : 0);
  const out = concat(parts);
  // The RIFF size counts everything after its own eight bytes.
  new DataView(out.buffer).setUint32(4, out.length - 8, true);
  return out;
}

/** In place, so no item offset moves: the Exif item's TIFF rewritten and zero-padded, the XMP item rewritten and space-padded. */
function cleanHeif(b: Uint8Array): Uint8Array {
  const out = b.slice();
  const xmp = xmpPacket(factsOf(heifBlocks(b)));
  for (const item of heifItems(out)) {
    if (item.kind === "exif") {
      const region = heifTiff(item.data);
      const tiff = keptTiff(region);
      region.fill(0);
      if (tiff && tiff.length <= region.length) region.set(tiff);
    } else {
      item.data.fill(0x20);
      if (xmp && xmp.length <= item.data.length) item.data.set(xmp);
    }
  }
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

// ---------- File names

/** The words of a camera's, a phone's or a screenshot tool's own file name, which say nothing a search can use. */
const CAMERA_WORDS = new Set([
  "img", "image", "dsc", "dscn", "dscf", "dcim", "pxl", "mvimg", "mp", "photo", "pic", "picture", "screenshot", "screen", "shot",
  "whatsapp", "signal", "at", "am", "pm", "p", "gopr", "dji", "mg", "wp", "unnamed", "untitled", "download", "edited", "scaled",
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
  const camera = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}/i.test(stem) || stem.toLowerCase().split(/[^a-z]+/).every((w) => w === "" || CAMERA_WORDS.has(w));
  const slug = words
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^(?:an?|the)-/, "")
    .replace(/^-+|-+$/g, "");
  if (camera && slug) stem = slug.length > 60 ? slug.slice(0, slug.lastIndexOf("-", 60) > 20 ? slug.lastIndexOf("-", 60) : 60) : slug;
  const allowed = EXTENSIONS[contentType];
  return (allowed && !allowed.includes(ext) ? `${stem}.${allowed[0]}` : dot > 0 ? `${stem}.${filename.slice(dot + 1)}` : stem).slice(0, 200);
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
  /** The SHA-256 of the bytes as sent: the hash the package's route asked findByHash about. */
  uploadSha256: string;
  /** What the picture says about itself, read before anything changed it. The site fills each only where it is empty. */
  embedded: EmbeddedFields;
  /** True when a HEIC or HEIF upload was converted to JPEG. */
  converted: boolean;
  /** True when private metadata (a location, a serial number, a MakerNote, a thumbnail) was taken out without re-encoding (v0.19.0; was `located`). */
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
 * which applies the EXIF orientation and keeps only the copyright; the private metadata taken out of what is not
 * re-encoded (stripMetadata); a camera's file name made words (fileNameFor); the shrink to `resize.maxEdge` where the upload asked for it (site-runtime's editImage, in the
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
  const converted = CONVERTED.has(contentType);
  if (converted) {
    try {
      bytes = new Uint8Array(await (await editImage(images, toArrayBuffer(bytes), { format: "image/jpeg", quality })).arrayBuffer());
    } catch (error) {
      throw new RefusedError(`Cloudflare Images could not convert the picture to JPEG, so nothing was stored (${error instanceof Error ? error.message : String(error)}).`);
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
    stripped,
    placeholder,
    color,
    ...(resizedFrom ? { resizedFrom, original } : {}),
  };
}
