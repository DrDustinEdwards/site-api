import { describe, expect, it } from "vitest";
import { createSiteApi, siteApiStep } from "../src/index.js";
import { memoryAdapter } from "../src/testing.js";
import { allow, KEY, ORIGIN, req } from "./helpers.js";

describe("siteApiStep", () => {
  it("answers only the API and preview paths, and hands every API answer to the purge", async () => {
    let built = 0;
    const purged: string[] = [];
    const step = siteApiStep(() => {
      built++;
      return createSiteApi({ adapter: memoryAdapter(), key: KEY, limiter: allow });
    });
    const run = (request: Request) =>
      step(
        request,
        {},
        { waitUntil() {} },
        {
          url: new URL(request.url),
          stylesheets: async () => [],
          render: async () => new Response(null, { status: 500 }),
          // site-runtime's purgeAfterWrite decides from the method and the status.
          purgeAfterWrite: (_r, _response, why) => purged.push(why),
        },
      );

    expect(await run(new Request(`${ORIGIN}/blog/a`))).toBeUndefined();
    expect(built).toBe(0);

    const meta = await run(req("/api/carrel/v1/meta"));
    expect(meta?.status).toBe(200);
    // An unknown preview token is the package's own 404, never the site's page.
    expect((await run(new Request(`${ORIGIN}/preview/nothing`)))?.status).toBe(404);
    expect(purged).toEqual(["carrel GET /api/carrel/v1/meta"]);
  });
});
