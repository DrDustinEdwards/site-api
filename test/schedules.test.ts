// A live post carries a scheduled update; the live version stays served until the cron applies it, and the
// publish hooks hear every page a request or a schedule changes.

import { isDatabaseDown } from "@dustinedwards/site-runtime/log";
import { describe, expect, it } from "vitest";
import { createSiteClient, SiteApiError } from "../src/client.js";
import { createSiteApi, indexNowHook, type PublishEvent } from "../src/index.js";
import { d1SiteApiStore, SITE_API_STORE_SQL } from "../src/store.js";
import { d1 } from "./d1.js";
import { memoryAdapter } from "../src/testing.js";
import { KEY, ORIGIN, allow, body, clientOf, req } from "./helpers.js";

const LIVE = "---\ntitle: Live\n---\nThe live words.\n";
const NEXT = "---\ntitle: Live\n---\nThe updated words.\n";

function siteWithHooks(
  hooks: NonNullable<Parameters<typeof createSiteApi>[0]["hooks"]>,
  extra: { store?: ReturnType<typeof d1SiteApiStore> } = {},
) {
  const logs: Array<Record<string, unknown>> = [];
  const adapter = memoryAdapter({ site: { id: "memory", name: "Memory site", origin: ORIGIN } });
  const api = createSiteApi({
    adapter,
    key: KEY,
    limiter: allow,
    log: (entry) => logs.push(entry),
    hooks,
    ...extra,
  });
  return { api, adapter, logs };
}

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
    api.handle(new Request(input, init), {
      waitUntil: (p) => pending.push(p),
    })) as typeof globalThis.fetch;
  const client = createSiteClient({ baseUrl: ORIGIN, key: KEY, fetch });
  const settle = () => Promise.all(pending.splice(0));
  return { api, adapter, client, heard, logs, settle };
}

async function livePost(client: ReturnType<typeof createSiteClient>) {
  const draft = await client.saveDraft("a", {
    source: LIVE,
    expectedVersion: null,
    changeId: "c1",
  });
  return client.publish("a", { expectedVersion: draft.version, changeId: "c2" });
}

describe("scheduled updates", () => {
  it("keeps the live version served until the time, then the cron puts the update live once and the hooks hear it", async () => {
    const { api, client, heard, settle } = mounted();
    const live = await livePost(client);

    const scheduled = await client.schedule("a", {
      expectedVersion: live.version,
      changeId: "c3",
      source: NEXT,
      publishAt: "2030-01-01T09:00:00-06:00",
    });
    expect(scheduled).toMatchObject({
      status: "published",
      scheduledUpdate: { publishAt: "2030-01-01T09:00:00-06:00", changeId: "c3" },
    });
    expect(scheduled.version).not.toBe(live.version);
    expect(await client.get("a")).toMatchObject({
      status: "published",
      source: LIVE,
      scheduledUpdate: { changeId: "c3" },
    });
    expect(await client.scheduledUpdate("a")).toMatchObject({
      id: "a",
      source: NEXT,
      changeId: "c3",
    });

    const moved = await client.schedule("a", {
      expectedVersion: scheduled.version,
      changeId: "c4",
      source: NEXT,
      publishAt: "2030-02-01T15:00:00Z",
    });
    expect(moved.scheduledUpdate).toEqual({ publishAt: "2030-02-01T15:00:00Z", changeId: "c4" });

    expect(await api.runSchedules({ now: new Date("2030-02-01T14:59:59Z") })).toEqual({
      applied: [],
      skipped: 0,
      failed: 0,
      more: false,
      emptied: 0,
      retried: 0,
    });
    expect((await client.get("a")).source).toBe(LIVE);

    const run = await api.runSchedules({ now: new Date("2030-02-01T15:00:00Z") });
    expect(run.applied).toEqual([
      {
        id: "a",
        kind: "update",
        publishAt: "2030-02-01T15:00:00Z",
        changeId: "c4",
        version: expect.any(String),
      },
    ]);
    expect(await client.get("a")).toMatchObject({
      status: "published",
      source: NEXT,
      scheduledUpdate: null,
    });
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
    const scheduled = await client.schedule("a", {
      expectedVersion: live.version,
      changeId: "c3",
      source: NEXT,
      publishAt: "2030-01-01T00:00:00Z",
    });

    const canceled = await client.cancelSchedule("a", {
      expectedVersion: scheduled.version,
      changeId: "c4",
    });
    expect(canceled).toMatchObject({ status: "published", scheduledUpdate: null });
    expect(await client.scheduledUpdate("a").catch((e: SiteApiError) => e.status)).toBe(404);
    const refused = await client
      .cancelSchedule("a", { expectedVersion: canceled.version, changeId: "c5" })
      .catch((e: SiteApiError) => e.status);
    expect(refused).toBe(422);

    const again = await client.schedule("a", {
      expectedVersion: canceled.version,
      changeId: "c6",
      source: NEXT,
      publishAt: "2030-01-01T00:00:00Z",
    });
    await client.unpublish("a", { expectedVersion: again.version, changeId: "c7" });
    expect(await api.runSchedules({ now: new Date("2031-01-01T00:00:00Z") })).toMatchObject({
      applied: [],
    });
    expect(await client.get("a")).toMatchObject({ status: "draft", source: LIVE });
  });

  it("publishes a scheduled draft at its time, at the time it was scheduled for, and a cancel returns it to draft", async () => {
    const { api, client, heard, settle } = mounted();
    const draft = await client.saveDraft("b", {
      source: "# B\n",
      expectedVersion: null,
      changeId: "c1",
    });
    const scheduled = await client.schedule("b", {
      expectedVersion: draft.version,
      changeId: "c2",
      publishAt: "2030-01-01T00:00:00Z",
    });
    expect(scheduled.status).toBe("scheduled");

    const run = await api.runSchedules({ now: new Date("2030-01-01T00:05:00Z") });
    expect(run.applied.map((a) => [a.id, a.kind, a.changeId])).toEqual([["b", "publish", "c2"]]);
    expect(await client.get("b")).toMatchObject({
      status: "published",
      publishedAt: "2030-01-01T00:00:00.000Z",
    });
    await settle();
    expect(heard.map((e) => [e.action, e.trigger])).toEqual([["publish", "schedule"]]);

    const other = await client.saveDraft("c", {
      source: "# C\n",
      expectedVersion: null,
      changeId: "c3",
    });
    const later = await client.schedule("c", {
      expectedVersion: other.version,
      changeId: "c4",
      publishAt: "2030-01-01T00:00:00Z",
    });
    expect(
      await client.cancelSchedule("c", { expectedVersion: later.version, changeId: "c5" }),
    ).toMatchObject({ status: "draft" });
  });

  it("refuses a schedule on a live post where the site has no scheduled updates, and leaves the post live", async () => {
    const { client } = mounted(memoryAdapter({ schedules: false }));
    const live = await livePost(client);
    const error = await client
      .schedule("a", {
        expectedVersion: live.version,
        changeId: "c3",
        source: NEXT,
        publishAt: "2030-01-01T00:00:00Z",
      })
      .catch((e: SiteApiError) => e);
    expect(error).toMatchObject({ status: 422, body: { error: "refused" } });
    expect(await client.get("a")).toMatchObject({
      status: "published",
      source: LIVE,
      version: live.version,
    });
    expect(await client.scheduledUpdate("a").catch((e: SiteApiError) => e.status)).toBe(501);
  });
});

describe("publish hooks", () => {
  it("logs a hook that fails and never fails the write; the IndexNow hook sends the page through the site's submit", async () => {
    const sent: Array<{ urls: string[]; from?: string }> = [];
    const { api, logs } = siteWithHooks([
      { name: "broken", run: () => Promise.reject(new Error("boom")) },
      indexNowHook({
        origin: ORIGIN,
        key: "indexnow-key",
        submit: async (input) => {
          sent.push(input);
          return true;
        },
      }),
    ]);
    const client = clientOf(api);
    const preview = clientOf(api, "https://preview.workers.dev");

    const draft = await client.saveDraft("a", {
      source: LIVE,
      expectedVersion: null,
      changeId: "c1",
    });
    expect(
      await client.publish("a", { expectedVersion: draft.version, changeId: "c2" }),
    ).toMatchObject({ status: "published" });
    const live = await client.get("a");
    await preview.saveDraft("a", { source: NEXT, expectedVersion: live.version, changeId: "c3" });

    // The preview's save is heard, but the IndexNow hook tells nobody about a page on another origin.
    expect(sent).toEqual([
      {
        origin: ORIGIN,
        key: "indexnow-key",
        urls: [`${ORIGIN}/blog/a`],
      },
    ]);
    const page = {
      id: "a",
      path: "/blog/a",
      url: `${ORIGIN}/blog/a`,
      trigger: "request",
      error: "boom",
    };
    expect(logs.filter((l) => l.siteApi === "hook-failed")).toEqual([
      {
        siteApi: "hook-failed",
        hook: "broken",
        action: "publish",
        changeId: "c2",
        previousStatus: "draft",
        status: "published",
        ...page,
      },
      {
        siteApi: "hook-failed",
        hook: "broken",
        action: "update",
        changeId: "c3",
        previousStatus: "published",
        status: "published",
        ...page,
      },
    ]);
  });
});

describe("publish hooks on rename, trash and restore", () => {
  it("hears what a hook names, sends both addresses of a rename, and retries a failed hook from the store until it gives up", async () => {
    const heard: string[] = [];
    const sent: string[][] = [];
    let failing = true;
    const { api, logs } = siteWithHooks(
      [
        {
          name: "all",
          on: ["schedule", "trash", "restore", "rename"],
          run: (e) => void heard.push(`${e.action} ${e.previousStatus}>${e.status}`),
        },
        indexNowHook({
          origin: ORIGIN,
          key: "k",
          submit: async (input) => (sent.push(input.urls), !failing),
        }),
      ],
      { store: d1SiteApiStore(d1(SITE_API_STORE_SQL)) },
    );
    const client = clientOf(api);

    const draft = await client.saveDraft("a", {
      source: LIVE,
      expectedVersion: null,
      changeId: "c1",
    });
    const live = await client.publish("a", { expectedVersion: draft.version, changeId: "c2" });
    const moved = await client.rename("a", {
      newId: "b",
      expectedVersion: live.version,
      changeId: "c3",
    });
    const trashed = await client.trash("b", { expectedVersion: moved.version, changeId: "c4" });
    await client.restore("b", { expectedVersion: trashed.version, changeId: "c5" });
    expect(heard).toEqual([
      "rename published>published",
      "trash published>draft",
      "restore draft>draft",
    ]);
    expect(sent).toEqual([
      [`${ORIGIN}/blog/a`],
      [`${ORIGIN}/blog/b`, `${ORIGIN}/blog/a`],
      [`${ORIGIN}/blog/b`],
    ]);

    // Three failures kept; each retry waits longer, and a retry that works drops it.
    const minutes = (n: number) => new Date(Date.now() + n * 60 * 1000);
    expect((await api.runSchedules({ now: minutes(2) })).retried).toBe(3);
    expect((await api.runSchedules({ now: minutes(3) })).retried).toBe(0);
    failing = false;
    expect((await api.runSchedules({ now: minutes(8) })).retried).toBe(3);
    expect((await api.runSchedules({ now: minutes(2000) })).retried).toBe(0);
    expect(sent).toHaveLength(9);
    expect(logs.filter((l) => l.siteApi === "hook-gave-up")).toEqual([]);
  });
});

describe("runSchedulesOrThrow", () => {
  it("throws when a schedule failed, so the cron job fails and the schedule is tried again", async () => {
    const adapter = memoryAdapter();
    const api = createSiteApi({
      adapter: {
        ...adapter,
        schedules: { ...adapter.schedules!, due: () => Promise.reject(new Error("db down")) },
      },
      key: KEY,
      limiter: allow,
      log: () => {},
    });
    await expect(api.runSchedulesOrThrow()).rejects.toThrow("1 site API schedule(s) failed");
  });

  it("carries the database's message as the cause when every failure was the database being down", async () => {
    const adapter = memoryAdapter();
    const api = createSiteApi({
      adapter: {
        ...adapter,
        schedules: {
          ...adapter.schedules!,
          due: () => Promise.reject(new Error("D1_ERROR: internal error; reference = abc")),
        },
      },
      key: KEY,
      limiter: allow,
      log: () => {},
    });
    const error = await api.runSchedulesOrThrow().catch((e: Error) => e);
    expect(isDatabaseDown(error)).toBe(true);
  });
});

describe("page changes", () => {
  it("names the page a publish, a live save, an unpublish and a delete change, never a draft's, and waits on nothing", async () => {
    const { api, client: c, heard, settle } = mounted();

    const draft = await c.saveDraft("a", {
      source: "# A\n",
      expectedVersion: null,
      changeId: "c1",
    });
    const live = await c.publish("a", { expectedVersion: draft.version, changeId: "c2" });
    const edited = await c.saveDraft("a", {
      source: "# A, edited\n",
      expectedVersion: live.version,
      changeId: "c3",
    });
    const down = await c.unpublish("a", { expectedVersion: edited.version, changeId: "c4" });
    const again = await c.publish("a", { expectedVersion: down.version, changeId: "c5" });
    await c.delete("a", { expectedVersion: again.version, changeId: "c6" });
    const waited = await settle();

    expect(heard.map((e) => e.path)).toEqual(Array(5).fill("/blog/a"));
    // The first save, to a draft never published, has no page to tell anyone of, so nothing waits on it.
    expect(waited).toHaveLength(5);

    // PLANT: a malformed escape in the id is the route's 400 (ASVS 16.5.4), not a URIError thrown by the handler.
    const bad = await api.handle(
      req("/api/carrel/v1/content/%E0%A4%A/publish", {
        method: "POST",
        ...body({ expectedVersion: "v1", changeId: "c7" }),
      }),
    );
    expect(bad.status).toBe(400);
  });
});
