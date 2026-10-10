// PLANT: the v0.5.0 contract, unchanged but for what v0.6.0 names. v0.6.0 is additive: every v0.5.0
// route and body stays as it was, so a site or a Carrel on v0.5.0 keeps working.
//
// test/fixtures/contract-v0.5.0.json was written from the v0.5.0 build (tag v0.5.0, 79f0a8f, which
// carries PACKAGE_VERSION 0.5.0): each exported schema as JSON Schema, the route table and the schema hash.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as contract from "../src/contract.js";
import { additiveOnly, added, now, type JsonSchema } from "./additive.js";

const V050 = JSON.parse(readFileSync(new URL("./fixtures/contract-v0.5.0.json", import.meta.url), "utf8")) as {
  version: string;
  schemaHash: string;
  routes: Array<Record<string, string>>;
  schemas: Record<string, JsonSchema>;
};

/** Every v0.5.0 schema v0.6.0 extends, and exactly the optional properties it adds to each. */
const ADDED: Record<string, string[]> = {
  Capabilities: ["contentTags", "mediaLenses", "mentionReset"],
  Meta: [],
  ContentSummary: ["tags", "version"],
  ContentDoc: ["tags"],
  ListQuery: ["dir", "sort"],
  ContentList: ["sorted", "total"],
  MediaListQuery: ["dir", "lens", "sort"],
  MediaList: ["sorted", "total"],
  MentionListQuery: ["q", "targetId"],
  MentionList: ["filtered"],
};

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

  it("keeps every v0.5.0 route exactly, and adds only the content tags route", () => {
    for (const route of V050.routes) expect(contract.ROUTES, JSON.stringify(route)).toContainEqual(route);
    const fresh = contract.ROUTES.filter((r) => !V050.routes.some((old) => JSON.stringify(old) === JSON.stringify(r)));
    expect(fresh.map((r) => `${r.method} ${r.path}`)).toEqual(["PUT /content/:id/tags"]);
  });

  for (const name of Object.keys(V050.schemas).filter((n) => !(n in ADDED) && n !== WIDENED)) {
    it(`keeps ${name} identical`, () => {
      expect(now(name)).toEqual(V050.schemas[name]);
    });
  }

  for (const [name, props] of Object.entries(ADDED)) {
    it(`extends ${name} by optional properties only: ${props.join(", ") || "none of its own"}`, () => {
      additiveOnly(V050.schemas[name]!, now(name), name);
      expect(added(V050.schemas[name]!, now(name)).sort()).toEqual(props);
    });
  }

  it("widens the mention decision by reset, and nothing else", () => {
    const before = V050.schemas[WIDENED]!;
    const after = now(WIDENED);
    const decision = (s: JsonSchema) => (s.properties!.decision as { enum: string[] }).enum;
    expect(decision(after)).toEqual([...decision(before), "reset"]);
    const strip = (s: JsonSchema) => ({ ...s, properties: { ...s.properties, decision: undefined } });
    expect(strip(after)).toEqual(strip(before));
  });

  it("adds only the new schemas v0.6.0 names", () => {
    expect(exported.filter((n) => !(n in V050.schemas)).sort()).toEqual(["ContentTag", "ContentTagsInput", "ContentTags", "MediaLens", "SortDir"].sort());
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

  it("changes the schema hash on purpose, and moves the package version to 0.6.0", async () => {
    expect(await contract.schemaHash()).not.toBe(V050.schemaHash);
    expect(contract.PACKAGE_VERSION).toBe("0.6.0");
  });
});
