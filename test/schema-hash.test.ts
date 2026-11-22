import { readFileSync, writeFileSync } from "node:fs";
import { canonicalJson, sha256Hex } from "@dustinedwards/site-runtime/encoding";
import { expect, it } from "vitest";
import { z } from "zod";
import { HASHED, PREFIX, ROUTES } from "../src/contract.js";
import { SCHEMA_HASH } from "../src/schema-hash.js";

const FILE = new URL("../src/schema-hash.ts", import.meta.url);

it("records the hash of every schema as JSON Schema plus the route table", async () => {
  const schemas = Object.fromEntries(
    Object.entries(HASHED).map(([name, schema]) => [name, z.toJSONSchema(schema, { io: "input" })]),
  );
  const hash = await sha256Hex(canonicalJson({ prefix: PREFIX, routes: ROUTES, schemas }));
  if (process.env["UPDATE_SCHEMA_HASH"]) {
    writeFileSync(FILE, readFileSync(FILE, "utf8").replace(/"[0-9a-f]{64}"/, `"${hash}"`));
    return;
  }
  expect(SCHEMA_HASH).toBe(hash);
});
