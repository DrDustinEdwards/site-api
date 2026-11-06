// The upload step (v0.15.0, private metadata v0.19.0): the parts a mistake in would ship silently. A location, a serial
// number or an owner's name left in a photo is published with it, and a clean that broke a file's offsets or checksums
// would store a picture no browser opens; a HEIC must reach the site as a JPEG of the size it asked for, named in words.
//
// The fixtures are real files, 64x48, written by Pillow 13 and pillow-heif 1.8 (x265) with fake metadata: EXIF with
// orientation 6, an artist, a copyright, a camera, a serial number, an owner, a MakerNote, a date and GPS; an sRGB ICC
// profile (not in the HEIC); XMP with a GPS latitude, a serial number, dc:creator and a license address. photo.jpg also
// carries IPTC (a credit line, a copyright notice, a city, a contact email) and a second picture after its EOI with its
// own "GPS", as a phone's MPF image does. Each cleaned file was checked to decode in ImageMagick 6 and Pillow 13 with its
// orientation, profile and credit.

import { crc32, deflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toArrayBuffer } from "../src/media-kit.js";
import { prepareUpload, readEmbedded, stripMetadata, type UploadImages } from "../src/media-upload.js";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const latin = (b: Uint8Array) => Buffer.from(b).toString("latin1");

/** Each fixture, its type, and what must stay beside the picture: its ICC profile, or the HEIC's (which has none) codec setup. */
const FILES = [
  ["photo.jpg", "image/jpeg", "ICC_PROFILE"],
  ["photo.png", "image/png", "iCCP"],
  ["photo.webp", "image/webp", "ICCP"],
  ["photo.avif", "image/avif", "prof"],
  ["phone.heic", "image/heic", "hvcC"],
] as const;

/** What no stored original may carry: the location, the camera, its serial number, its owner, its MakerNote, the date, IPTC's city and contact. */
const PRIVATE = ["GPS", "ExampleCam", "SN-SAMPLE", "Sample Owner", "SAMPLEMAKERNOTE", "2026:05:01", "Sample City", "sample@example.com"];

describe("stripMetadata", () => {
  it("takes every private field out of a real JPEG, PNG, WebP, AVIF and HEIC, keeping orientation, the color profile and the credit", () => {
    for (const [name, type, kept] of FILES) {
      const file = fixture(name);
      expect(PRIVATE.filter((p) => latin(file).includes(p)).length, name).toBeGreaterThan(3);
      const out = stripMetadata(file, type);
      expect(PRIVATE.filter((p) => latin(out).includes(p)), name).toEqual([]);
      // Orientation 6 (big-endian, as Pillow writes it; a HEIF's is its irot box, which the clean never touches), the
      // profile and who made it stay.
      expect(latin(out), name).toContain(type === "image/avif" || type === "image/heic" ? "irot" : "\x01\x12\0\x03\0\0\0\x01\0\x06");
      expect(latin(out), name).toContain(kept);
      expect(readEmbedded(out, type), name).toMatchObject({ credit: expect.stringContaining("Ada Example"), licenseUrl: "https://example.com/license" });
      // A clean file is left as it is, and the input is never written to.
      expect(stripMetadata(out, type), name).toBe(out);
      expect(latin(file)).toContain("GPS");
    }

    // A HEIF's items keep their offsets: the clean is in place.
    for (const name of ["photo.avif", "phone.heic"]) expect(stripMetadata(fixture(name), "image/avif").length).toBe(fixture(name).length);
    // Every PNG chunk's CRC is right, and the WebP's RIFF size is its length.
    const png = stripMetadata(fixture("photo.png"), "image/png");
    for (let at = 8; at < png.length; ) {
      const length = new DataView(png.buffer).getUint32(at);
      expect(new DataView(png.buffer).getUint32(at + 8 + length)).toBe(crc32(png.subarray(at + 4, at + 8 + length)));
      at += 12 + length;
    }
    const webp = stripMetadata(fixture("photo.webp"), "image/webp");
    expect(new DataView(webp.buffer).getUint32(4, true)).toBe(webp.length - 8);
    // The JPEG ends at its first picture's EOI.
    const jpeg = stripMetadata(fixture("photo.jpg"), "image/jpeg");
    expect([...jpeg.subarray(-2)]).toEqual([0xff, 0xd9]);
  });
});

describe("readEmbedded", () => {
  it("reads XMP, then IPTC, then EXIF: the credit line, the copyright notice, the license address and the date taken", () => {
    expect(readEmbedded(fixture("photo.jpg"), "image/jpeg")).toEqual({
      credit: "Ada Example / Sample Agency",
      license: "(c) 2026 Sample Agency",
      copyright: "(c) 2026 Sample Agency",
      licenseUrl: "https://example.com/license",
      takenAt: "2026-05-01T10:20:30",
    });
  });
});

describe("prepareUpload", () => {
  it("stores a real HEIC as a JPEG, shrunk to the site's longest edge, cleaned, and named from its alt", async () => {
    const ihdr = new Uint8Array(13);
    ihdr.set([0, 0, 0, 1, 0, 0, 0, 1, 8, 6]);
    const chunk = (type: string, data: Uint8Array) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(data.length);
      head.write(type, 4, "latin1");
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])));
      return Buffer.concat([head, data, crc]);
    };
    const pixel = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(new Uint8Array([4, 0x12, 0xab, 0xcd, 0xff]))), chunk("IEND", new Uint8Array())]);
    const transforms: object[] = [];
    const outputs: string[] = [];
    let call = 0;
    const output = async ({ format }: { format: string }) => {
      outputs.push(format);
      // The binding's JPEG is a real one that still carries everything private, which the real binding drops on conversion
      // and the clean must drop on a JPEG it did not re-encode. The placeholder's WebP is any bytes here; the pixel is RGBA
      // under the Paeth filter, which predicts zero.
      const out = format === "image/png" ? new Uint8Array(pixel) : format === "image/webp" ? new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 ") : fixture("photo.jpg");
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
    const heic = fixture("phone.heic");
    const upload = { bytes: heic, contentType: "image/heic", filename: "IMG_0001.HEIC", alt: "The Paluxy River at dusk, from the bridge", changeId: "c-1", resize: true };
    const prepared = await prepareUpload(images, upload, { resize: { maxEdge: 3000, quality: 85 } });
    expect(prepared).toMatchObject({ contentType: "image/jpeg", filename: "paluxy-river-at-dusk-from-the-bridge.jpg", converted: true, width: 3000, height: 2000, resizedFrom: { width: 6000, height: 4000 } });
    // What the real HEIC said about itself is read before the conversion drops it.
    expect(prepared.embedded).toMatchObject({ credit: "Ada Example", copyright: "(c) 2026 Ada Example", takenAt: "2026-05-01T10:20:30", licenseUrl: "https://example.com/license" });
    expect(prepared).toMatchObject({ placeholder: `data:image/webp;base64,${btoa("RIFF\0\0\0\0WEBPVP8 ")}`, color: "#12abcd", stripped: true });
    expect(transforms).toEqual([{ width: 3000, height: 3000, fit: "scale-down" }, { width: 16, height: 16, fit: "scale-down", blur: 2 }, { width: 1, height: 1, fit: "squeeze" }]);
    expect(outputs).toEqual(["image/jpeg", "image/jpeg", "image/webp", "image/png"]);
    expect(PRIVATE.filter((p) => latin(prepared.original!).includes(p))).toEqual([]);
    expect(prepared.sha256).not.toBe(prepared.uploadSha256);

    // A decorative upload keeps a camera's name, with the stored type's extension; a person's own name is kept.
    const named = async (filename: string, alt: string) => (await prepareUpload(images, { ...upload, filename, alt, resize: false })).filename;
    call = 1;
    expect(await named("IMG_0001.HEIC", "")).toBe("IMG_0001.jpg");
    expect(await named("Screenshot 2026-10-31 at 10.22.33 AM.heic", "A bar chart of uploads by month")).toBe("bar-chart-of-uploads-by-month.jpg");
    expect(await named("Paluxy tracks.heic", "Dinosaur tracks in the riverbed")).toBe("Paluxy tracks.jpg");
  });
});
