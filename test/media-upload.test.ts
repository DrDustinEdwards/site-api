// The upload step (v0.15.0): the parts a mistake in would ship silently. A location left in a photo is published with
// it, and a strip that broke a file's offsets or checksums would store a picture no browser opens; a HEIC must reach the
// site as a JPEG of the size it asked for, with a placeholder and a main color read from the binding's one-pixel PNG.

import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { toArrayBuffer } from "../src/media-kit.js";
import { prepareUpload, readEmbedded, stripLocation, type UploadImages } from "../src/media-upload.js";

/**
 * A big-endian TIFF block: IFD0 with orientation 6, a copyright and a GPS pointer, then the GPS IFD with a latitude
 * reference (inline) and the latitude (three rationals at 88).
 */
function gpsTiff(): Uint8Array {
  const b = new Uint8Array(112);
  b.set([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 3]);
  b.set([0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0], 10);
  b.set([0x82, 0x98, 0, 2, 0, 0, 0, 8, 0, 0, 0, 50], 22);
  b.set([0x88, 0x25, 0, 4, 0, 0, 0, 1, 0, 0, 0, 58], 34);
  b.set(new TextEncoder().encode("Example"), 50);
  b.set([0, 2], 58);
  b.set([0, 1, 0, 2, 0, 0, 0, 2, 0x4e, 0, 0, 0], 60);
  b.set([0, 2, 0, 5, 0, 0, 0, 3, 0, 0, 0, 88], 72);
  b.set([0, 0, 0, 30, 0, 0, 0, 1, 0, 0, 0, 15, 0, 0, 0, 1, 0, 0, 0, 7, 0, 0, 0, 1], 88);
  return b;
}

const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const cat = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const XMP = '<x:xmpmeta><rdf:Description exif:GPSLatitude="30,15.1N" dc:format="image/jpeg"><exif:GPSLongitude>97,44.2W</exif:GPSLongitude></rdf:Description></x:xmpmeta>';

function jpeg(): Uint8Array {
  const exif = cat(bytes("Exif\0\0"), gpsTiff());
  const xmp = cat(bytes("http://ns.adobe.com/xap/1.0/\0"), bytes(XMP));
  const segment = (marker: number, data: Uint8Array) => cat(new Uint8Array([0xff, marker, (data.length + 2) >> 8, (data.length + 2) & 0xff]), data);
  return cat(new Uint8Array([0xff, 0xd8]), segment(0xe1, exif), segment(0xe1, xmp), segment(0xe2, bytes("ICC_PROFILE\0fake")), new Uint8Array([0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]));
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const head = new Uint8Array(8);
  new DataView(head.buffer).setUint32(0, data.length);
  head.set(bytes(type), 4);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(cat(bytes(type), data)));
  return cat(head, data, crc);
}

function png(): Uint8Array {
  return cat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", new Uint8Array(13)), pngChunk("eXIf", gpsTiff()), pngChunk("IDAT", new Uint8Array(4)), pngChunk("IEND", new Uint8Array()));
}

function webp(): Uint8Array {
  const chunk = (fourcc: string, data: Uint8Array) => {
    const head = new Uint8Array(8);
    head.set(bytes(fourcc));
    new DataView(head.buffer).setUint32(4, data.length, true);
    return cat(head, data, new Uint8Array(data.length % 2));
  };
  const body = cat(bytes("WEBP"), chunk("VP8X", new Uint8Array(10)), chunk("EXIF", gpsTiff()), chunk("XMP ", bytes(XMP)));
  const head = new Uint8Array(8);
  head.set(bytes("RIFF"));
  new DataView(head.buffer).setUint32(4, body.length, true);
  return cat(head, body);
}

/** True when the bytes still hold the GPS pointer tag, the latitude's values or an XMP GPS property. */
const located = (b: Uint8Array) => {
  const s = String.fromCharCode(...b);
  return s.includes("\x88\x25\0\x04") || s.includes("\0\0\0\x1e\0\0\0\x01\0\0\0\x0f") || s.includes("GPS");
};

describe("stripLocation", () => {
  it("takes GPS out of a JPEG, a PNG and a WebP, keeping orientation, copyright, the color profile and each format's framing", () => {
    for (const [type, file] of [
      ["image/jpeg", jpeg()],
      ["image/png", png()],
      ["image/webp", webp()],
    ] as const) {
      expect(located(file)).toBe(true);
      const out = stripLocation(file, type);
      expect(located(out), type).toBe(false);
      // Orientation 6 and the copyright are still read where they were.
      expect(String.fromCharCode(...out)).toContain("\x01\x12\0\x03\0\0\0\x01\0\x06");
      expect(readEmbedded(out, type).license).toBe("Example");
      // Nothing else is touched, and the input is never written to.
      expect(located(file)).toBe(true);
      expect(stripLocation(out, type)).toBe(out);
    }

    const j = stripLocation(jpeg(), "image/jpeg");
    // Every segment's length still lands on the next marker, and the profile and the scan are as they were.
    let at = 2;
    while (j[at + 1] !== 0xda) at += 2 + ((j[at + 2]! << 8) | j[at + 3]!);
    expect(String.fromCharCode(...j.subarray(at - 16, at))).toBe("ICC_PROFILE\0fake");
    expect([...j.subarray(at)]).toEqual([0xff, 0xda, 0, 2, 1, 2, 3, 0xff, 0xd9]);
    expect(String.fromCharCode(...j)).toContain('dc:format="image/jpeg"');

    const p = stripLocation(png(), "image/png");
    const exifAt = String.fromCharCode(...p).indexOf("eXIf") - 4;
    const length = new DataView(p.buffer).getUint32(exifAt);
    expect(new DataView(p.buffer).getUint32(exifAt + 8 + length)).toBe(crc32(p.subarray(exifAt + 4, exifAt + 8 + length)));

    const w = stripLocation(webp(), "image/webp");
    expect(new DataView(w.buffer).getUint32(4, true)).toBe(w.length - 8);
  });
});

describe("prepareUpload", () => {
  it("stores a HEIC as a JPEG, shrunk to the site's longest edge", async () => {
    const heic = cat(new Uint8Array([0, 0, 0, 24]), bytes("ftypheic\0\0\0\0mif1heic"));
    const ihdr = new Uint8Array(13);
    ihdr.set([0, 0, 0, 1, 0, 0, 0, 1, 8, 6]);
    const pixel = cat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(new Uint8Array([4, 0x12, 0xab, 0xcd, 0xff]))), pngChunk("IEND", new Uint8Array()));
    const transforms: object[] = [];
    const outputs: string[] = [];
    let call = 0;
    const output = async ({ format }: { format: string }) => {
      outputs.push(format);
      // The placeholder's WebP is any bytes here; the pixel is RGBA under the Paeth filter, which predicts zero.
      const out = format === "image/png" ? pixel : format === "image/webp" ? bytes("RIFF\0\0\0\0WEBPVP8 ") : jpeg();
      return { response: () => new Response(toArrayBuffer(out)) };
    };
    const images: UploadImages = {
      info: async () => [{ width: 6000, height: 4000 }, { width: 3000, height: 2000 }][call++] ?? {},
      input: () => ({
        output,
        transform: (options) => {
          transforms.push(options);
          return { output };
        },
      }),
    };
    const prepared = await prepareUpload(images, { bytes: heic, contentType: "image/heic", filename: "IMG_0001.HEIC", alt: "", changeId: "c-1", resize: true }, { resize: { maxEdge: 3000, quality: 85 } });
    expect(prepared).toMatchObject({ contentType: "image/jpeg", filename: "IMG_0001.jpg", converted: true, width: 3000, height: 2000, resizedFrom: { width: 6000, height: 4000 } });
    expect(prepared).toMatchObject({ placeholder: `data:image/webp;base64,${btoa("RIFF\0\0\0\0WEBPVP8 ")}`, color: "#12abcd" });
    expect(transforms).toEqual([{ width: 3000, height: 3000, fit: "scale-down" }, { width: 16, height: 16, fit: "scale-down", blur: 2 }, { width: 1, height: 1, fit: "squeeze" }]);
    expect(outputs).toEqual(["image/jpeg", "image/jpeg", "image/webp", "image/png"]);
    // The fake binding answers a JPEG that still has a location, which the real one drops: it is out of the copy kept.
    expect(located(prepared.original!)).toBe(false);
    expect(prepared.sha256).not.toBe(prepared.uploadSha256);
  });
});
