import { describe, expect, it } from "vitest";
import { createSiteApi, siteApiStep } from "../src/index.js";
import { memoryAdapter } from "../src/testing.js";
import { allow, body, KEY, ORIGIN, req } from "./helpers.js";

function stepRunner(api: ReturnType<typeof createSiteApi>, purged: string[], seen: string[] = []) {
  const step = siteApiStep((_env, _kit, request) => {
    seen.push(new URL(request.url).pathname);
    return api;
  });
  return (request: Request) =>
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
}

describe("siteApiStep", () => {
  it("answers only the API and preview paths, and hands every API answer to the purge", async () => {
    const purged: string[] = [];
    const seen: string[] = [];
    const run = stepRunner(
      createSiteApi({ adapter: memoryAdapter(), key: KEY, limiter: allow }),
      purged,
      seen,
    );

    expect(await run(new Request(`${ORIGIN}/blog/a`))).toBeUndefined();
    expect(seen).toEqual([]);

    const meta = await run(req("/api/carrel/v1/meta"));
    expect(meta?.status).toBe(200);
    // An unknown preview token is the package's own 404, never the site's page.
    expect((await run(new Request(`${ORIGIN}/preview/nothing`)))?.status).toBe(404);
    expect(seen).toEqual(["/api/carrel/v1/meta", "/preview/nothing"]);
    expect(purged).toEqual(["carrel GET /api/carrel/v1/meta"]);
  });

  it("purges for a publish and a draft over a live post, never for a draft of an item that is not live", async () => {
    const purged: string[] = [];
    const run = stepRunner(
      createSiteApi({ adapter: memoryAdapter(), key: KEY, limiter: allow }),
      purged,
    );
    const source = "---\ntitle: A\n---\n\nText\n";
    const saved = (await (
      await run(
        req("/api/carrel/v1/content/preview-links-a/draft", {
          method: "PUT",
          ...body({ source, expectedVersion: null, changeId: "c1" }),
        }),
      )
    )?.json()) as { version: string };
    expect(purged).toEqual([]);
    const published = (await (
      await run(
        req("/api/carrel/v1/content/preview-links-a/publish", {
          method: "POST",
          ...body({ expectedVersion: saved.version, changeId: "c2" }),
        }),
      )
    )?.json()) as { version: string };
    await run(
      req("/api/carrel/v1/content/preview-links-a/draft", {
        method: "PUT",
        ...body({ source: source + "More\n", expectedVersion: published.version, changeId: "c3" }),
      }),
    );
    expect(purged).toEqual([
      "carrel POST /api/carrel/v1/content/preview-links-a/publish",
      "carrel PUT /api/carrel/v1/content/preview-links-a/draft",
    ]);
  });
});
