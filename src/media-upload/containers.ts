import { ascii } from "../media.js";
import { u32be, u32le, utf8 } from "./bytes.js";
import { type Blocks, NONE } from "./types.js";

/** One JPEG metadata segment: its marker, where it starts and ends, and its data after the length. */
export type Segment = { marker: number; at: number; end: number; data: Uint8Array };

/** The segments before the first scan, and where that scan starts (b.length when there is none). */
export function jpegSegments(b: Uint8Array): { segments: Segment[]; scan: number } {
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

export const EXIF_JPEG = "Exif\u0000\u0000";
export const XMP_JPEG = "http://ns.adobe.com/xap/1.0/\u0000";
const IPTC_JPEG = "Photoshop 3.0\u0000";
export const XMP_PNG = "XML:com.adobe.xmp";

export const isExif = (s: Segment) => s.marker === 0xe1 && ascii(s.data, 0, 6) === EXIF_JPEG;
const isXmp = (s: Segment) => s.marker === 0xe1 && ascii(s.data, 0, XMP_JPEG.length) === XMP_JPEG;
const isIptc = (s: Segment) =>
  s.marker === 0xed && ascii(s.data, 0, IPTC_JPEG.length) === IPTC_JPEG;

export function jpegBlocks(b: Uint8Array): Blocks {
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
export function riffChunks(
  b: Uint8Array,
): { fourcc: string; at: number; end: number; data: Uint8Array }[] {
  const chunks = [];
  let at = 12;
  while (at + 8 <= b.length) {
    const size = u32le(b, at + 4);
    const end = Math.min(at + 8 + size + (size % 2), b.length);
    chunks.push({
      fourcc: ascii(b, at, 4),
      at,
      end,
      data: b.subarray(at + 8, Math.min(at + 8 + size, b.length)),
    });
    at = end;
  }
  return chunks;
}

export function webpBlocks(b: Uint8Array): Blocks {
  if (ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WEBP") return NONE;
  const chunks = riffChunks(b);
  const exif = chunks.find((c) => c.fourcc === "EXIF");
  const xmp = chunks.find((c) => c.fourcc === "XMP ");
  return {
    tiff: exif ? tiffOf(exif.data) : null,
    xmp: xmp ? utf8(xmp.data) : null,
    iptc: null,
    text: {},
  };
}

/** Some writers keep the JPEG segment's "Exif\0\0" in front of the TIFF header. */
export const tiffOf = (data: Uint8Array) =>
  ascii(data, 0, 4) === "Exif" ? data.subarray(6) : data;

/** One PNG chunk: its type, where it starts and ends, and its data. */
export function pngChunks(
  b: Uint8Array,
): { type: string; at: number; end: number; data: Uint8Array }[] {
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
export function pngText(
  type: string,
  data: Uint8Array,
): { keyword: string; value?: string } | null {
  const nul = data.indexOf(0);
  if (nul < 1 || !["tEXt", "iTXt", "zTXt"].includes(type)) return null;
  const keyword = new TextDecoder("latin1").decode(data.subarray(0, nul));
  if (type === "tEXt")
    return { keyword, value: new TextDecoder("latin1").decode(data.subarray(nul + 1)) };
  if (type === "zTXt" || data[nul + 1] !== 0) return { keyword };
  // Keyword, compression flag and method, language tag, translated keyword, then the text.
  const lang = data.indexOf(0, nul + 3);
  const translated = lang === -1 ? -1 : data.indexOf(0, lang + 1);
  return translated === -1 ? { keyword } : { keyword, value: utf8(data.subarray(translated + 1)) };
}

export function pngBlocks(b: Uint8Array): Blocks {
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

export const HEIF = new Set(["image/heic", "image/heif", "image/avif"]);

/** One metadata item of a HEIF file (ISO/IEC 23008-12): an Exif item or an XMP one, and where its bytes lie. */
export type HeifItem = { kind: "exif" | "xmp"; data: Uint8Array };

/**
 * The Exif and XMP (a `mime` item of type application/rdf+xml) items of a HEIC, a HEIF or an AVIF: named in the meta
 * box's iinf, found at their iloc extent, in the file (construction method 0) or in the meta box's idat (method 1).
 */
export function heifItems(b: Uint8Array): HeifItem[] {
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
    const id =
      version === 2 ? (b[infe.start + 4]! << 8) | b[infe.start + 5]! : u32be(b, infe.start + 4);
    const typeAt = infe.start + 4 + (version === 2 ? 2 : 4) + 2;
    const type = ascii(b, typeAt, 4);
    // A mime item: its name, then its content type, each ending in NUL.
    const nameEnd = b.indexOf(0, typeAt + 4);
    const mime =
      nameEnd === -1
        ? ""
        : ascii(b, nameEnd + 1, Math.max(0, b.indexOf(0, nameEnd + 1) - nameEnd - 1));
    if (type === "Exif") kinds.set(id, "exif");
    else if (type === "mime" && mime === "application/rdf+xml") kinds.set(id, "xmp");
  }
  if (kinds.size === 0) return [];

  const version = b[iloc.start]!;
  let at = iloc.start + 4;
  const [offsetSize, lengthSize, baseSize, indexSize] = [
    b[at]! >> 4,
    b[at]! & 15,
    b[at + 1]! >> 4,
    version > 0 ? b[at + 1]! & 15 : 0,
  ];
  at += 2;
  const read = (size: number) => {
    const value =
      size === 8
        ? u32be(b, at) * 2 ** 32 + u32be(b, at + 4)
        : size === 4
          ? u32be(b, at)
          : size === 2
            ? (b[at]! << 8) | b[at + 1]!
            : 0;
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
    // Only the first extent is used. The rest are stepped over by arithmetic: a loop of up to 65,535 reads per item, over
    // fields of size 0 that never move `at`, was a few million operations per few bytes of file.
    let first: { offset: number; length: number } | undefined;
    if (extents > 0) {
      if (version > 0) read(indexSize);
      const offset = read(offsetSize);
      const length = read(lengthSize);
      first = { offset, length };
      at += ((version > 0 ? indexSize : 0) + offsetSize + lengthSize) * (extents - 1);
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
export const heifTiff = (data: Uint8Array) => data.subarray(4 + u32be(data, 0));

export function heifBlocks(b: Uint8Array): Blocks {
  const items = heifItems(b);
  const exif = items.find((i) => i.kind === "exif");
  const xmp = items.find((i) => i.kind === "xmp");
  return {
    tiff: exif ? heifTiff(exif.data) : null,
    xmp: xmp ? utf8(xmp.data) : null,
    iptc: null,
    text: {},
  };
}

/** The boxes between two offsets: each one's type and where its contents start and end. */
function boxes(
  b: Uint8Array,
  from: number,
  to: number,
): { type: string; start: number; end: number }[] {
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
