import { createSiteApi, type RateLimiter, type SiteAdapter } from "../src/index.js";
import { memoryAdapter } from "../src/testing.js";

export const KEY = "k".repeat(24) + "-test-key-0123456789";
export const ORIGIN = "https://site.example";

export const allow: RateLimiter = { limit: async () => ({ success: true }) };

/** A site: the package mounted at its prefix, with every other path answered as the site's own 200 page. */
export function site<A extends SiteAdapter = ReturnType<typeof memoryAdapter>>(
  adapter: A = memoryAdapter() as SiteAdapter as A,
  options: { limiter?: RateLimiter; key?: string | undefined } = {},
) {
  const logs: Array<Record<string, unknown>> = [];
  const api = createSiteApi({
    adapter,
    key: "key" in options ? options.key : KEY,
    limiter: options.limiter ?? allow,
    log: (entry) => logs.push(entry),
  });
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (api.matches(request)) return api.handle(request);
    return new Response("<html>the site's own page</html>", { status: path404(request) ? 404 : 200 });
  }) as typeof globalThis.fetch;
  return { api, fetch, logs, adapter };
}

/** The fake site serves only / and /blog/*; everything else is its own 404. */
function path404(request: Request) {
  const { pathname } = new URL(request.url);
  return !(pathname === "/" || pathname.startsWith("/blog/"));
}

export function req(path: string, init: RequestInit & { key?: string | null } = {}) {
  const { key = KEY, headers, ...rest } = init;
  return new Request(`${ORIGIN}${path}`, {
    ...rest,
    headers: { ...(key === null ? {} : { authorization: `Bearer ${key}` }), ...(headers as Record<string, string>) },
  });
}

export function body(value: unknown): RequestInit {
  return { body: JSON.stringify(value), headers: { "content-type": "application/json" } };
}

/** A PNG the reference site can measure (its IHDR), with tEXt chunks for embedded metadata. CRCs are left zero. */
export function png(width: number, height: number, text: Record<string, string> = {}, salt = 0): Uint8Array {
  const chunk = (type: string, data: number[]) => {
    const length = [24, 16, 8, 0].map((s) => (data.length >>> s) & 255);
    return [...length, ...[...type].map((c) => c.charCodeAt(0)), ...data, 0, 0, 0, salt];
  };
  const be = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255);
  const texts = Object.entries(text).flatMap(([k, v]) => chunk("tEXt", [...[...k].map((c) => c.charCodeAt(0)), 0, ...[...v].map((c) => c.charCodeAt(0))]));
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk("IHDR", [...be(width), ...be(height), 8, 2, 0, 0, 0]), ...texts]);
}
