import { describe, expect, it, vi } from "vitest";
import { createSiteApi, isSiteApiRequest } from "../src/index.js";
import { memoryAdapter } from "../src/testing.js";
import { allow, KEY, req } from "./helpers.js";

describe("v0.27.0", () => {
  it("runSchedulesOrThrow throws when a schedule failed and returns the run when none did", async () => {
    const adapter = memoryAdapter();
    const api = createSiteApi({ adapter, key: KEY, limiter: allow, log: () => {} });
    await expect(api.runSchedulesOrThrow()).resolves.toMatchObject({ failed: 0 });
    const failing = createSiteApi({
      adapter: {
        ...adapter,
        schedules: { ...adapter.schedules!, due: async () => Promise.reject(new Error("db down")) },
      },
      key: KEY,
      limiter: allow,
      log: () => {},
    });
    await expect(failing.runSchedulesOrThrow()).rejects.toThrow("1 site API schedule(s) failed");
  });

  it("isSiteApiRequest is true for the prefix and preview links only", () => {
    expect(isSiteApiRequest(new URL("https://site.example/api/carrel/v1/meta"))).toBe(true);
    expect(isSiteApiRequest(new URL("https://site.example/preview/abc"))).toBe(true);
    expect(isSiteApiRequest(new URL("https://site.example/blog/a"))).toBe(false);
  });

  it("the default log names a refused request in the OWASP vocabulary", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const api = createSiteApi({ adapter: memoryAdapter(), key: KEY, limiter: allow });
    await api.handle(req("/api/carrel/v1/meta", { key: "wrong-key-wrong-key-wrong-key-wrong" }));
    const lines = [...warn.mock.calls, ...log.mock.calls].map((c) => String(c[0]));
    warn.mockRestore();
    log.mockRestore();
    expect(lines.join("\n")).toContain("authz_fail");
  });
});
