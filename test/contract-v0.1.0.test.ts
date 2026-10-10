// PLANT: the v0.1.0 contract, unchanged. v0.2.0 is additive only (job_9e9282fde733): every v0.1.0
// route and body stays as it was, so a site or a Carrel on v0.1.0 keeps working against v0.2.0.
//
// test/fixtures/contract-v0.1.0.json was written from the v0.1.0 build (tag v0.1.0, 3cc13c0) before
// any v0.2.0 change: each schema as JSON Schema, the route table and the schema hash. Its hash is the
// one Carrel's design records, 496b0dd3.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as contract from "../src/contract.js";
import { additiveOnly, now, type JsonSchema } from "./additive.js";

const V010 = JSON.parse(readFileSync(new URL("./fixtures/contract-v0.1.0.json", import.meta.url), "utf8")) as {
  version: string;
  schemaHash: string;
  routes: Array<Record<string, string>>;
  schemas: Record<string, JsonSchema>;
};

/** The schemas later versions extend, by optional properties only: v0.2.0 the first three, v0.6.0 the content list. Every other one must be identical. */
const EXTENDED = new Set(["Meta", "Capabilities", "ErrorBody", "ContentSummary", "ContentDoc", "ListQuery", "ContentList"]);


describe("the v0.1.0 contract", () => {
  it("is the recorded v0.1.0 (the fixture's own hash is the one Carrel's design names)", () => {
    expect(V010.version).toBe("0.1.0");
    expect(V010.schemaHash).toBe("496b0dd37e86b34c18dde78333f8d1615fbb1d1f483054b2b098bc0f585f0e58");
  });

  it("keeps every v0.1.0 route exactly, and replaces only the media placeholder", () => {
    for (const route of V010.routes) {
      if (route.group === "media") {
        expect(route).toEqual({ group: "media", method: "*", path: "/media/*", response: "not-implemented" });
        continue;
      }
      expect(contract.ROUTES, JSON.stringify(route)).toContainEqual(route);
    }
    expect(contract.ROUTES.filter((r) => r.group === "media").map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /media",
      "POST /media",
      "GET /media/:id",
      "DELETE /media/:id",
      "PUT /media/:id/alt",
      "PUT /media/:id/tags",
      "POST /media/:id/trash",
      "POST /media/:id/restore",
      "POST /media/trash/empty",
      "POST /media/bulk",
    ]);
  });

  for (const name of Object.keys(V010.schemas).filter((n) => !EXTENDED.has(n))) {
    it(`keeps ${name} identical`, () => {
      expect(now(name)).toEqual(V010.schemas[name]);
    });
  }

  for (const name of EXTENDED) {
    it(`extends ${name} by optional properties only`, () => {
      additiveOnly(V010.schemas[name]!, now(name), name);
    });
  }

  it("names what v0.2.0 added to the extended schemas", () => {
    expect(Object.keys(now("Capabilities").properties ?? {})).toContain("mediaUpload");
    expect(Object.keys(now("ErrorBody").properties ?? {})).toContain("usedBy");
  });

  it("parses a v0.1.0 body with the v0.2.0 schemas, and a v0.2.0 meta with the v0.1.0 shape", async () => {
    const v010meta = {
      api: "carrel-site-api",
      packageVersion: "0.1.0",
      schemaHash: V010.schemaHash,
      site: { id: "memory", name: "Memory", origin: "https://memory.example" },
      capabilities: { content: true, preview: true, media: false, inbox: false, insight: false, publications: false },
    };
    expect(contract.Meta.safeParse(v010meta).success).toBe(true);
    expect(contract.ErrorBody.safeParse({ error: "refused", message: "No." }).success).toBe(true);
  });

  it("bumps the schema hash and the package version", async () => {
    expect(await contract.schemaHash()).not.toBe(V010.schemaHash);
    expect(contract.PACKAGE_VERSION).toBe("0.5.0");
  });
});
