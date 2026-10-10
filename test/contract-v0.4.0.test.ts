// PLANT: the v0.4.0 contract, unchanged. v0.5.0 adds the mentions group and nothing else: every
// v0.4.0 route and body stays as it was, so a site or a Carrel on v0.4.0 keeps working.
//
// test/fixtures/contract-v0.4.0.json was written from the v0.4.0 build (origin/main at 4630a78, which
// carries PACKAGE_VERSION 0.4.0): each schema as JSON Schema, the route table and the schema hash.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as contract from "../src/contract.js";

type JsonSchema = { properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };

const V040 = JSON.parse(readFileSync(new URL("./fixtures/contract-v0.4.0.json", import.meta.url), "utf8")) as {
  version: string;
  schemaHash: string;
  routes: Array<Record<string, string>>;
  schemas: Record<string, JsonSchema>;
};

/** The one schema v0.5.0 extends, by an optional property only (capabilities.mentions). */
const EXTENDED = new Set(["Meta", "Capabilities"]);

const now = (name: string) => z.toJSONSchema((contract as unknown as Record<string, z.ZodType>)[name]!, { io: "input" }) as JsonSchema;

describe("the v0.4.0 contract", () => {
  it("is the recorded v0.4.0, and the fixture holds every schema it names", () => {
    expect(V040.version).toBe("0.4.0");
    expect(Object.keys(V040.schemas).length).toBeGreaterThan(30);
    expect(V040.routes.length).toBe(25);
  });

  it("keeps every v0.4.0 route exactly", () => {
    for (const route of V040.routes) expect(contract.ROUTES, JSON.stringify(route)).toContainEqual(route);
  });

  it("adds only the four mentions routes", () => {
    const added = contract.ROUTES.filter((r) => !V040.routes.some((old) => JSON.stringify(old) === JSON.stringify(r)));
    expect(added.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /mentions",
      "POST /mentions/sweep",
      "POST /mentions/:id/decide",
      "DELETE /mentions/:id",
    ]);
  });

  for (const name of Object.keys(V040.schemas).filter((n) => !EXTENDED.has(n))) {
    it(`keeps ${name} identical`, () => {
      expect(now(name)).toEqual(V040.schemas[name]);
    });
  }

  it("extends Capabilities by optional properties only (v0.5.0's mentions; later ones are named by the newer contract tests), and Meta only through it", () => {
    const before = V040.schemas.Capabilities!;
    const after = now("Capabilities");
    for (const [prop, schema] of Object.entries(before.properties ?? {})) expect(after.properties?.[prop], prop).toEqual(schema);
    expect(Object.keys(after.properties ?? {}).filter((p) => !(p in (before.properties ?? {})))).toContain("mentions");
    expect(after.required).toEqual(before.required);
    const metaBefore = V040.schemas.Meta!;
    const metaAfter = now("Meta");
    expect(metaAfter.required).toEqual(metaBefore.required);
    expect(Object.keys(metaAfter.properties ?? {})).toEqual(Object.keys(metaBefore.properties ?? {}));
  });

  it("parses a v0.4.0 meta with the v0.5.0 schema", () => {
    const meta = {
      api: "carrel-site-api",
      packageVersion: "0.4.0",
      schemaHash: V040.schemaHash,
      site: { id: "memory", name: "Memory", origin: "https://memory.example" },
      capabilities: { content: true, preview: true, media: false, inbox: false, insight: false, publications: false, contentDelete: true, mediaAlt: true, mediaTags: true, mediaTrash: true },
    };
    expect(contract.Meta.safeParse(meta).success).toBe(true);
  });

  it("changes the schema hash on purpose, and moves the package version to 0.5.0", async () => {
    expect(await contract.schemaHash()).not.toBe(V040.schemaHash);
    expect(contract.PACKAGE_VERSION).toBe("0.5.0");
  });
});
