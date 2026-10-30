// PLANT: the v0.12.0 contract, unchanged but for what v0.13.0 names. v0.13.0 is additive: every v0.12.0 route and body
// stays as it was, so a site or a Carrel on v0.12.0 keeps working.
//
// test/fixtures/contract-v0.12.0.json was written from the v0.12.0 build (tag v0.12.0, 63b2b9c, which carries
// PACKAGE_VERSION 0.12.0): each exported schema as JSON Schema, the route table and the schema hash.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as contract from "../src/contract.js";
import { additiveOnly, added, now, widened, type JsonSchema } from "./additive.js";
import { V0150_CODES, V0150_ROUTES, V0150_SCHEMAS, V0150_WIDEN, withV0150 } from "./v0.15.0.js";

const V0120 = JSON.parse(readFileSync(new URL("./fixtures/contract-v0.12.0.json", import.meta.url), "utf8")) as {
  version: string;
  schemaHash: string;
  routes: Array<Record<string, string>>;
  schemas: Record<string, JsonSchema>;
};

/** What every file may carry from v0.13.0. */
const ITEM = ["color", "credit", "downloadUrl", "license", "licenseExpires", "placeholder", "sourceUrl", "takenAt", "usedCount"];

/** Every v0.12.0 schema v0.13.0 and v0.15.0 extend, and exactly the optional properties each adds. */
const ADDED: Record<string, string[]> = withV0150({
  Capabilities: [
    "mediaChanges", "mediaCredit", "mediaDuplicates", "mediaEmbedded", "mediaFilters", "mediaHistory", "mediaImport",
    "mediaResize", "mediaResizePass", "mediaSuggestions", "mediaTransform", "mediaUsage",
  ],
  Meta: [],
  MediaItem: ITEM,
  MediaDetail: [...ITEM, "twins"].sort(),
  MediaReplaceResult: ITEM,
  MediaList: ["changeCursor", "moreChanges", "removed"],
  MediaListQuery: ["changedSince", "kind", "orientation"],
  MediaUploadQuery: ["resize"],
});

const NEW_LENSES = ["duplicates", "license-expired", "oversized"];

/** The enums v0.13.0 widens: three lenses and the used sort, at the end, everywhere they appear. */
const WIDEN: Record<string, readonly string[]> = {
  "Capabilities.mediaLenses": NEW_LENSES,
  "Meta.capabilities.mediaLenses": NEW_LENSES,
  "MediaListQuery.lens": NEW_LENSES,
  "MediaListQuery.sort": ["used"],
  "MediaList.sorted.sort": ["used"],
  ...V0150_WIDEN,
};

const NEW_SCHEMAS = [
  "MediaColor", "MediaCredit", "MediaCreditInput", "MediaHistory", "MediaImportInput", "MediaKind", "MediaLicense",
  "MediaOrientation", "MediaPlaceholder", "MediaResize", "MediaResizeOutcome", "MediaResizePassInput",
  "MediaResizePassResult", "MediaRevertInput", "MediaRevision", "MediaSourceUrl", "MediaSuggestions",
  "MediaTransformInput", "MediaTransformOp", "MediaTransformResult", "MediaTwin", "MediaUploadResult",
];

const exported = Object.entries(contract)
  .filter(([, value]) => value instanceof z.ZodType)
  .map(([name]) => name);

describe("the v0.12.0 contract", () => {
  it("is the recorded v0.12.0", () => {
    expect(V0120.version).toBe("0.12.0");
    expect(V0120.schemaHash).toBe("6672826e05c67023341bcf883438dd9691a185f734937a4373f79117be77df41");
    expect(V0120.routes.length).toBe(35);
  });

  it("keeps every v0.12.0 route exactly, but the upload's answer named MediaUploadResult, and adds only the v0.13.0 media routes", () => {
    for (const route of V0120.routes) {
      const expected = route.method === "POST" && route.path === "/media" ? { ...route, response: "MediaUploadResult" } : route;
      expect(contract.ROUTES, JSON.stringify(route)).toContainEqual(expected);
    }
    const fresh = contract.ROUTES.filter((r) => !V0120.routes.some((old) => old.method === r.method && old.path === r.path));
    expect(fresh.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /media/import",
      "PUT /media/:id/credit",
      "POST /media/:id/transform",
      "GET /media/:id/history",
      "POST /media/:id/revert",
      "GET /media/:id/suggestions",
      "POST /media/resize-pass",
      ...V0150_ROUTES,
    ]);
  });

  it("answers an upload with MediaItem and three optional properties more, so a v0.12.0 reader's MediaItem still parses it", () => {
    additiveOnly(V0120.schemas.MediaItem!, now("MediaUploadResult"), "MediaUploadResult");
    expect(added(V0120.schemas.MediaItem!, now("MediaUploadResult")).sort()).toEqual([...ITEM, "duplicateOf", "embedded", "resizedFrom"].sort());
  });

  for (const name of Object.keys(V0120.schemas).filter((n) => !(n in ADDED) && n !== "MediaLens" && n !== "ErrorCode")) {
    it(`keeps ${name} identical`, () => {
      expect(now(name)).toEqual(V0120.schemas[name]);
    });
  }

  for (const [name, props] of Object.entries(ADDED)) {
    it(`extends ${name} by optional properties only: ${props.join(", ") || "none of its own"}`, () => {
      additiveOnly(V0120.schemas[name]!, now(name), name, WIDEN);
      expect(added(V0120.schemas[name]!, now(name)).sort()).toEqual(props);
    });
  }

  it("widens the lenses by duplicates, license-expired and oversized, and nothing else", () => {
    widened(V0120.schemas.MediaLens!, now("MediaLens"), NEW_LENSES, "MediaLens");
  });

  it("widens the error codes by in-progress (v0.15.0), and nothing else", () => {
    widened(V0120.schemas.ErrorCode!, now("ErrorCode"), V0150_CODES, "ErrorCode");
  });

  it("adds only the new schemas v0.13.0 names", () => {
    expect(exported.filter((n) => !(n in V0120.schemas)).sort()).toEqual([...NEW_SCHEMAS, ...V0150_SCHEMAS].sort());
  });

  it("parses v0.12.0 bodies with the v0.13.0 schemas", () => {
    const item = {
      id: "uploads/1-a.png", url: "/media/uploads/1-a.png", filename: "a.png", contentType: "image/png", bytes: 9,
      width: null, height: null, alt: "", uploadedAt: null, deletable: true, version: "m1", tags: [], trashedAt: null, focus: null, caption: "",
    };
    expect(contract.MediaUploadResult.safeParse(item).success).toBe(true);
    expect(contract.MediaList.safeParse({ items: [item], nextCursor: null, total: 1, sorted: { sort: "added", dir: "desc" } }).success).toBe(true);
    const capabilities = { content: true, preview: true, media: true, inbox: false, insight: false, publications: false, mediaLenses: ["no-alt"], mediaReplace: true };
    expect(contract.Capabilities.safeParse(capabilities).success).toBe(true);
  });

  it("changes the schema hash on purpose", async () => {
    expect(await contract.schemaHash()).not.toBe(V0120.schemaHash);
  });
});
