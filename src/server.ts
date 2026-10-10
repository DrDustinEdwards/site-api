// The site side: one handler for everything under /api/carrel/v1.
//
// Order is the guard: prefix, then rate limit, then key, then route. A request outside the prefix
// is never served, whatever key it carries; a request without the key learns nothing about routes.

import { createTwoFilesPatch } from "diff";
import type { z } from "zod";
import {
  capabilitiesOf,
  MediaInUseError,
  NotFoundError,
  RefusedError,
  VersionConflictError,
  type SiteAdapter,
} from "./adapter.js";
import {
  ContentDeleteQuery,
  ContentDeleteResult,
  ContentDoc,
  ContentId,
  ContentList,
  ContentTagsInput,
  Diff,
  DiffQuery,
  ListQuery,
  MediaDeleteQuery,
  MediaAltInput,
  MediaBulkInput,
  MediaBulkResult,
  MediaDeleteResult,
  MediaDetail,
  MediaId,
  MediaItem,
  MediaList,
  MediaListQuery,
  MediaTagsInput,
  MediaTrashEmptyInput,
  MediaTrashEmptyResult,
  MAX_TRASH_EMPTY,
  MediaTrashInput,
  MediaUploadQuery,
  MediaWriteResult,
  MentionDecideInput,
  MentionDeleteQuery,
  MentionDeleteResult,
  MentionId,
  MentionList,
  MentionListQuery,
  MentionSweepInput,
  MentionSweepResult,
  MentionWriteResult,
  Meta,
  PACKAGE_VERSION,
  PREFIX,
  PreviewInput,
  PublishInput,
  RevisionList,
  RevisionSource,
  SaveDraftInput,
  ScheduleInput,
  UnpublishInput,
  Version,
  WriteResult,
  schemaHash,
  type ErrorBody,
  type ErrorCode,
  type MediaBulkOutcome,
  type MediaUse,
} from "./contract.js";
import { checkUpload, essence, readUpload } from "./media.js";

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

/** The Workers runtime's constant-time compare. Node, which runs the tests, has no such method. */
type TimingSafe = { timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean };

/**
 * Compares digests, not the keys, so the time taken says nothing about the key's length or prefix.
 * Both digests are 32 bytes. The Workers runtime compares them with crypto.subtle.timingSafeEqual
 * (Cloudflare's Workers best practices, "Secret comparison"); where it is missing a loop that
 * visits every byte does the same.
 */
export async function keysMatch(presented: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  const native = (crypto.subtle as TimingSafe).timingSafeEqual;
  if (native) return native.call(crypto.subtle, a, b);
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
          capabilities: capabilitiesOf(adapter),
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
      pattern: new RegExp(`^/content/${ID}/revisions/${ID}$`),
      run: async (m) => {
        const contentId = id(m);
        let version: string;
        try {
          version = decodeURIComponent(m[2]!);
        } catch {
          throw new BadRequest("invalid", "The version is not valid.");
        }
        if (!Version.safeParse(version).success) throw new BadRequest("invalid", "The version is not valid.");
        const source = await adapter.content.revisionSource(contentId, version);
        if (source === null) throw new NotFoundError("No such version.");
        return json(200, checked(RevisionSource, { id: contentId, version, source }, "revision source"));
      },
    },
    {
      method: "DELETE",
      pattern: new RegExp(`^/content/${ID}$`),
      run: async (m, url) => {
        const contentId = id(m);
        // A site with no delete answers 501 whatever the query says.
        if (!adapter.content.delete) return fail("not-implemented", "This site does not delete content through the API.");
        const query = readQuery(url, ContentDeleteQuery);
        await adapter.content.delete(contentId, query);
        return json(200, checked(ContentDeleteResult, { id: contentId, deleted: true, changeId: query.changeId }, "content delete"));
      },
    },
    {
      method: "PUT",
      pattern: new RegExp(`^/content/${ID}/tags$`),
      run: async (m, _u, request) => {
        const contentId = id(m);
        const setTags = adapter.content.setTags;
        if (!setTags) return fail("not-implemented", "This site does not keep tags on posts through the API.");
        const input = await readBody(request, ContentTagsInput);
        // One spelling per tag: the first one given wins, so "News" and "news" are one tag.
        const seen = new Set<string>();
        const tags = input.tags.filter((t) => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
        return json(200, checked(WriteResult, await setTags.call(adapter.content, contentId, { ...input, tags }), "content tags"));
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

  // ---------- media (v0.2.0), mounted only when the site's adapter has it

  const media = adapter.media;

  function mediaId(m: RegExpMatchArray): string {
    let value: string;
    try {
      value = decodeURIComponent(m[1]!);
    } catch {
      throw new BadRequest("invalid", "The media id is not valid.");
    }
    if (!MediaId.safeParse(value).success) throw new BadRequest("invalid", "The media id is not valid.");
    return value;
  }

  if (media) {
    routes.push(
      {
        method: "GET",
        pattern: /^\/media$/,
        run: async (_m, url) => {
          const query = readQuery(url, MediaListQuery);
          if (query.lens && !(media.lenses ?? []).includes(query.lens)) return fail("not-implemented", `This site does not offer the ${query.lens} lens.`);
          return json(200, checked(MediaList, await media.list(query), "media list"));
        },
      },
      {
        method: "POST",
        pattern: /^\/media$/,
        run: async (_m, url, request) => {
          const query = readQuery(url, MediaUploadQuery);
          const contentType = essence(request.headers.get("content-type"));
          // The type first, so a file the site does not accept is never read at all.
          const wrongType = checkUpload(contentType, null, media.limits);
          if (wrongType) throw new BadRequest(wrongType.code, wrongType.message);
          const read = await readUpload(request, media.limits);
          if (!read.ok) throw new BadRequest(read.refusal.code, read.refusal.message);
          const wrongBytes = checkUpload(contentType, read.bytes, media.limits);
          if (wrongBytes) throw new BadRequest(wrongBytes.code, wrongBytes.message);
          const item = await media.upload({ bytes: read.bytes, contentType, filename: query.filename, alt: query.alt, changeId: query.changeId });
          return json(201, checked(MediaItem, item, "uploaded media"));
        },
      },
      {
        method: "GET",
        pattern: new RegExp(`^/media/${ID}$`),
        run: async (m) => {
          const item = await media.get(mediaId(m));
          if (!item) throw new NotFoundError("No such media.");
          return json(200, checked(MediaDetail, item, "media"));
        },
      },
      {
        method: "DELETE",
        pattern: new RegExp(`^/media/${ID}$`),
        run: async (m, url) => {
          const id = mediaId(m);
          const { changeId } = readQuery(url, MediaDeleteQuery);
          await media.delete(id, { changeId });
          return json(200, checked(MediaDeleteResult, { id, deleted: true, changeId }, "media delete"));
        },
      },
      // v0.4.0 writes. A site whose adapter lacks the method answers 501 whatever the body says.
      {
        method: "PUT",
        pattern: new RegExp(`^/media/${ID}/alt$`),
        run: async (m, _u, request) => {
          const id = mediaId(m);
          if (!media.setAlt) return fail("not-implemented", "This site does not edit alt text through the API.");
          const input = await readBody(request, MediaAltInput);
          const result = await media.setAlt(id, input);
          return json(200, checked(MediaWriteResult, { id, version: result.version, changeId: input.changeId }, "media alt"));
        },
      },
      {
        method: "PUT",
        pattern: new RegExp(`^/media/${ID}/tags$`),
        run: async (m, _u, request) => {
          const id = mediaId(m);
          if (!media.setTags) return fail("not-implemented", "This site does not keep media tags.");
          const input = await readBody(request, MediaTagsInput);
          const result = await media.setTags(id, { ...input, tags: [...new Set(input.tags)].sort() });
          return json(200, checked(MediaWriteResult, { id, version: result.version, changeId: input.changeId }, "media tags"));
        },
      },
      {
        method: "POST",
        pattern: new RegExp(`^/media/${ID}/trash$`),
        run: async (m, _u, request) => {
          const id = mediaId(m);
          if (!media.trash || !media.restore) return fail("not-implemented", "This site has no media trash.");
          const input = await readBody(request, MediaTrashInput);
          const result = await media.trash(id, input);
          return json(200, checked(MediaWriteResult, { id, version: result.version, changeId: input.changeId }, "media trash"));
        },
      },
      {
        method: "POST",
        pattern: new RegExp(`^/media/${ID}/restore$`),
        run: async (m, _u, request) => {
          const id = mediaId(m);
          if (!media.trash || !media.restore) return fail("not-implemented", "This site has no media trash.");
          const input = await readBody(request, MediaTrashInput);
          const result = await media.restore(id, input);
          return json(200, checked(MediaWriteResult, { id, version: result.version, changeId: input.changeId }, "media restore"));
        },
      },
      {
        method: "POST",
        pattern: /^\/media\/trash\/empty$/,
        run: async (_m, _u, request) => {
          if (!media.trash || !media.restore) return fail("not-implemented", "This site has no media trash.");
          const input = await readBody(request, MediaTrashEmptyInput);
          // Gather first, then delete: a cursor into a list that is shrinking would skip files.
          const ids: string[] = [];
          let cursor: string | undefined;
          do {
            const page = await media.list({ trashed: "only", limit: 200, ...(cursor ? { cursor } : {}) });
            for (const item of page.items) if (item.trashedAt) ids.push(item.id);
            cursor = page.nextCursor ?? undefined;
          } while (cursor && ids.length <= MAX_TRASH_EMPTY);
          const more = ids.length > MAX_TRASH_EMPTY;
          const deleted: string[] = [];
          const refused: Array<{ id: string; message: string; usedBy?: MediaUse[] }> = [];
          for (const [n, id] of ids.slice(0, MAX_TRASH_EMPTY).entries()) {
            try {
              await media.delete(id, { changeId: `${input.changeId}-${n + 1}` });
              deleted.push(id);
            } catch (error) {
              const failure = describeFailure(error);
              if (failure.code !== "refused" && failure.code !== "not-found") throw error;
              refused.push({ id, message: failure.message, ...(failure.usedBy ? { usedBy: failure.usedBy } : {}) });
            }
          }
          return json(200, checked(MediaTrashEmptyResult, { changeId: input.changeId, deleted, refused, more }, "media trash empty"));
        },
      },
      {
        method: "POST",
        pattern: /^\/media\/bulk$/,
        run: async (_m, _u, request) => {
          const input = await readBody(request, MediaBulkInput);
          const lacking = bulkLacking(media, input.op);
          if (lacking) return fail("not-implemented", lacking);
          if ((input.op === "add-tags" || input.op === "remove-tags") && (!input.tags || input.tags.length === 0)) {
            throw new BadRequest("invalid", "tags: name at least one tag.");
          }
          const results: MediaBulkOutcome[] = [];
          // One at a time, in order: a site's index and cache purge are not built for a burst, and one
          // file's refusal (a stale version, a file in use) is that file's outcome and nothing more.
          for (const item of input.items) {
            results.push(await bulkOne(media, input.op, input.tags ?? [], item));
          }
          return json(200, checked(MediaBulkResult, { op: input.op, results }, "media bulk"));
        },
      },
    );
  }

  /** What a bulk op needs that the adapter lacks, as the 501 message, else null. */
  function bulkLacking(m: NonNullable<typeof media>, op: MediaBulkInput["op"]): string | null {
    if ((op === "trash" || op === "restore") && !(m.trash && m.restore)) return "This site has no media trash.";
    if ((op === "add-tags" || op === "remove-tags") && !m.setTags) return "This site does not keep media tags.";
    return null;
  }

  /** One file's bulk outcome. Every failure is caught here, so no file's failure stops the next. */
  async function bulkOne(
    m: NonNullable<typeof media>,
    op: MediaBulkInput["op"],
    tags: string[],
    item: MediaBulkInput["items"][number],
  ): Promise<MediaBulkOutcome> {
    const { id, changeId } = item;
    try {
      if (op === "delete") {
        await m.delete(id, { changeId });
        return { ok: true, id, changeId };
      }
      const expectedVersion = item.expectedVersion;
      if (!expectedVersion) throw new BadRequest("invalid", `expectedVersion: ${op} needs the version the caller last saw.`);
      if (op === "trash" || op === "restore") {
        const result = await (op === "trash" ? m.trash!(id, { expectedVersion, changeId }) : m.restore!(id, { expectedVersion, changeId }));
        return { ok: true, id, changeId, version: checked(MediaWriteResult, { id, version: result.version, changeId }, `media ${op}`).version };
      }
      // Tags: the new set is worked out from what the site holds now, and refused if that is not the
      // version the caller saw. The adapter checks again on the write, which closes the gap.
      const current = await m.get(id);
      if (!current) throw new NotFoundError("No such media.");
      if (current.version !== expectedVersion) throw new VersionConflictError(current.version ?? null);
      const held = new Set(current.tags ?? []);
      for (const tag of tags) {
        if (op === "add-tags") held.add(tag);
        else held.delete(tag);
      }
      const next = [...held].sort();
      if (!MediaTagsInput.shape.tags.safeParse(next).success) throw new RefusedError("A file carries at most 12 tags.");
      const result = await m.setTags!(id, { tags: next, expectedVersion, changeId });
      return { ok: true, id, changeId, version: checked(MediaWriteResult, { id, version: result.version, changeId }, "media tags").version };
    } catch (error) {
      const failure = describeFailure(error);
      const code = (["not-found", "version-conflict", "refused", "invalid"] as const).find((c) => c === failure.code) ?? "internal";
      return {
        ok: false,
        id,
        changeId,
        error: code,
        message: failure.message,
        ...(failure.currentVersion !== undefined ? { currentVersion: failure.currentVersion } : {}),
        ...(failure.usedBy ? { usedBy: failure.usedBy } : {}),
      };
    }
  }

  /** The contract's name and words for a failure, for the single routes and for one file of a bulk. */
  function describeFailure(error: unknown): { code: ErrorCode; message: string; currentVersion?: string | null; usedBy?: MediaUse[] } {
    if (error instanceof BadRequest) return { code: error.code, message: error.message };
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


  // ---------- mentions (v0.5.0), mounted only when the site's adapter has it

  const mentions = adapter.mentions;

  function mentionId(m: RegExpMatchArray): string {
    let value: string;
    try {
      value = decodeURIComponent(m[1]!);
    } catch {
      throw new BadRequest("invalid", "The mention id is not valid.");
    }
    if (!MentionId.safeParse(value).success) throw new BadRequest("invalid", "The mention id is not valid.");
    return value;
  }

  if (mentions) {
    routes.push(
      {
        method: "GET",
        pattern: /^\/mentions$/,
        run: async (_m, url) => json(200, checked(MentionList, await mentions.list(readQuery(url, MentionListQuery)), "mentions list")),
      },
      {
        method: "POST",
        pattern: /^\/mentions\/sweep$/,
        run: async (_m, _u, request) => {
          const input = await readBody(request, MentionSweepInput);
          const removed = await mentions.sweep(input);
          return json(200, checked(MentionSweepResult, { changeId: input.changeId, removed }, "mentions sweep"));
        },
      },
      {
        method: "POST",
        pattern: new RegExp(`^/mentions/${ID}/decide$`),
        run: async (m, _u, request) => {
          const id = mentionId(m);
          const input = await readBody(request, MentionDecideInput);
          const { decision, ...rest } = input;
          let result;
          if (decision === "reset") {
            if (!mentions.reset) return fail("not-implemented", "This site does not take a mention decision back.");
            result = await mentions.reset(id, rest);
          } else {
            result = await mentions.decide(id, { ...rest, decision });
          }
          return json(200, checked(MentionWriteResult, { id, ...result, changeId: input.changeId }, "mention decision"));
        },
      },
      {
        method: "DELETE",
        pattern: new RegExp(`^/mentions/${ID}$`),
        run: async (m, url) => {
          const id = mentionId(m);
          const query = readQuery(url, MentionDeleteQuery);
          const result = await mentions.delete(id, query);
          return json(200, checked(MentionDeleteResult, { id, deleted: true, changeId: query.changeId, purged: result.purged }, "mention delete"));
        },
      },
    );
  }

  // Groups a site has not implemented. Media and mentions leave this list when the adapter has them.
  const LATER = new RegExp(
    `^/(${[...(media ? [] : ["media"]), ...(mentions ? [] : ["mentions"]), "inbox", "insight", "publications"].join("|")})(/|$)`,
  );

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
      const failure = describeFailure(error);
      return fail(failure.code, failure.message, {
        ...(failure.currentVersion !== undefined ? { currentVersion: failure.currentVersion } : {}),
        ...(failure.usedBy ? { usedBy: failure.usedBy } : {}),
      });
    }
  }

  return {
    matches: (request) => insidePrefix(new URL(request.url).pathname),
    handle,
  };
}
