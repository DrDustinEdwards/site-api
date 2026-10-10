// A site's own admin, talking to its own adapter in process. localClient(adapter) answers every
// method createSiteClient does, with the same types and the same SiteApiError, by handing each
// request straight to createSiteApi's handler: no network, no configured key, and the very code
// Carrel's requests meet. So every route rule, version check, upload check and zod parse is the one
// Carrel gets, and the content kit (./admin) runs the same against either client.

import type { SiteAdapter } from "./adapter.js";
import { createSiteClient, type SiteClient } from "./client.js";
import { createSiteApi } from "./server.js";

export interface LocalClientOptions {
  /** Where adapter failures and contract breaches are logged. Defaults to console, as createSiteApi does. */
  log?: (entry: Record<string, unknown>) => void;
}

/** A key that lives only in this closure: the handler insists on one, and nothing outside can learn it. */
function inProcessKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function localClient(adapter: SiteAdapter, options: LocalClientOptions = {}): SiteClient {
  const key = inProcessKey();
  const api = createSiteApi({
    adapter,
    key,
    // One person in their own admin is not a burst from the internet; the site's own sign-in guards this door.
    limiter: { limit: async () => ({ success: true }) },
    ...(options.log ? { log: options.log } : {}),
  });
  const handle = (async (input: RequestInfo | URL, init?: RequestInit) => api.handle(new Request(input, init))) as typeof fetch;
  return createSiteClient({ baseUrl: adapter.site.origin, key, fetch: handle });
}
