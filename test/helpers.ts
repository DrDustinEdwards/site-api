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
