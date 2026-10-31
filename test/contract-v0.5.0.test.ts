// PLANT: the v0.5.0 contract, unchanged but for what v0.6.0 names. v0.6.0 is additive: every v0.5.0
// route and body stays as it was, so a site or a Carrel on v0.5.0 keeps working.
//
// test/fixtures/contract-v0.5.0.json was written from the v0.5.0 build (tag v0.5.0, 79f0a8f, which
// carries PACKAGE_VERSION 0.5.0): each exported schema as JSON Schema, the route table and the schema hash.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as contract from "../src/contract.js";
import { additiveOnly, added, now, widened, type JsonSchema } from "./additive.js";
import { V0160_CODES, V0160_ROUTES, V0160_SCHEMAS, V0160_WIDEN, withV0160 } from "./v0.16.0.js";

const V050 = JSON.parse(readFileSync(new URL("./fixtures/contract-v0.5.0.json", import.meta.url), "utf8")) as {
  version: string;
  schemaHash: string;
  routes: Array<Record<string, string>>;
  schemas: Record<string, JsonSchema>;
};

/** What every file may carry from v0.13.0 (contract-v0.12.0.test.ts holds the rest of v0.13.0). */
const V0130_ITEM = ["color", "credit", "downloadUrl", "license", "licenseExpires", "placeholder", "sourceUrl", "takenAt", "usedCount"];

/** Every v0.5.0 schema later versions extend, and exactly the optional properties each adds (v0.10.0: scheduled updates, and a file's focal point and caption). */
const ADDED: Record<string, string[]> = withV0160({
  Capabilities: [
    "contentTags", "mediaCaption", "mediaChanges", "mediaCredit", "mediaDuplicates", "mediaEmbedded", "mediaFilters", "mediaFocus",
    "mediaHistory", "mediaImport", "mediaLenses", "mediaReplace", "mediaReplaceKeepsSize", "mediaResize", "mediaResizePass",
    "mediaSuggestions", "mediaTransform", "mediaUsage", "mentionReset", "scheduledUpdates",
  ],
  MediaItem: ["caption", "focus", ...V0130_ITEM].sort(),
  MediaDetail: ["caption", "focus", "twins", ...V0130_ITEM].sort(),
  MediaUploadQuery: ["resize"],
  Meta: [],
  ContentSummary: ["scheduledUpdate", "tags", "version"],
  ContentDoc: ["scheduledUpdate", "tags"],
  WriteResult: ["scheduledUpdate"],
  ListQuery: ["dir", "sort"],
  ContentList: ["sorted", "total"],
  MediaListQuery: ["changedSince", "dir", "kind", "lens", "orientation", "sort"],
  MediaList: ["changeCursor", "moreChanges", "removed", "sorted", "total"],
  MentionListQuery: ["q", "targetId"],
  MentionList: ["filtered"],
});

/** The one v0.5.0 schema v0.6.0 widens rather than extends: a decision may also be reset. */
const WIDENED = "MentionDecideInput";

const exported = Object.entries(contract)
  .filter(([, value]) => value instanceof z.ZodType)
  .map(([name]) => name);

describe("the v0.5.0 contract", () => {
  it("is the recorded v0.5.0", () => {
    expect(V050.version).toBe("0.5.0");
    expect(V050.schemaHash).toBe("ec6a11c73e583361280e77801084b0c566f815a2e9675e21c1d9d622084db86c");
    expect(V050.routes.length).toBe(29);
  });

  it("keeps every v0.5.0 route exactly (the upload's answer named MediaUploadResult from v0.13.0), and adds only the routes later versions name", () => {
    for (const route of V050.routes) {
      const expected = route.method === "POST" && route.path === "/media" ? { ...route, response: "MediaUploadResult" } : route;
      expect(contract.ROUTES, JSON.stringify(route)).toContainEqual(expected);
    }
    const fresh = contract.ROUTES.filter((r) => !V050.routes.some((old) => old.method === r.method && old.path === r.path));
    expect(fresh.map((r) => `${r.method} ${r.path}`)).toEqual([
      "PUT /content/:id/tags",
      "GET /content/:id/schedule",
      "DELETE /content/:id/schedule",
      "POST /media/import",
      "PUT /media/:id/focus",
      "PUT /media/:id/caption",
      "PUT /media/:id/file",
      "PUT /media/:id/credit",
      "POST /media/:id/transform",
      "GET /media/:id/history",
      "POST /media/:id/revert",
      "GET /media/:id/suggestions",
      "POST /media/resize-pass",
      ...V0160_ROUTES,
    ]);
  });

  for (const name of Object.keys(V050.schemas).filter((n) => !(n in ADDED) && n !== WIDENED && n !== "ErrorCode")) {
    it(`keeps ${name} identical`, () => {
      expect(now(name)).toEqual(V050.schemas[name]);
    });
  }

  for (const [name, props] of Object.entries(ADDED)) {
    it(`extends ${name} by optional properties only: ${props.join(", ") || "none of its own"}`, () => {
      additiveOnly(V050.schemas[name]!, now(name), name, V0160_WIDEN);
      expect(added(V050.schemas[name]!, now(name)).sort()).toEqual(props);
    });
  }

  it("widens the error codes by in-progress, and nothing else", () => {
    widened(V050.schemas.ErrorCode!, now("ErrorCode"), V0160_CODES, "ErrorCode");
  });

  it("widens the mention decision by reset, and nothing else", () => {
    const before = V050.schemas[WIDENED]!;
    const after = now(WIDENED);
    const decision = (s: JsonSchema) => (s.properties!.decision as { enum: string[] }).enum;
    expect(decision(after)).toEqual([...decision(before), "reset"]);
    const strip = (s: JsonSchema) => ({ ...s, properties: { ...s.properties, decision: undefined } });
    expect(strip(after)).toEqual(strip(before));
  });

  it("adds only the new schemas v0.6.0, v0.10.0, v0.13.0 and v0.16.0 name", () => {
    const v060 = ["ContentTag", "ContentTagsInput", "ContentTags", "MediaLens", "SortDir"];
    const v0100 = [
      "ScheduleCancelQuery", "ScheduledUpdate", "ScheduledUpdateSummary",
      "MediaCaption", "MediaCaptionInput", "MediaFocus", "MediaFocusInput", "MediaReplaceQuery", "MediaReplaceResult",
    ];
    const v0130 = [
      "MediaColor", "MediaCredit", "MediaCreditInput", "MediaHistory", "MediaImportInput", "MediaKind", "MediaLicense",
      "MediaOrientation", "MediaPlaceholder", "MediaResize", "MediaResizeOutcome", "MediaResizePassInput",
      "MediaResizePassResult", "MediaRevertInput", "MediaRevision", "MediaSourceUrl", "MediaSuggestions",
      "MediaTransformInput", "MediaTransformOp", "MediaTransformResult", "MediaTwin", "MediaUploadResult",
    ];
    expect(exported.filter((n) => !(n in V050.schemas)).sort()).toEqual([...v060, ...v0100, ...v0130, ...V0160_SCHEMAS].sort());
  });

  it("parses v0.5.0 bodies with the v0.6.0 schemas", () => {
    const meta = {
      api: "carrel-site-api",
      packageVersion: "0.5.0",
      schemaHash: V050.schemaHash,
      site: { id: "memory", name: "Memory", origin: "https://memory.example" },
      capabilities: { content: true, preview: true, media: false, inbox: false, insight: false, publications: false, mentions: true },
    };
    expect(contract.Meta.safeParse(meta).success).toBe(true);
    const row = { id: "a", kind: "post", title: "A", status: "draft", path: null, publishAt: null, publishedAt: null, updatedAt: null };
    expect(contract.ContentList.safeParse({ items: [row], nextCursor: null }).success).toBe(true);
    expect(contract.MediaList.safeParse({ items: [], nextCursor: null }).success).toBe(true);
    const counts = { unverified: 0, pending: 0, approved: 0, rejected: 0, failed: 0 };
    expect(contract.MentionList.safeParse({ items: [], nextCursor: null, counts, expiring: { failed: 0, rejected: 0 } }).success).toBe(true);
    expect(contract.MentionDecideInput.safeParse({ decision: "approve", expectedVersion: "m1", changeId: "c1" }).success).toBe(true);
  });

  it("changes the schema hash on purpose", async () => {
    expect(await contract.schemaHash()).not.toBe(V050.schemaHash);
  });
});
