// The rule every later contract keeps against an earlier one: a schema may gain optional properties
// only. Every earlier property stays, required exactly as before, and each object nested in it
// follows the same rule (Meta.capabilities is Capabilities).

import { expect } from "vitest";
import { z } from "zod";
import * as contract from "../src/contract.js";

export type JsonSchema = { properties?: Record<string, unknown>; required?: string[]; [k: string]: unknown };

export const now = (name: string) => z.toJSONSchema((contract as unknown as Record<string, z.ZodType>)[name]!, { io: "input" }) as JsonSchema;

/**
 * `widen` names the enums a later version may extend (path, such as "MediaListQuery.sort", to exactly the values it adds
 * at the end): an enum, or an array of one, keeps every earlier value in order and gains only those.
 */
export function additiveOnly(before: JsonSchema, after: JsonSchema, where: string, widen: Record<string, readonly string[]> = {}) {
  for (const [prop, schema] of Object.entries(before.properties ?? {})) {
    const next = after.properties?.[prop] as JsonSchema | undefined;
    const path = `${where}.${prop}`;
    expect(next, `${path} is gone`).toBeDefined();
    if (path in widen) widened(schema as JsonSchema, next!, widen[path]!, path);
    else if ((schema as JsonSchema).type === "object") additiveOnly(schema as JsonSchema, next!, path, widen);
    else if ((schema as JsonSchema).type === "array" && ((schema as JsonSchema).items as JsonSchema | undefined)?.type === "object") {
      additiveOnly((schema as JsonSchema).items as JsonSchema, next!.items as JsonSchema, `${path}[]`, widen);
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

/** An enum, or an array of one, that keeps every earlier value in order and adds exactly `extra` at the end. */
export function widened(before: JsonSchema, after: JsonSchema, extra: readonly string[], where: string) {
  const at = (s: JsonSchema) => (s.enum ? s : (s.items as JsonSchema));
  expect(at(after).enum, `${where} values`).toEqual([...(at(before).enum as string[]), ...extra]);
  const strip = (s: JsonSchema) => (s.enum ? { ...s, enum: undefined } : { ...s, items: { ...(s.items as JsonSchema), enum: undefined } });
  expect(strip(after), `${where} other keywords`).toEqual(strip(before));
}

/** The properties `after` has that `before` lacks. */
export function added(before: JsonSchema, after: JsonSchema): string[] {
  return Object.keys(after.properties ?? {}).filter((p) => !(p in (before.properties ?? {})));
}
