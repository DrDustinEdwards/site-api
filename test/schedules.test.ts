// v0.10.0: a live post carries a scheduled update; the live version stays served until the cron applies it, and the
// publish hooks hear every page a request or a schedule changes.

import { describe, expect, it } from "vitest";
import { createSiteClient, SiteApiError } from "../src/client.js";
import { createSiteApi, indexNowHook, type PublishEvent } from "../src/index.js";
import { memoryAdapter } from "../src/testing.js";
import { KEY, ORIGIN, allow } from "./helpers.js";

const LIVE = "---\ntitle: Live\n---\nThe live words.\n";
const NEXT = "---\ntitle: Live\n---\nThe updated words.\n";

function mounted(adapter = memoryAdapter()) {
  const heard: PublishEvent[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const pending: Promise<unknown>[] = [];
  const api = createSiteApi({
    adapter,
    key: KEY,
    limiter: allow,
    log: (entry) => logs.push(entry),
    hooks: [{ name: "record", run: (event) => void heard.push(event) }],
  });
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    api.handle(new Request(input, init), { waitUntil: (p) => pending.push(p) })) as typeof globalThis.fetch;
  const client = createSiteClient({ baseUrl: ORIGIN, key: KEY, fetch });
  const settle = () => Promise.all(pending.splice(0));
  return { api, adapter, client, heard, logs, settle };
}

async function livePost(client: ReturnType<typeof createSiteClient>) {
  const draft = await client.saveDraft("a", { source: LIVE, expectedVersion: null, changeId: "c1" });
  return client.publish("a", { expectedVersion: draft.version, changeId: "c2" });
}

describe("scheduled updates (v0.10.0)", () => {
  it("keeps the live version served until the time, then the cron puts the update live once and the hooks hear it", async () => {
    const { api, client, heard, settle } = mounted();
    const live = await livePost(client);

    const scheduled = await client.schedule("a", { expectedVersion: live.version, changeId: "c3", source: NEXT, publishAt: "2030-01-01T09:00:00-06:00" });
    expect(scheduled).toMatchObject({ status: "published", scheduledUpdate: { publishAt: "2030-01-01T09:00:00-06:00", changeId: "c3" } });
    expect(scheduled.version).not.toBe(live.version);
    expect(await client.get("a")).toMatchObject({ status: "published", source: LIVE, scheduledUpdate: { changeId: "c3" } });
    expect(await client.scheduledUpdate("a")).toMatchObject({ id: "a", source: NEXT, changeId: "c3" });

    // A reschedule replaces what was waiting.
    const moved = await client.schedule("a", { expectedVersion: scheduled.version, changeId: "c4", source: NEXT, publishAt: "2030-02-01T15:00:00Z" });
    expect(moved.scheduledUpdate).toEqual({ publishAt: "2030-02-01T15:00:00Z", changeId: "c4" });

    expect(await api.runSchedules({ now: new Date("2030-02-01T14:59:59Z") })).toEqual({ applied: [], skipped: 0, failed: 0, more: false });
    expect((await client.get("a")).source).toBe(LIVE);

    const run = await api.runSchedules({ now: new Date("2030-02-01T15:00:00Z") });
    expect(run.applied).toEqual([{ id: "a", kind: "update", publishAt: "2030-02-01T15:00:00Z", changeId: "c4", version: expect.any(String) }]);
    expect(await client.get("a")).toMatchObject({ status: "published", source: NEXT, scheduledUpdate: null });
    expect((await api.runSchedules({ now: new Date("2030-03-01T00:00:00Z") })).applied).toEqual([]);

    await settle();
    expect(heard.map((e) => [e.action, e.trigger, e.changeId, e.url])).toEqual([
      ["publish", "request", "c2", "https://memory.example/blog/a"],
      ["update", "schedule", "c4", "https://memory.example/blog/a"],
    ]);
  });

  it("cancels an update and keeps the post live; an unpublish drops it, so the cron never brings the post back", async () => {
    const { api, client } = mounted();
    const live = await livePost(client);
    const scheduled = await client.schedule("a", { expectedVersion: live.version, changeId: "c3", source: NEXT, publishAt: "2030-01-01T00:00:00Z" });

    const canceled = await client.cancelSchedule("a", { expectedVersion: scheduled.version, changeId: "c4" });
    expect(canceled).toMatchObject({ status: "published", scheduledUpdate: null });
    expect(await client.scheduledUpdate("a").catch((e: SiteApiError) => e.status)).toBe(404);
    const refused = await client.cancelSchedule("a", { expectedVersion: canceled.version, changeId: "c5" }).catch((e: SiteApiError) => e.status);
    expect(refused).toBe(422);

    const again = await client.schedule("a", { expectedVersion: canceled.version, changeId: "c6", source: NEXT, publishAt: "2030-01-01T00:00:00Z" });
    await client.unpublish("a", { expectedVersion: again.version, changeId: "c7" });
    expect(await api.runSchedules({ now: new Date("2031-01-01T00:00:00Z") })).toMatchObject({ applied: [] });
    expect(await client.get("a")).toMatchObject({ status: "draft", source: LIVE });
  });

  it("publishes a scheduled draft at its time, at the time it was scheduled for, and a cancel returns it to draft", async () => {
    const { api, client, heard, settle } = mounted();
    const draft = await client.saveDraft("b", { source: "# B\n", expectedVersion: null, changeId: "c1" });
    const scheduled = await client.schedule("b", { expectedVersion: draft.version, changeId: "c2", publishAt: "2030-01-01T00:00:00Z" });
    expect(scheduled.status).toBe("scheduled");

    const run = await api.runSchedules({ now: new Date("2030-01-01T00:05:00Z") });
    expect(run.applied.map((a) => [a.id, a.kind, a.changeId])).toEqual([["b", "publish", "c2"]]);
    expect(await client.get("b")).toMatchObject({ status: "published", publishedAt: "2030-01-01T00:00:00.000Z" });
    await settle();
    expect(heard.map((e) => [e.action, e.trigger])).toEqual([["publish", "schedule"]]);

    const other = await client.saveDraft("c", { source: "# C\n", expectedVersion: null, changeId: "c3" });
    const later = await client.schedule("c", { expectedVersion: other.version, changeId: "c4", publishAt: "2030-01-01T00:00:00Z" });
    expect(await client.cancelSchedule("c", { expectedVersion: later.version, changeId: "c5" })).toMatchObject({ status: "draft" });
  });

  it("refuses a schedule on a live post where the site has no scheduled updates, and leaves the post live", async () => {
    const { client } = mounted(memoryAdapter({ schedules: false }));
    const live = await livePost(client);
    const error = await client.schedule("a", { expectedVersion: live.version, changeId: "c3", source: NEXT, publishAt: "2030-01-01T00:00:00Z" }).catch((e: SiteApiError) => e);
    expect(error).toMatchObject({ status: 422, body: { error: "refused" } });
    expect(await client.get("a")).toMatchObject({ status: "published", source: LIVE, version: live.version });
    expect(await client.scheduledUpdate("a").catch((e: SiteApiError) => e.status)).toBe(501);
  });
});

describe("publish hooks (v0.10.0)", () => {
  it("logs a hook that fails and never fails the write; the IndexNow hook sends the page through the site's submit", async () => {
    const sent: Array<{ urls: string[]; from?: string }> = [];
    const logs: Array<Record<string, unknown>> = [];
    const adapter = memoryAdapter({ site: { id: "memory", name: "Memory site", origin: ORIGIN } });
    const api = createSiteApi({
      adapter,
      key: KEY,
      limiter: allow,
      log: (entry) => logs.push(entry),
      hooks: [
        { name: "broken", run: () => Promise.reject(new Error("boom")) },
        indexNowHook({ origin: ORIGIN, key: "indexnow-key", submit: async (input) => {
          sent.push(input);
          return true;
        } }),
      ],
    });
    const client = createSiteClient({ baseUrl: ORIGIN, key: KEY, fetch: (async (i: RequestInfo | URL, init?: RequestInit) => api.handle(new Request(i, init))) as typeof fetch });
    const preview = createSiteClient({ baseUrl: "https://preview.workers.dev", key: KEY, fetch: (async (i: RequestInfo | URL, init?: RequestInit) => api.handle(new Request(i, init))) as typeof fetch });

    const draft = await client.saveDraft("a", { source: LIVE, expectedVersion: null, changeId: "c1" });
    expect(await client.publish("a", { expectedVersion: draft.version, changeId: "c2" })).toMatchObject({ status: "published" });
    const live = await client.get("a");
    await preview.saveDraft("a", { source: NEXT, expectedVersion: live.version, changeId: "c3" });

    // The preview's save is heard, but the IndexNow hook tells nobody about a page on another origin.
    expect(sent).toEqual([{ origin: ORIGIN, key: "indexnow-key", urls: [`${ORIGIN}/blog/a`], from: `${ORIGIN}/api/carrel/v1/content/a/publish` }]);
    const page = { id: "a", path: "/blog/a", url: `${ORIGIN}/blog/a`, trigger: "request", error: "boom" };
    expect(logs.filter((l) => l.siteApi === "hook-failed")).toEqual([
      { siteApi: "hook-failed", hook: "broken", action: "publish", changeId: "c2", ...page },
      { siteApi: "hook-failed", hook: "broken", action: "update", changeId: "c3", ...page },
    ]);
  });
});
