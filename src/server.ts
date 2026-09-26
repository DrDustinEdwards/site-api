// The site side: one handler for everything under /api/carrel/v1.
//
// Order is the guard: prefix, then rate limit, then key, then route. A request outside the prefix
// is never served, whatever key it carries; a request without the key learns nothing about routes.

import { createTwoFilesPatch } from "diff";
import type { z } from "zod";
import {
  CAPABILITIES,
  NotFoundError,
  RefusedError,
  VersionConflictError,
  type SiteAdapter,
} from "./adapter.js";
import {
  ContentDoc,
  ContentId,
  ContentList,
  Diff,
  DiffQuery,
  ListQuery,
  Meta,
  PACKAGE_VERSION,
  PREFIX,
  PreviewInput,
  PublishInput,
  RevisionList,
  SaveDraftInput,
  ScheduleInput,
  UnpublishInput,
  WriteResult,
  schemaHash,
  type ErrorBody,
  type ErrorCode,
} from "./contract.js";

/** The shape of Cloudflare's `ratelimit` binding, so a site passes its binding straight in. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface SiteApiConfig {
  adapter: SiteAdapter;
  /** The site's Carrel key, from its secrets. Shorter than 32 characters refuses every request. */
  key: string | undefined;
  limiter: RateLimiter;
  /** Where refusals and adapter failures are logged. Defaults to console. */
  log?: (entry: Record<string, unknown>) => void;
}

export interface SiteApi {
  /** True when the request's path is inside the prefix. Mount the handler only where this holds. */
  matches(request: Request): boolean;
  handle(request: Request): Promise<Response>;
}

export const MIN_KEY_LENGTH = 32;

/** Four million bytes: two million characters of source can take that much as UTF-8 JSON. */
const MAX_BODY_BYTES = 4_000_000;

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
  refused: 422,
  "not-implemented": 501,
  internal: 500,
};

const BASE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, "content-type": "application/json; charset=utf-8" },
  });
}

function fail(code: ErrorCode, message: string, extra: Partial<ErrorBody> = {}): Response {
  return json(STATUS[code], { error: code, message, ...extra });
}

export function insidePrefix(pathname: string): boolean {
  return pathname === PREFIX || pathname.startsWith(`${PREFIX}/`);
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** Compares digests, not the keys, so the time taken says nothing about the key's length or prefix. */
export async function keysMatch(presented: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer[ ]+(\S+)\s*$/i);
  return match ? match[1]! : null;
}

class BadRequest extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
  }
}

async function readBody<T extends z.ZodType>(request: Request, schema: T): Promise<z.infer<T>> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) throw new BadRequest("too-large", "The body is too large.");
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    throw new BadRequest("too-large", "The body is too large.");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BadRequest("invalid", "The body is not JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new BadRequest("invalid", describe(parsed.error));
  return parsed.data;
}

function readQuery<T extends z.ZodType>(url: URL, schema: T): z.infer<T> {
  const parsed = schema.safeParse(Object.fromEntries(url.searchParams));
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
class ContractBreach extends Error {}

function checked<T extends z.ZodType>(schema: T, value: unknown, what: string): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ContractBreach(`${what}: ${describe(parsed.error)}`);
  return parsed.data;
}

type Route = { method: string; pattern: RegExp; run: (m: RegExpMatchArray, url: URL, request: Request) => Promise<Response> };

const ID = "([^/]+)";

export function createSiteApi(config: SiteApiConfig): SiteApi {
  const { adapter, limiter } = config;
  const log = config.log ?? ((entry) => console.warn(JSON.stringify(entry)));

  function id(m: RegExpMatchArray): string {
    let value: string;
    try {
      value = decodeURIComponent(m[1]!);
    } catch {
      throw new BadRequest("invalid", "The content id is not valid.");
    }
    if (!ContentId.safeParse(value).success) throw new BadRequest("invalid", "The content id is not valid.");
    return value;
  }

  const write = async (
    m: RegExpMatchArray,
    request: Request,
    run: (contentId: string, request: Request) => Promise<unknown>,
  ) => json(200, checked(WriteResult, await run(id(m), request), "write result"));

  const routes: Route[] = [
    {
      method: "GET",
      pattern: /^\/meta$/,
      run: async () =>
        json(200, checked(Meta, {
          api: "carrel-site-api",
          packageVersion: PACKAGE_VERSION,
          schemaHash: await schemaHash(),
          site: adapter.site,
          capabilities: CAPABILITIES,
        }, "meta")),
    },
    {
      method: "GET",
      pattern: /^\/content$/,
      run: async (_m, url) => json(200, checked(ContentList, await adapter.content.list(readQuery(url, ListQuery)), "content list")),
    },
    {
      method: "GET",
      pattern: new RegExp(`^/content/${ID}$`),
      run: async (m) => {
        const doc = await adapter.content.get(id(m));
        if (!doc) throw new NotFoundError();
        return json(200, checked(ContentDoc, doc, "content"));
      },
    },
    {
      method: "PUT",
      pattern: new RegExp(`^/content/${ID}/draft$`),
      run: (m, _u, r) => write(m, r, async (i, req) => adapter.content.saveDraft(i, await readBody(req, SaveDraftInput))),
    },
    {
      method: "POST",
      pattern: new RegExp(`^/content/${ID}/publish$`),
      run: (m, _u, r) => write(m, r, async (i, req) => adapter.content.publish(i, await readBody(req, PublishInput))),
    },
    {
      method: "POST",
      pattern: new RegExp(`^/content/${ID}/schedule$`),
      run: (m, _u, r) => write(m, r, async (i, req) => adapter.content.schedule(i, await readBody(req, ScheduleInput))),
    },
    {
      method: "POST",
      pattern: new RegExp(`^/content/${ID}/unpublish$`),
      run: (m, _u, r) => write(m, r, async (i, req) => adapter.content.unpublish(i, await readBody(req, UnpublishInput))),
    },
    {
      method: "GET",
      pattern: new RegExp(`^/content/${ID}/revisions$`),
      run: async (m) => {
        const items = await adapter.content.revisions(id(m));
        if (!items) throw new NotFoundError();
        return json(200, checked(RevisionList, { items }, "revisions"));
      },
    },
    {
      method: "GET",
      pattern: new RegExp(`^/content/${ID}/diff$`),
      run: async (m, url) => {
        const contentId = id(m);
        const query = readQuery(url, DiffQuery);
        const current = await adapter.content.get(contentId);
        if (!current) throw new NotFoundError();
        const to = query.to ?? current.version;
        const [before, after] = await Promise.all([
          adapter.content.revisionSource(contentId, query.from),
          to === current.version ? current.source : adapter.content.revisionSource(contentId, to),
        ]);
        if (before === null || after === null) throw new NotFoundError("No such version.");
        const patch = createTwoFilesPatch(`${contentId}@${query.from}`, `${contentId}@${to}`, before, after);
        return json(200, checked(Diff, { id: contentId, from: query.from, to, patch }, "diff"));
      },
    },
    {
      method: "POST",
      pattern: /^\/preview$/,
      run: async (_m, _u, request) => {
        const html = await adapter.preview.render(await readBody(request, PreviewInput));
        if (typeof html !== "string") throw new ContractBreach("preview: not a string");
        return new Response(html, {
          status: 200,
          headers: { ...BASE_HEADERS, "content-type": "text/html; charset=utf-8" },
        });
      },
    },
  ];

  const LATER = /^\/(media|inbox|insight|publications)(\/|$)/;

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // The URL parser has already resolved dot segments, so /api/carrel/v1/../admin arrives as /admin.
    if (!insidePrefix(url.pathname)) return fail("not-found", "Not found.");

    try {
      const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
      if (!(await limiter.limit({ key: ip })).success) {
        log({ siteApi: "refused", reason: "rate-limited" });
        return fail("rate-limited", "Too many requests.");
      }
    } catch (error) {
      log({ siteApi: "refused", reason: "limiter-failed", error: String(error) });
      return fail("unavailable", "The site API is unavailable.");
    }

    const expected = config.key?.trim() ?? "";
    if (expected.length < MIN_KEY_LENGTH) {
      log({ siteApi: "refused", reason: "not-configured" });
      return fail("not-configured", "The site API is not configured.");
    }
    const presented = bearer(request);
    if (!presented || !(await keysMatch(presented, expected))) {
      log({ siteApi: "refused", reason: presented ? "wrong-key" : "no-key" });
      return fail("unauthorized", "Unauthorized.");
    }

    const path = url.pathname.slice(PREFIX.length) || "/";
    if (LATER.test(path)) return fail("not-implemented", "This group arrives in a later stage.");

    const candidates = routes
      .map((route) => ({ route, match: path.match(route.pattern) }))
      .filter((c): c is { route: Route; match: RegExpMatchArray } => c.match !== null);
    if (candidates.length === 0) return fail("not-found", "No such route.");
    const hit = candidates.find((c) => c.route.method === request.method);
    if (!hit) return fail("method-not-allowed", "Method not allowed.");

    try {
      return await hit.route.run(hit.match, url, request);
    } catch (error) {
      if (error instanceof BadRequest) return fail(error.code, error.message);
      if (error instanceof VersionConflictError) {
        return fail("version-conflict", error.message, { currentVersion: error.currentVersion });
      }
      if (error instanceof NotFoundError) return fail("not-found", error.message);
      if (error instanceof RefusedError) return fail("refused", error.message);
      if (error instanceof ContractBreach) {
        log({ siteApi: "contract-breach", detail: error.message });
        return fail("internal", "The site answered outside the contract.");
      }
      log({ siteApi: "adapter-failed", error: error instanceof Error ? error.message : String(error) });
      return fail("internal", "The site failed to answer.");
    }
  }

  return {
    matches: (request) => insidePrefix(new URL(request.url).pathname),
    handle,
  };
}
