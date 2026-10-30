// v0.15.0: the content group's new writes and list options, each optional per site, against the reference adapter.

import { describe, expect, it } from "vitest";
import { createSiteClient } from "../src/client.js";
import { memoryAdapter } from "../src/testing.js";
import { KEY, ORIGIN, site } from "./helpers.js";

function client(adapter = memoryAdapter()) {
  const s = site(adapter);
  return { ...s, c: createSiteClient({ baseUrl: ORIGIN, key: KEY, fetch: s.fetch }) };
}

describe("a settable publish date (v0.15.0)", () => {
  it("publishes under a past date, re-dates a live post, refuses a future one, and answers 501 where the site cannot", async () => {
    const { c } = client();
    const draft = await c.saveDraft("a", { source: "# A\n", expectedVersion: null, changeId: "c1" });
    const live = await c.publish("a", { expectedVersion: draft.version, changeId: "c2", publishedAt: "2020-05-01T12:00:00Z" });
    expect((await c.get("a")).publishedAt).toBe("2020-05-01T12:00:00.000Z");
    await c.publish("a", { expectedVersion: live.version, changeId: "c3", publishedAt: "2021-01-01T00:00:00Z" });
    expect((await c.get("a")).publishedAt).toBe("2021-01-01T00:00:00.000Z");

    const now = (await c.get("a")).version;
    await expect(c.publish("a", { expectedVersion: now, changeId: "c4", publishedAt: "2999-01-01T00:00:00Z" })).rejects.toMatchObject({ status: 400 });

    const without = memoryAdapter();
    delete without.content.publishedAtSettable;
    const other = client(without).c;
    const d = await other.saveDraft("a", { source: "# A\n", expectedVersion: null, changeId: "c1" });
    await expect(other.publish("a", { expectedVersion: d.version, changeId: "c2", publishedAt: "2020-05-01T12:00:00Z" })).rejects.toMatchObject({ status: 501 });
    expect((await other.meta()).capabilities.contentPublishedAt).toBeUndefined();
  });
});
