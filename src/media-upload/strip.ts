import { escapeXml } from "@drdustinedwards/site-helpers/xml";
import { crc32, sha256Hex } from "@dustinedwards/site-runtime/encoding";

import { ascii } from "../media.js";
import { concatBytes } from "@dustinedwards/site-runtime/encoding";
import { bytesOf, same, u32be } from "./bytes.js";
import { type Blocks, type Facts } from "./types.js";
import { type Entry, TAGS, factsOf, tiffEntries } from "./fields.js";
import {
  EXIF_JPEG,
  HEIF,
  XMP_JPEG,
  XMP_PNG,
  heifBlocks,
  heifItems,
  heifTiff,
  isExif,
  jpegBlocks,
  jpegSegments,
  pngBlocks,
  pngChunks,
  pngText,
  riffChunks,
  tiffOf,
  webpBlocks,
} from "./containers.js";

/** IFD0 tags a cleaned file keeps: description, orientation, resolution, chroma siting, artist and copyright. */
const KEEP_IFD0 = new Set([
  TAGS.description,
  0x0112,
  0x011a,
  0x011b,
  0x0128,
  0x0213,
  TAGS.artist,
  TAGS.copyright,
]);
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
  if (exif.length > 0)
    ifd0.push({ tag: TAGS.exifIfd, type: 4, count: 1, value: new Uint8Array(4) });
  ifd0.sort((a, b) => a.tag - b.tag);

  const little = read.little;
  const outside = (entries: Entry[]) =>
    entries.reduce((sum, e) => sum + (e.value.length > 4 ? (e.value.length + 1) & ~1 : 0), 0);
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
  const alt = (v: string) =>
    `<rdf:Alt><rdf:li xml:lang="x-default">${escapeXml(v)}</rdf:li></rdf:Alt>`;
  const props = [
    f.creator &&
      `<dc:creator><rdf:Seq><rdf:li>${escapeXml(f.creator)}</rdf:li></rdf:Seq></dc:creator>`,
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
const freshXmp = (blocks: Blocks) =>
  blocks.xmp !== null || blocks.iptc !== null ? xmpPacket(factsOf(blocks)) : null;

/**
 * The picture without its private metadata (more than the location): no GPS, camera
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
    const out =
      contentType === "image/jpeg"
        ? cleanJpeg(bytes)
        : contentType === "image/png"
          ? cleanPng(bytes)
          : contentType === "image/webp"
            ? cleanWebp(bytes)
            : HEIF.has(contentType)
              ? cleanHeif(bytes)
              : bytes;
    return same(out, bytes) ? bytes : out;
  } catch {
    // A block too malformed to walk is left as it came, as readEmbedded leaves it unread.
    return bytes;
  }
}

/**
 * The key every site finds duplicates by: the SHA-256, as lower case hex, of the bytes as sent with their
 * private metadata taken out (stripMetadata). The same file sent twice has the same key, and so does a copy that differs
 * only in what stripMetadata takes out (a location, a serial number, a date), since the site would store the same bytes
 * for both. The package's route asks findByHash about it and sends it as `MediaUpload.sha256`; prepareUpload answers it
 * as `uploadSha256`, equal to the stored bytes' `sha256` unless the picture was converted or shrunk.
 */
export async function duplicateKey(bytes: Uint8Array, contentType: string): Promise<string> {
  return sha256Hex(stripMetadata(bytes, contentType));
}

const jpegSegment = (marker: number, data: Uint8Array) =>
  concatBytes(
    new Uint8Array([0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 0xff]),
    data,
  );

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
    if (marker === 0x00 || marker === 0xff || (marker >= 0xd0 && marker <= 0xd7))
      at += marker === 0xff ? 1 : 2;
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
      if (tiff) xmpAt = parts.push(jpegSegment(0xe1, concatBytes(bytesOf(EXIF_JPEG), tiff)));
    } else if (s.marker === 0xe0 && ascii(s.data, 0, 5) === "JFIF\u0000") {
      xmpAt = parts.push(b.subarray(s.at, s.end));
    } else if (
      (s.marker === 0xe2 && ascii(s.data, 0, 12) === "ICC_PROFILE\u0000") ||
      s.marker === 0xee ||
      s.marker < 0xe0
    ) {
      parts.push(b.subarray(s.at, s.end));
    }
  }
  const xmp = freshXmp(jpegBlocks(b));
  if (xmp) parts.splice(xmpAt, 0, jpegSegment(0xe1, concatBytes(bytesOf(XMP_JPEG), xmp)));
  parts.push(b.subarray(scan, jpegEnd(b, scan)));
  return concatBytes(...parts);
}

/** One PNG chunk: its length, type, data and the CRC-32 of the type and data. */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(bytesOf(type), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

/** The PNG chunks a cleaned file keeps: the picture, its color, its size on paper and its animation (APNG). */
const PNG_KEPT = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "cHRM",
  "gAMA",
  "iCCP",
  "sBIT",
  "sRGB",
  "cICP",
  "mDCv",
  "cLLi",
  "bKGD",
  "hIST",
  "pHYs",
  "sPLT",
  "acTL",
  "fcTL",
  "fdAT",
]);
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
      parts.push(pngChunk("iTXt", concatBytes(bytesOf(XMP_PNG), new Uint8Array(5), xmp)));
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
  return concatBytes(...parts);
}

const RIFF_KEPT = new Set(["VP8X", "ICCP", "ANIM", "ANMF", "ALPH", "VP8 ", "VP8L"]);

function riffChunk(fourcc: string, data: Uint8Array): Uint8Array {
  const head = new Uint8Array(8);
  head.set(bytesOf(fourcc));
  new DataView(head.buffer).setUint32(4, data.length, true);
  return concatBytes(head, data, new Uint8Array(data.length % 2));
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
  for (const c of chunks)
    if (RIFF_KEPT.has(c.fourcc))
      parts.push(c.fourcc === "VP8X" ? b.slice(c.at, c.end) : b.subarray(c.at, c.end));
  if (tiff) parts.push(riffChunk("EXIF", tiff));
  if (xmp) parts.push(riffChunk("XMP ", xmp));
  if (extended) parts[1]![8] = (parts[1]![8]! & ~0x0c) | (tiff ? 0x08 : 0) | (xmp ? 0x04 : 0);
  const out = concatBytes(...parts);
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
