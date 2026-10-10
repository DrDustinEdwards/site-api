// v0.5.0: the mentions group. Each plant is a request that must be refused; where the package refuses
// it, the test also checks that the adapter never ran, and where the site refuses it, that the queue
// is exactly as it was.

import { describe, expect, it, vi } from "vitest";
import { RefusedError } from "../src/adapter.js";
import { createSiteClient, SiteApiError } from "../src/client.js";
import { memoryAdapter } from "../src/testing.js";
import { KEY, ORIGIN, body, req, site } from "./helpers.js";

const DAY = 24 * 60 * 60 * 1000;

function seededAdapter(now = new Date("2026-10-07T12:00:00Z")) {
  const adapter = memoryAdapter({ now: () => now });
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  const ids = {
    pending: adapter.receiveMention({ sourceUrl: "https://a.example/post", targetId: "first-post", authorName: "Ada", excerpt: "A reply.", receivedAt: ago(1) }),
    unverified: adapter.receiveMention({ sourceUrl: "https://b.example/post", targetId: "first-post", status: "unverified", receivedAt: ago(2) }),
    failedOld: adapter.receiveMention({ sourceUrl: "https://c.example/post", targetId: "first-post", status: "failed", receivedAt: ago(40) }),
    failedNew: adapter.receiveMention({ sourceUrl: "https://d.example/post", targetId: "first-post", status: "failed", receivedAt: ago(5) }),
    rejectedOld: adapter.receiveMention({ sourceUrl: "https://e.example/post", targetId: "second-post", status: "rejected", receivedAt: ago(100) }),
    rejectedNew: adapter.receiveMention({ sourceUrl: "https://f.example/post", targetId: "second-post", status: "rejected", receivedAt: ago(50) }),
  };
  return { adapter, ids };
}

function client(adapter: ReturnType<typeof memoryAdapter> = seededAdapter().adapter) {
  const s = site(adapter);
  return { ...s, client: createSiteClient({ baseUrl: ORIGIN, key: KEY, fetch: s.fetch }) };
}

const snapshot = (adapter: ReturnType<typeof memoryAdapter>) => structuredClone([...adapter.mentionStore.values()]);

describe("mentions list", () => {
  it("lists newest first with the whole queue's counts and what a sweep would remove", async () => {
    const { adapter, ids } = seededAdapter();
    const { client: c } = client(adapter);
    const list = await c.mentions.list();
    expect(list.items.map((m) => m.id)).toEqual([ids.pending, ids.unverified, ids.failedNew, ids.failedOld, ids.rejectedNew, ids.rejectedOld]);
    expect(list.counts).toEqual({ unverified: 1, pending: 1, approved: 0, rejected: 2, failed: 2 });
    expect(list.expiring).toEqual({ failed: 1, rejected: 1 });
    expect(list.items[0]).toMatchObject({ authorName: "Ada", excerpt: "A reply.", targetId: "first-post", sourceUrl: "https://a.example/post" });
  });

  it("filters by status and pages, with counts that ignore the filter", async () => {
    const { client: c } = client();
    const failed = await c.mentions.list({ status: "failed" });
    expect(failed.items.map((m) => m.status)).toEqual(["failed", "failed"]);
    expect(failed.counts.pending).toBe(1);
    const first = await c.mentions.list({ limit: 4 });
    expect(first.items).toHaveLength(4);
    expect(first.nextCursor).toBe("4");
    const second = await c.mentions.list({ limit: 4, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
  });

  it("PLANT: refuses an unknown status or an out of range limit before the adapter runs", async () => {
    const adapter = seededAdapter().adapter;
    const spy = vi.spyOn(adapter.mentions!, "list");
    const { api } = site(adapter);
    for (const query of ["status=nope", "limit=0", "limit=201", "limit=abc"]) {
      expect((await api.handle(req(`/api/carrel/v1/mentions?${query}`))).status, query).toBe(400);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("mentions decide", () => {
  it("approves a pending mention at the version the caller saw, and reports status, version and the purge", async () => {
    const { adapter, ids } = seededAdapter();
    const { client: c } = client(adapter);
    const before = (await c.mentions.list({ status: "pending" })).items[0]!;
    const result = await c.mentions.decide(ids.pending, { decision: "approve", expectedVersion: before.version, changeId: "c1" });
    expect(result).toMatchObject({ id: ids.pending, status: "approved", changeId: "c1", purged: true });
    expect(result.version).not.toBe(before.version);
    expect(adapter.purged).toEqual(["first-post"]);
    const after = (await c.mentions.list({ status: "approved" })).items[0]!;
    expect(after).toMatchObject({ id: ids.pending, status: "approved", version: result.version });
    expect(after.decidedAt).not.toBeNull();
  });

  it("changes a decision: an approved mention can be rejected, at its new version", async () => {
    const { adapter, ids } = seededAdapter();
    const { client: c } = client(adapter);
    const v1 = adapter.mentionStore.get(ids.pending)!.version;
    const approved = await c.mentions.decide(ids.pending, { decision: "approve", expectedVersion: v1, changeId: "c1" });
    const rejected = await c.mentions.decide(ids.pending, { decision: "reject", expectedVersion: approved.version, changeId: "c2" });
    expect(rejected.status).toBe("rejected");
  });

  it("resets a decision (v0.6.0): an approved mention goes back to pending, undecided, at a new version", async () => {
    const { adapter, ids } = seededAdapter();
    const { client: c } = client(adapter);
    const approved = await c.mentions.decide(ids.pending, { decision: "approve", expectedVersion: adapter.mentionStore.get(ids.pending)!.version, changeId: "c1" });
    const reset = await c.mentions.decide(ids.pending, { decision: "reset", expectedVersion: approved.version, changeId: "c2" });
    expect(reset).toMatchObject({ id: ids.pending, status: "pending", changeId: "c2", purged: true });
    expect(reset.version).not.toBe(approved.version);
    expect(adapter.mentionStore.get(ids.pending)).toMatchObject({ status: "pending", decidedAt: null, version: reset.version });
    expect((await c.meta()).capabilities.mentionReset).toBe(true);
  });

  it("PLANT: refuses a reset of a mention with no decision to take back, with the site's own words", async () => {
    const { adapter, ids } = seededAdapter();
    const { client: c } = client(adapter);
    const before = snapshot(adapter);
    for (const id of [ids.pending, ids.unverified]) {
      const error = await c.mentions.decide(id, { decision: "reset", expectedVersion: adapter.mentionStore.get(id)!.version, changeId: "c1" }).catch((e) => e);
      expect(error.status, id).toBe(422);
      expect(error.body.message).toContain("no decision to take back");
    }
    expect(snapshot(adapter)).toEqual(before);
  });

  it("PLANT: answers a reset 501 on a mentions group with no reset (a v0.5.0 site), and decides as before", async () => {
    const adapter = memoryAdapter({ mentionReset: false });
    const id = adapter.receiveMention({ sourceUrl: "https://a.example/1", targetId: "p", status: "approved" });
    const { client: c } = client(adapter);
    const error = await c.mentions.decide(id, { decision: "reset", expectedVersion: adapter.mentionStore.get(id)!.version, changeId: "c1" }).catch((e) => e);
    expect(error.status).toBe(501);
    expect(adapter.mentionStore.get(id)!.status).toBe("approved");
    expect((await c.meta()).capabilities.mentionReset).toBeUndefined();
    expect((await c.mentions.decide(id, { decision: "reject", expectedVersion: adapter.mentionStore.get(id)!.version, changeId: "c2" })).status).toBe("rejected");
  });

  it("PLANT: refuses a stale version with 409 and the current version, and changes nothing", async () => {
    const { adapter, ids } = seededAdapter();
    const { client: c } = client(adapter);
    const stale = adapter.mentionStore.get(ids.pending)!.version;
    await c.mentions.decide(ids.pending, { decision: "approve", expectedVersion: stale, changeId: "c1" });
    const before = snapshot(adapter);
    const purges = adapter.purged.length;
    const error = await c.mentions.decide(ids.pending, { decision: "reject", expectedVersion: stale, changeId: "c2" }).catch((e) => e);
    expect(error).toBeInstanceOf(SiteApiError);
    expect(error.status).toBe(409);
    expect(error.body).toMatchObject({ error: "version-conflict", currentVersion: adapter.mentionStore.get(ids.pending)!.version });
    expect(snapshot(adapter)).toEqual(before);
    expect(adapter.purged).toHaveLength(purges);
  });

  it("PLANT: answers 404 for a mention the site does not hold", async () => {
    const { adapter } = seededAdapter();
    const { client: c } = client(adapter);
    const before = snapshot(adapter);
    const error = await c.mentions.decide("999", { decision: "approve", expectedVersion: "m1", changeId: "c1" }).catch((e) => e);
    expect(error.status).toBe(404);
    expect(error.body.error).toBe("not-found");
    expect(snapshot(adapter)).toEqual(before);
  });

  it("PLANT: the site's own refusal of an unverified or failed mention comes back 422 refused, and the queue is unchanged", async () => {
    const { adapter, ids } = seededAdapter();
    const { client: c } = client(adapter);
    const before = snapshot(adapter);
    for (const id of [ids.unverified, ids.failedNew]) {
      const error = await c.mentions.decide(id, { decision: "approve", expectedVersion: adapter.mentionStore.get(id)!.version, changeId: "c1" }).catch((e) => e);
      expect(error.status, id).toBe(422);
      expect(error.body.error).toBe("refused");
    }
    expect(snapshot(adapter)).toEqual(before);
  });

  it("PLANT: a refusal the adapter words itself reaches the caller as 422 with those words", async () => {
    const { adapter, ids } = seededAdapter();
    adapter.mentions!.decide = async () => {
      throw new RefusedError("The cache could not be reached.");
    };
    const { client: c } = client(adapter);
    const error = await c.mentions.decide(ids.pending, { decision: "approve", expectedVersion: "m1", changeId: "c1" }).catch((e) => e);
    expect(error.status).toBe(422);
    expect(error.body).toMatchObject({ error: "refused", message: "The cache could not be reached." });
  });

  it("PLANT: answers 501 on a site with no mentions group, whatever the body says", async () => {
    const { client: c } = client(memoryAdapter({ mentions: false }));
    const error = await c.mentions.decide("1", { decision: "approve", expectedVersion: "m1", changeId: "c1" }).catch((e) => e);
    expect(error.status).toBe(501);
    expect(error.body.error).toBe("not-implemented");
  });

  it("PLANT: refuses without the key, with a wrong one, or with an invalid body or id, before the adapter runs", async () => {
    const { adapter, ids } = seededAdapter();
    const spy = vi.spyOn(adapter.mentions!, "decide");
    const { api } = site(adapter);
    const good = { decision: "approve", expectedVersion: "m1", changeId: "c1" };
    for (const key of [null, `${KEY}x`]) {
      expect((await api.handle(req(`/api/carrel/v1/mentions/${ids.pending}/decide`, { method: "POST", key, ...body(good) }))).status).toBe(401);
    }
    const bad: Array<[string, unknown]> = [
      [ids.pending, { ...good, decision: "delete" }],
      [ids.pending, { decision: "approve", changeId: "c1" }],
      [ids.pending, { decision: "approve", expectedVersion: "m1" }],
      [ids.pending, { ...good, changeId: "has spaces" }],
      ["..%2Fx", good],
    ];
    for (const [id, payload] of bad) {
      const response = await api.handle(req(`/api/carrel/v1/mentions/${id}/decide`, { method: "POST", ...body(payload) }));
      expect(response.status, JSON.stringify(payload)).toBe(400);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("mentions delete", () => {
  it("deletes a mention at the version the caller saw, and reports the change id and the purge", async () => {
    const { adapter, ids } = seededAdapter();
    const { client: c } = client(adapter);
    const version = adapter.mentionStore.get(ids.failedNew)!.version;
    expect(await c.mentions.delete(ids.failedNew, { expectedVersion: version, changeId: "c1" })).toEqual({ id: ids.failedNew, deleted: true, changeId: "c1", purged: true });
    expect(adapter.mentionStore.has(ids.failedNew)).toBe(false);
  });

  it("PLANT: refuses a stale version with 409, and the mention stays", async () => {
    const { adapter, ids } = seededAdapter();
    const { client: c } = client(adapter);
    const stale = adapter.mentionStore.get(ids.pending)!.version;
    await c.mentions.decide(ids.pending, { decision: "approve", expectedVersion: stale, changeId: "c1" });
    const error = await c.mentions.delete(ids.pending, { expectedVersion: stale, changeId: "c2" }).catch((e) => e);
    expect(error.status).toBe(409);
    expect(error.body).toMatchObject({ error: "version-conflict", currentVersion: adapter.mentionStore.get(ids.pending)!.version });
    expect(adapter.mentionStore.has(ids.pending)).toBe(true);
  });

  it("PLANT: answers 404 for a missing mention and 501 on a site without the group", async () => {
    const missing = await client().client.mentions.delete("999", { expectedVersion: "m1", changeId: "c1" }).catch((e) => e);
    expect(missing.status).toBe(404);
    const without = await client(memoryAdapter({ mentions: false })).client.mentions.delete("1", { expectedVersion: "m1", changeId: "c1" }).catch((e) => e);
    expect(without.status).toBe(501);
  });

  it("PLANT: refuses without the key, or with no version or change id, before the adapter runs", async () => {
    const { adapter, ids } = seededAdapter();
    const spy = vi.spyOn(adapter.mentions!, "delete");
    const { api } = site(adapter);
    for (const key of [null, `${KEY}x`]) {
      expect((await api.handle(req(`/api/carrel/v1/mentions/${ids.pending}?expectedVersion=m1&changeId=c1`, { method: "DELETE", key }))).status).toBe(401);
    }
    for (const query of ["", "?expectedVersion=m1", "?changeId=c1", "?expectedVersion=m1&changeId=has%20spaces"]) {
      expect((await api.handle(req(`/api/carrel/v1/mentions/${ids.pending}${query}`, { method: "DELETE" }))).status, query).toBe(400);
    }
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("mentions sweep", () => {
  it("removes failed mentions past 30 days and rejected ones past 90, and nothing else", async () => {
    const { adapter, ids } = seededAdapter();
    const { client: c } = client(adapter);
    expect(await c.mentions.sweep("c1")).toEqual({ changeId: "c1", removed: { failed: 1, rejected: 1 } });
    expect([...adapter.mentionStore.keys()].sort()).toEqual([ids.pending, ids.unverified, ids.failedNew, ids.rejectedNew].sort());
    expect(await c.mentions.sweep("c2")).toEqual({ changeId: "c2", removed: { failed: 0, rejected: 0 } });
  });

  it("PLANT: refused without the key, or with no change id, before the adapter runs, and nothing is removed", async () => {
    const { adapter } = seededAdapter();
    const spy = vi.spyOn(adapter.mentions!, "sweep");
    const { api } = site(adapter);
    const before = snapshot(adapter);
    for (const key of [null, `${KEY}x`]) {
      expect((await api.handle(req("/api/carrel/v1/mentions/sweep", { method: "POST", key, ...body({ changeId: "c1" }) }))).status).toBe(401);
    }
    for (const payload of [{}, { changeId: "has spaces" }]) {
      expect((await api.handle(req("/api/carrel/v1/mentions/sweep", { method: "POST", ...body(payload) }))).status).toBe(400);
    }
    expect(spy).not.toHaveBeenCalled();
    expect(snapshot(adapter)).toEqual(before);
  });

  it("PLANT: answers 501 on a site without the group", async () => {
    const error = await client(memoryAdapter({ mentions: false })).client.mentions.sweep("c1").catch((e) => e);
    expect(error.status).toBe(501);
    expect(error.body.error).toBe("not-implemented");
  });

  it("PLANT: does not read the sweep path as a mention id: a delete of 'sweep' is a missing mention, not a sweep", async () => {
    const { adapter } = seededAdapter();
    const spy = vi.spyOn(adapter.mentions!, "sweep");
    const { api } = site(adapter);
    const response = await api.handle(req("/api/carrel/v1/mentions/sweep?expectedVersion=m1&changeId=c1", { method: "DELETE" }));
    expect(response.status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("mentions capability", () => {
  it("is advertised in meta, and absent on a site without the group", async () => {
    expect((await client().client.meta()).capabilities.mentions).toBe(true);
    expect((await client(memoryAdapter({ mentions: false })).client.meta()).capabilities.mentions).toBeUndefined();
  });

  it("answers 501 for every mentions route on a site without the group, including the list", async () => {
    const { api } = site(memoryAdapter({ mentions: false }));
    for (const [method, path] of [["GET", "mentions"], ["GET", "mentions/anything"], ["POST", "mentions/sweep"], ["POST", "mentions/1/decide"], ["DELETE", "mentions/1"]] as const) {
      expect((await api.handle(req(`/api/carrel/v1/${path}`, { method }))).status, `${method} ${path}`).toBe(501);
    }
  });

  it("PLANT: a site that answers a mention outside the contract is a site failure, and the body is not passed on", async () => {
    const adapter = seededAdapter().adapter;
    adapter.mentions!.list = async () => ({ items: [{ id: "1", sourceUrl: "x" }], nextCursor: null }) as never;
    const { api, logs } = site(adapter);
    const response = await api.handle(req("/api/carrel/v1/mentions"));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("sourceUrl");
    expect(logs).toContainEqual(expect.objectContaining({ siteApi: "contract-breach" }));
  });
});
