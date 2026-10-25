// v0.9.0: a site hears which public page a content write changed, so it can tell search engines (IndexNow).

import { describe, expect, it } from "vitest";
import { createSiteClient } from "../src/client.js";
import { createSiteApi } from "../src/index.js";
import { memoryAdapter } from "../src/testing.js";
import { KEY, ORIGIN, allow } from "./helpers.js";

describe("onPageChange (v0.9.0)", () => {
  it("names the page a publish, a live save, an unpublish and a delete change, never a draft's, and waits on nothing", async () => {
    const heard: string[][] = [];
    const pending: Promise<unknown>[] = [];
    const api = createSiteApi({ adapter: memoryAdapter(), key: KEY, limiter: allow, log: () => {}, onPageChange: (paths) => void heard.push(paths) });
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
      api.handle(new Request(input, init), { waitUntil: (p) => pending.push(p) })) as typeof globalThis.fetch;
    const c = createSiteClient({ baseUrl: ORIGIN, key: KEY, fetch });

    const draft = await c.saveDraft("a", { source: "# A\n", expectedVersion: null, changeId: "c1" });
    const live = await c.publish("a", { expectedVersion: draft.version, changeId: "c2" });
    const edited = await c.saveDraft("a", { source: "# A, edited\n", expectedVersion: live.version, changeId: "c3" });
    const down = await c.unpublish("a", { expectedVersion: edited.version, changeId: "c4" });
    const again = await c.publish("a", { expectedVersion: down.version, changeId: "c5" });
    await c.delete("a", { expectedVersion: again.version, changeId: "c6" });
    await Promise.all(pending);

    expect(heard).toEqual([["/blog/a"], ["/blog/a"], ["/blog/a"], ["/blog/a"], ["/blog/a"]]);
    expect(pending).toHaveLength(6);
  });
});
