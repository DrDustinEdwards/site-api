import { ascii } from "../media.js";
import { u32be, utf8 } from "./bytes.js";
import { type Blocks, type EmbeddedFields, type Facts, NONE } from "./types.js";
import { HEIF, heifBlocks, jpegBlocks, pngBlocks, webpBlocks } from "./containers.js";

export const TAGS = {
  description: 0x010e,
  artist: 0x013b,
  copyright: 0x8298,
  exifIfd: 0x8769,
  taken: 0x9003,
  offset: 0x9011,
} as const;

/**
 * The fields from whichever metadata the file's type carries: a JPEG's EXIF, XMP and IPTC (APP13), a PNG's eXIf, XMP and
 * text chunks, a WebP's EXIF and XMP, and a HEIC's, a HEIF's or an AVIF's Exif and XMP items. Only these fields are read;
 * nothing else in the metadata (a camera's location, its serial number) is kept or passed on. {} for none or for anything
 * unreadable.
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
export function factsOf(blocks: Blocks): Facts {
  const found: Facts = {};
  for (const source of [
    safely(fromXmp, blocks.xmp),
    safely(fromIptc, blocks.iptc),
    fromPngText(blocks.text),
    safely(fromTiff, blocks.tiff),
  ]) {
    for (const [key, value] of Object.entries(source) as [keyof Facts, string | undefined][])
      if (value && !found[key]) found[key] = value;
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

function fromPngText(found: Record<string, string>): Facts {
  const created = found["Creation Time"] ? Date.parse(found["Creation Time"]) : Number.NaN;
  return {
    creator: text(found.Author, 300),
    copyright: text(found.Copyright, 300),
    caption: text(found.Description, 2000),
    takenAt: Number.isNaN(created) ? undefined : new Date(created).toISOString(),
  };
}

/** One TIFF directory entry: its tag, type, count and value bytes, wherever they lie. */
export type Entry = { tag: number; type: number; count: number; value: Uint8Array };

/** Bytes per value of each TIFF field type. */
const TYPE_BYTES: Record<number, number> = {
  1: 1,
  2: 1,
  3: 2,
  4: 4,
  5: 8,
  6: 1,
  7: 1,
  8: 2,
  9: 4,
  10: 8,
  11: 4,
  12: 8,
  13: 4,
};

/** A TIFF block's byte order and its IFD0 and EXIF IFD entries; null for anything that is not one. */
export function tiffEntries(
  tiff: Uint8Array,
): { little: boolean; ifd0: Entry[]; exif: Entry[] } | null {
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
      const [tag, type, count] = [
        view.getUint16(at, little),
        view.getUint16(at + 2, little),
        view.getUint32(at + 4, little),
      ];
      const length = (TYPE_BYTES[type] ?? 0) * count;
      const from = length <= 4 ? at + 8 : view.getUint32(at + 8, little);
      if (length === 0 || from + length > tiff.length) continue;
      entries.push({ tag, type, count, value: tiff.subarray(from, from + length) });
    }
    return entries;
  };
  const ifd0 = ifd(view.getUint32(4, little));
  const pointer = ifd0.find((e) => e.tag === TAGS.exifIfd && e.value.length === 4);
  const exif = pointer
    ? ifd(new DataView(pointer.value.buffer, pointer.value.byteOffset, 4).getUint32(0, little))
    : [];
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

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};
const unxml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] !== "#") return ENTITIES[e] ?? m;
    const code =
      e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
    // A code point past U+10FFFF is no character, and fromCodePoint would throw and take the file's other facts with it.
    return code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });

/**
 * `s` without its tags, found by scanning. `/<[^>]+>/g` re-scans to the end from every `<` that has no `>` after it
 * (quadratic over a stranger's bytes: half a million `<` inside one property took minutes), so a `<` with no `>` left
 * ends the scan and the rest stays text. `<>` is not a tag.
 */
function stripTags(s: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const lt = s.indexOf("<", from);
    if (lt === -1) break;
    const gt = s.indexOf(">", lt + 1);
    if (gt === -1) break;
    out += s.slice(from, gt === lt + 1 ? gt + 1 : lt);
    from = gt + 1;
  }
  return out + s.slice(from);
}

/**
 * One property of an XMP packet, written as an attribute or as an element: a plain value, a URL as rdf:resource, or an
 * rdf:Alt, Seq or Bag (the x-default entry of an Alt; every entry of a Seq or Bag, joined with commas, as dc:creator lists
 * its creators). A regex reader, not an XML parser: it reads the few properties below and nothing else.
 */
function xmpValue(xmp: string, name: string): string | undefined {
  const attribute = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(xmp);
  if (attribute) return unxml(attribute[1] ?? attribute[2] ?? "");
  const element = xmpElement(xmp, name);
  if (!element) return undefined;
  const resource = /rdf:resource\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(element.attributes);
  if (resource) return unxml(resource[1] ?? resource[2] ?? "");
  const inner = element.inner;
  const items = listItems(inner);
  const plain = (s: string) => unxml(stripTags(s)).trim();
  if (items.length === 0) return plain(inner);
  if (/<rdf:Alt\b/.test(inner))
    return plain(
      (items.find((i) => /xml:lang\s*=\s*["']x-default/.test(i.attributes)) ?? items[0]!).text,
    );
  return items
    .map((i) => plain(i.text))
    .filter(Boolean)
    .join(", ");
}

/**
 * The first `<name ...>...</name>` (or self-closing `<name .../>`) of a packet, found by scanning, one pass over the text.
 * A packet is a stranger's bytes: a lazy regex over it re-scans to the end from every opening tag that has no closing one
 * (quadratic), and many openings fit in a few hundred KB.
 */
function xmpElement(xmp: string, name: string): { attributes: string; inner: string } | undefined {
  const open = `<${name}`;
  const close = `</${name}`;
  for (let from = 0; ;) {
    const at = xmp.indexOf(open, from);
    if (at === -1) return undefined;
    from = at + open.length;
    // The name ends here: a longer name that starts with it is another element.
    if (/\w/.test(xmp[from] ?? "")) continue;
    const gt = xmp.indexOf(">", from);
    if (gt === -1) return undefined;
    const attributes = xmp.slice(from, gt);
    if (attributes.endsWith("/")) return { attributes: attributes.slice(0, -1), inner: "" };
    for (let end = xmp.indexOf(close, gt + 1); end !== -1; end = xmp.indexOf(close, end + 1)) {
      const after = /^\s*>/.exec(xmp.slice(end + close.length, end + close.length + 64));
      if (after) return { attributes, inner: xmp.slice(gt + 1, end) };
    }
    // No closing tag after this opening, so none after a later one either.
    return undefined;
  }
}

/** The `<rdf:li>` items of an element's contents, found by scanning (see xmpElement). */
function listItems(inner: string): { attributes: string; text: string }[] {
  const items = [];
  for (let from = 0; ;) {
    const at = inner.indexOf("<rdf:li", from);
    if (at === -1) break;
    from = at + 7;
    if (/\w/.test(inner[from] ?? "")) continue;
    const gt = inner.indexOf(">", from);
    if (gt === -1) break;
    const end = inner.indexOf("</rdf:li>", gt + 1);
    if (end === -1) break;
    items.push({ attributes: inner.slice(from, gt), text: inner.slice(gt + 1, end) });
    from = end + 9;
  }
  return items;
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
    takenAt:
      created &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/.test(created)
        ? created
        : undefined,
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
    for (let i = 0; id === 0x0404 && i + 5 <= data.length && data[i] === 0x1c;) {
      const length = (data[i + 3]! << 8) | data[i + 4]!;
      // An extended length (the top bit) is only for large binary data sets, never these.
      if (length & 0x8000) break;
      if (data[i + 1] === 2) {
        const values = found.get(data[i + 2]!) ?? [];
        values.push(utf8(data.subarray(i + 5, i + 5 + length)));
        found.set(data[i + 2]!, values);
      }
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
