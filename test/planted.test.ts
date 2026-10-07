// The job's plants: each is a request that must be refused, and each assertion also checks that the
// adapter never ran, so a refusal cannot come from the site's own code by accident.

import { describe, expect, it, vi } from "vitest";
import { memoryAdapter } from "../src/testing.js";
import { KEY, body, req, site } from "./helpers.js";

function spied() {
  const adapter = memoryAdapter();
  const calls = vi.fn();
  for (const [name, fn] of Object.entries(adapter.content)) {
    (adapter.content as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      calls(name);
      return (fn as (...a: unknown[]) => unknown)(...args);
    };
  }
  return { adapter, calls };
}

describe("PLANT: the key off its prefix", () => {
  const paths = [
    "/api/carrel/v2/meta",
    "/api/carrel/v1x/meta",
    "/api/carrel/meta",
    "/admin/posts",
    "/api/carrel/v1/../../admin/posts",
    "/api/carrel/v1/%2e%2e/%2e%2e/admin",
  ];

  for (const path of paths) {
    it(`is not served at ${path}`, async () => {
      const { adapter, calls } = spied();
      const { api } = site(adapter);
      const request = req(path);
      expect(api.matches(request)).toBe(false);
      const response = await api.handle(request);
      expect(response.status).toBe(404);
      expect(calls).not.toHaveBeenCalled();
    });
  }
});

describe("PLANT: the wrong key", () => {
  const cases: Array<[string, string | null, Record<string, string>?]> = [
    ["no header", null],
    ["a different key", "z".repeat(KEY.length)],
    ["the key with one character more", `${KEY}x`],
    ["the key with one character less", KEY.slice(0, -1)],
    ["an empty bearer", ""],
    ["the key under another scheme", null, { authorization: `Basic ${KEY}` }],
  ];

  for (const [name, key, headers] of cases) {
    it(`refuses ${name}`, async () => {
      const { adapter, calls } = spied();
      const { api, logs } = site(adapter);
      const response = await api.handle(req("/api/carrel/v1/content", { key, headers }));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "unauthorized", message: "Unauthorized." });
      expect(calls).not.toHaveBeenCalled();
      expect(logs).toContainEqual(expect.objectContaining({ siteApi: "refused" }));
    });
  }

  it("refuses every request, even the right one, while the site's key is unset or short", async () => {
    for (const key of [undefined, "", "short-key"]) {
      const { api } = site(memoryAdapter(), { key });
      const response = await api.handle(req("/api/carrel/v1/meta", { key: key ?? "" }));
      expect(response.status).toBe(503);
    }
  });
});

describe("PLANT: a stale expectedVersion", () => {
  async function seeded() {
    const s = site();
    const created = await s.api.handle(
      req("/api/carrel/v1/content/first-post/draft", {
        method: "PUT",
        ...body({ source: "# First\n", expectedVersion: null, changeId: "c1" }),
      }),
    );
    expect(created.status).toBe(200);
    const { version } = await created.json();
    return { ...s, version: version as string };
  }

  it("refuses a draft save against a version the site no longer holds", async () => {
    const { api, version } = await seeded();
    await api.handle(
      req("/api/carrel/v1/content/first-post/draft", {
        method: "PUT",
        ...body({ source: "# First, again\n", expectedVersion: version, changeId: "c2" }),
      }),
    );
    const stale = await api.handle(
      req("/api/carrel/v1/content/first-post/draft", {
        method: "PUT",
        ...body({ source: "# Overwrite\n", expectedVersion: version, changeId: "c3" }),
      }),
    );
    expect(stale.status).toBe(409);
    const refusal = await stale.json();
    expect(refusal.error).toBe("version-conflict");
    expect(refusal.currentVersion).not.toBe(version);
  });

  it("refuses publish, schedule and unpublish on a stale version, and changes nothing", async () => {
    const { api, adapter } = await seeded();
    const before = structuredClone(adapter.store.get("first-post"));
    const writes: Array<[string, Record<string, unknown>]> = [
      ["publish", {}],
      ["schedule", { publishAt: "2030-01-01T00:00:00Z" }],
      ["unpublish", {}],
    ];
    for (const [action, extra] of writes) {
      const response = await api.handle(
        req(`/api/carrel/v1/content/first-post/${action}`, {
          method: "POST",
          ...body({ expectedVersion: "stale", changeId: "c9", ...extra }),
        }),
      );
      expect(response.status, action).toBe(409);
    }
    expect(adapter.store.get("first-post")).toEqual(before);
  });

  it("refuses a create over an id that exists, and a non-null version for an id that does not", async () => {
    const { api } = await seeded();
    const create = await api.handle(
      req("/api/carrel/v1/content/first-post/draft", {
        method: "PUT",
        ...body({ source: "# Clobber\n", expectedVersion: null, changeId: "c4" }),
      }),
    );
    expect(create.status).toBe(409);
    const ghost = await api.handle(
      req("/api/carrel/v1/content/no-such-post/draft", {
        method: "PUT",
        ...body({ source: "# Ghost\n", expectedVersion: "v1", changeId: "c5" }),
      }),
    );
    expect(ghost.status).toBe(409);
    expect((await ghost.json()).currentVersion).toBeNull();
  });

  it("refuses a write with no expectedVersion or no change id before the site sees it", async () => {
    const { adapter, calls } = spied();
    const { api } = site(adapter);
    for (const payload of [
      { source: "# x\n", changeId: "c1" },
      { source: "# x\n", expectedVersion: null },
      { source: "# x\n", expectedVersion: null, changeId: "has spaces" },
    ]) {
      const response = await api.handle(
        req("/api/carrel/v1/content/x/draft", { method: "PUT", ...body(payload) }),
      );
      expect(response.status).toBe(400);
    }
    expect(calls).not.toHaveBeenCalled();
  });
});

describe("PLANT: an unknown route", () => {
  it("refuses a path inside the prefix that the contract does not name", async () => {
    const { adapter, calls } = spied();
    const { api } = site(adapter);
    for (const path of ["/api/carrel/v1", "/api/carrel/v1/", "/api/carrel/v1/nope", "/api/carrel/v1/content/a/b/c"]) {
      const response = await api.handle(req(path));
      expect(response.status, path).toBe(404);
      expect((await response.json()).error).toBe("not-found");
    }
    expect(calls).not.toHaveBeenCalled();
  });

  it("refuses a known path with the wrong method", async () => {
    const { api } = site();
    const response = await api.handle(req("/api/carrel/v1/content/a", { method: "PATCH" }));
    expect(response.status).toBe(405);
  });

  it("answers 501 for the groups declared for later stages, and for media on a site without it", async () => {
    const { api: noMedia } = site(memoryAdapter({ media: false }));
    for (const path of ["media", "media/anything"]) {
      expect((await noMedia.handle(req(`/api/carrel/v1/${path}`))).status, path).toBe(501);
    }
    const { api } = site();
    for (const group of ["inbox", "insight", "publications"]) {
      const response = await api.handle(req(`/api/carrel/v1/${group}/anything`));
      expect(response.status, group).toBe(501);
    }
  });

  it("does not tell a caller without the key which routes exist", async () => {
    const { api } = site();
    const known = await api.handle(req("/api/carrel/v1/meta", { key: null }));
    const unknown = await api.handle(req("/api/carrel/v1/nope", { key: null }));
    expect(known.status).toBe(401);
    expect(unknown.status).toBe(401);
  });

  it("refuses an id that could be a path", async () => {
    const { adapter, calls } = spied();
    const { api } = site(adapter);
    const response = await api.handle(req("/api/carrel/v1/content/..%2Fsecrets"));
    expect(response.status).toBe(400);
    expect(calls).not.toHaveBeenCalled();
  });
});

describe("rate limit", () => {
  it("refuses before the key is checked when the limiter says no", async () => {
    const { adapter, calls } = spied();
    const { api } = site(adapter, { limiter: { limit: async () => ({ success: false }) } });
    const response = await api.handle(req("/api/carrel/v1/content"));
    expect(response.status).toBe(429);
    expect(calls).not.toHaveBeenCalled();
  });

  it("fails closed when the limiter throws", async () => {
    const { api } = site(memoryAdapter(), {
      limiter: {
        limit: async () => {
          throw new Error("binding missing");
        },
      },
    });
    expect((await api.handle(req("/api/carrel/v1/meta"))).status).toBe(503);
  });

  it("limits by the caller's address", async () => {
    const keys: string[] = [];
    const { api } = site(memoryAdapter(), {
      limiter: {
        limit: async ({ key }) => {
          keys.push(key);
          return { success: true };
        },
      },
    });
    await api.handle(req("/api/carrel/v1/meta", { headers: { "cf-connecting-ip": "203.0.113.9" } }));
    expect(keys).toEqual(["203.0.113.9"]);
  });
});

describe("a site that answers outside the contract", () => {
  it("is reported as a site failure, and the malformed body is not passed on", async () => {
    const adapter = memoryAdapter();
    adapter.content.list = async () => ({ items: [{ id: "x" }], nextCursor: null }) as never;
    const { api, logs } = site(adapter);
    const response = await api.handle(req("/api/carrel/v1/content"));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('"id":"x"');
    expect(logs).toContainEqual(expect.objectContaining({ siteApi: "contract-breach" }));
  });
});
