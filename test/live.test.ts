// v0.17.0: the keyless live check (bin/site-api-live.mjs), run as devkit runs it, against a local site.

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createSiteApi } from "../src/index.js";
import { d1SiteApiStore, SITE_API_STORE_SQL } from "../src/store.js";
import { memoryAdapter } from "../src/testing.js";
import { d1 } from "./d1.js";
import { KEY, allow } from "./helpers.js";

/** A site on a local port: `handle` answers each request as the site's Worker would. */
async function serve(handle: (request: Request) => Promise<Response>) {
  const server = createServer(async (req, res) => {
    const response = await handle(new Request(`http://${req.headers.host}${req.url}`, { headers: req.headers as Record<string, string> }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

function live(origin: string, from = "test"): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    execFile(process.execPath, ["bin/site-api-live.mjs", "--origin", origin, "--from", from], (error, stdout) => done({ code: error ? Number(error.code) : 0, out: stdout }));
  });
}

describe("site-api-live", () => {
  it("is clean on a site that mounts the package and its preview links, and names each finding on one that does not", async () => {
    const api = createSiteApi({ adapter: memoryAdapter(), key: KEY, limiter: allow, log: () => {}, store: d1SiteApiStore(d1(SITE_API_STORE_SQL)) });
    // v0.19.0: a header layer that adds `private` still passes K4.
    const good = await serve(async (request) => {
      const answer = api.matchesPreviewLink(request) ? await api.servePreviewLink(request) : api.matches(request) ? await api.handle(request) : new Response("page");
      const headers = new Headers(answer.headers);
      headers.set("cache-control", "private, no-store");
      return new Response(answer.body, { status: answer.status, headers });
    });
    // A site that answers unknown routes before the key and has no preview links mounted yet.
    const leaky = await serve(async (request) =>
      new URL(request.url).pathname.endsWith("/meta") ? api.handle(request) : new Response("Not found", { status: 404 }),
    );
    try {
      expect(await live(good.origin)).toEqual({ code: 0, out: "" });
      // v0.19.0: --from is where the site is served now, as devkit runs it, so the probes go there and not to --origin.
      expect(await live("https://site.invalid", good.origin)).toEqual({ code: 0, out: "" });
      const found = await live(leaky.origin);
      expect(found.code).toBe(1);
      expect(found.out).toMatch(/^::error title=K4::http:\/\/127\.0\.0\.1:\d+\/api\/carrel\/v1\/site-api-live-[0-9a-f]+ an unknown route answered 404 without the key, expected 401$/m);
      expect(found.out).toMatch(/^::warning title=E2::.*\/preview\/\S+ answers the site's own 404/m);
      expect((await live("not an address")).code).toBe(2);
    } finally {
      good.close();
      leaky.close();
    }
  });
});
