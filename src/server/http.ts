// What every route shares: the JSON answers, the body and query readers, the check on what an adapter
// answers, and the contract's name and words for a failure.

import type { z } from "zod";
import { MediaInUseError, NotFoundError, RefusedError, VersionConflictError } from "../adapter.js";
import type { ErrorBody, ErrorCode, MediaUse } from "../contract.js";
import { readCapped } from "@dustinedwards/site-runtime/body";

/** Four million bytes: two million characters of source can take that much as UTF-8 JSON. */
export const MAX_BODY_BYTES = 4_000_000;

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  "rate-limited": 429,
  "not-configured": 503,
  unavailable: 503,
  "not-found": 404,
  "method-not-allowed": 405,
  invalid: 400,
  "too-large": 413,
  "version-conflict": 409,
  "in-progress": 409,
  "unknown-field": 400,
  refused: 422,
  "not-implemented": 501,
  internal: 500,
};

/** Each code's fixed title (v0.17.0), the `title` of its problem details; the README's Errors table says what each means. */
const TITLE: Record<ErrorCode, string> = {
  unauthorized: "Unauthorized",
  "rate-limited": "Too many requests",
  "not-configured": "Not configured",
  unavailable: "Unavailable",
  "not-found": "Not found",
  "method-not-allowed": "Method not allowed",
  invalid: "Invalid request",
  "too-large": "Too large",
  "version-conflict": "Version conflict",
  "in-progress": "In progress",
  "unknown-field": "Unknown field",
  refused: "Refused",
  "not-implemented": "Not implemented",
  internal: "Internal error",
};

/** Where each code is explained: the README's Errors table, one anchor per code. */
export const ERROR_TYPE_BASE = "https://github.com/DrDustinEdwards/site-api/blob/main/README.md#error-";

export const BASE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * An error answer as RFC 9457 problem details (v0.17.0). `error` and `message` stay as every earlier reader expects;
 * `type`, `title`, `status` and `detail` are the standard's names for the same answer.
 */
export function fail(code: ErrorCode, message: string, extra: Partial<ErrorBody> = {}): Response {
  const status = STATUS[code];
  const body = { error: code, message, type: `${ERROR_TYPE_BASE}${code}`, title: TITLE[code], status, detail: message, ...extra };
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, "content-type": "application/problem+json; charset=utf-8" },
  });
}

export class BadRequest extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly field?: string) {
    super(message);
  }
}

/**
 * The keys a schema names (v0.19.0): an object's own, or every option's for a union of objects. null when the schema is
 * not an object, so nothing is refused for it.
 */
function knownKeys(schema: z.ZodType): Set<string> | null {
  const def = (schema as unknown as { def?: { type?: string; shape?: Record<string, unknown>; options?: z.ZodType[]; innerType?: z.ZodType; in?: z.ZodType } }).def;
  if (!def) return null;
  if (def.type === "object" && def.shape) return new Set(Object.keys(def.shape));
  if (def.type === "union" && def.options) {
    const keys = new Set<string>();
    for (const option of def.options) {
      const own = knownKeys(option);
      if (!own) return null;
      for (const k of own) keys.add(k);
    }
    return keys;
  }
  const inner = def.innerType ?? def.in;
  return inner ? knownKeys(inner) : null;
}

/**
 * v0.19.0: a body or query key the contract does not name is refused, never dropped, so a caller that misspells a field
 * or sends one the site's version does not know hears so (400 unknown-field, naming it) instead of a 200 that ignored it.
 */
export function refuseUnknown(schema: z.ZodType, value: unknown, where: "body" | "query"): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const known = knownKeys(schema);
  if (!known) return;
  const unknown = Object.keys(value).find((k) => !known.has(k));
  if (unknown !== undefined) throw new BadRequest("unknown-field", `The ${where} has a field the contract does not name: ${unknown}.`, unknown);
}

/** A route that takes no query refuses any key in one (v0.19.0). */
export function refuseAnyQuery(url: URL): void {
  const first = [...url.searchParams.keys()][0];
  if (first !== undefined) throw new BadRequest("unknown-field", `This route takes no query, so ${first} is not a field it names.`, first);
}

export async function readBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new BadRequest("too-large", "The body is too large.");
  // Counted as it arrives (site-runtime's one reader), so an understated or missing Content-Length cannot make the
  // Worker hold more than the limit; request.text() read the whole body first.
  const text = await readCapped(request, MAX_BODY_BYTES);
  if (text === null) throw new BadRequest("too-large", "The body is too large.");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BadRequest("invalid", "The body is not JSON.");
  }
  refuseUnknown(schema, raw, "body");
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BadRequest("invalid", describe(parsed.error));
  return parsed.data;
}

export function readQuery<T extends z.ZodType>(url: URL, schema: T): z.infer<T> {
  const raw = Object.fromEntries(url.searchParams);
  refuseUnknown(schema, raw, "query");
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BadRequest("invalid", describe(parsed.error));
  return parsed.data;
}

function describe(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
}

/** An adapter that answers outside the contract is a site bug, reported as one and never passed on. */
export class ContractBreach extends Error {}

export function checked<T extends z.ZodType>(schema: T, value: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ContractBreach(`${what}: ${describe(parsed.error)}`);
  return parsed.data;
}

/**
 * One route. `query` (v0.19.0) is true for a route that reads its query through readQuery, which refuses an unknown key
 * itself; on any other route, the handler refuses a query with any key before the route runs.
 */
export type Route = { method: string; pattern: RegExp; query?: boolean; run: (m: RegExpMatchArray, url: URL, request: Request) => Promise<Response> };

export const ID = "([^/]+)";

/** A path segment decoded and checked against its shape; what is refused names the thing it should have been. */
export function pathParam(raw: string | undefined, shape: z.ZodType, what: string): string {
  let value: string;
  try {
    value = decodeURIComponent(raw!);
  } catch {
    throw new BadRequest("invalid", `The ${what} is not valid.`);
  }
  if (!shape.safeParse(value).success) throw new BadRequest("invalid", `The ${what} is not valid.`);
  return value;
}

export type Log = (entry: Record<string, unknown>) => void;

export interface Failure {
  code: ErrorCode;
  message: string;
  currentVersion?: string | null;
  usedBy?: MediaUse[];
  field?: string;
}

/** The contract's name and words for a failure, for the single routes and for one file of a bulk. */
export function describeFailure(error: unknown, log: Log): Failure {
  if (error instanceof BadRequest) return { code: error.code, message: error.message, ...(error.field !== undefined ? { field: error.field } : {}) };
  if (error instanceof VersionConflictError) return { code: "version-conflict", message: error.message, currentVersion: error.currentVersion };
  if (error instanceof NotFoundError) return { code: "not-found", message: error.message };
  if (error instanceof MediaInUseError) return { code: "refused", message: error.message, usedBy: error.usedBy };
  if (error instanceof RefusedError) return { code: "refused", message: error.message };
  if (error instanceof ContractBreach) {
    log({ siteApi: "contract-breach", detail: error.message });
    return { code: "internal", message: "The site answered outside the contract." };
  }
  log({ siteApi: "adapter-failed", error: error instanceof Error ? error.message : String(error) });
  return { code: "internal", message: "The site failed to answer." };
}
