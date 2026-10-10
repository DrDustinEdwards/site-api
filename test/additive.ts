// The rule every later contract keeps against an earlier one: a schema may gain optional properties
// only. Every earlier property stays, required exactly as before, and each object nested in it
// follows the same rule (Meta.capabilities is Capabilities).

import { expect } from "vitest";
import { z } from "zod";
import * as contract from "../src/contract.js";

export type JsonSchema = { properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };

export const now = (name: string) => z.toJSONSchema((contract as unknown as Record<string, z.ZodType>)[name]!, { io: "input" }) as JsonSchema;

export function additiveOnly(before: JsonSchema, after: JsonSchema, where: string) {
  for (const [prop, schema] of Object.entries(before.properties ?? {})) {
    const next = after.properties?.[prop] as JsonSchema | undefined;
    expect(next, `${where}.${prop} is gone`).toBeDefined();
    if ((schema as JsonSchema).type === "object") additiveOnly(schema as JsonSchema, next!, `${where}.${prop}`);
    else if ((schema as JsonSchema).type === "array" && ((schema as JsonSchema).items as JsonSchema | undefined)?.type === "object") {
      additiveOnly((schema as JsonSchema).items as JsonSchema, next!.items as JsonSchema, `${where}.${prop}[]`);
      const { items: _a, ...restBefore } = schema as JsonSchema;
      const { items: _b, ...restAfter } = next!;
      expect(restAfter, `${where}.${prop}`).toEqual(restBefore);
    } else expect(next, `${where}.${prop}`).toEqual(schema);
  }
  // required is a set in JSON Schema: an extended object may list it in another order.
  expect([...(after.required ?? [])].sort(), `${where} required`).toEqual([...(before.required ?? [])].sort());
  const { properties: _a, required: _b, ...restBefore } = before;
  const { properties: _c, required: _d, ...restAfter } = after;
  expect(restAfter, `${where} other keywords`).toEqual(restBefore);
}

/** The properties `after` has that `before` lacks. */
export function added(before: JsonSchema, after: JsonSchema): string[] {
  return Object.keys(after.properties ?? {}).filter((p) => !(p in (before.properties ?? {})));
}
