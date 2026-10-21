// The site side: one handler for everything under /api/carrel/v1.
//
// Order is the guard: prefix, then rate limit, then key, then route. A request outside the prefix
// is never served, whatever key it carries; a request without the key learns nothing about routes.

import type { SiteAdapter } from "./adapter.js";
import { PREFIX } from "./contract.js";
import { contentRoutes } from "./server/content.js";
import { describeFailure, fail, type Route } from "./server/http.js";
import { mediaRoutes } from "./server/media.js";
import { mentionsRoutes } from "./server/mentions.js";

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

export function createSiteApi(config: SiteApiConfig): SiteApi {
  const { adapter, limiter } = config;
  const log = config.log ?? ((entry) => console.warn(JSON.stringify(entry)));
  const { media, mentions } = adapter;

  const routes: Route[] = [
    ...contentRoutes(adapter),
    ...(media ? mediaRoutes(media, log) : []),
    ...(mentions ? mentionsRoutes(mentions) : []),
  ];

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
      const failure = describeFailure(error, log);
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
