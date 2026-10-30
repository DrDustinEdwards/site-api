// v0.15.0: safe retries by change id, on a site that gives the package its D1 store.

import { describe, expect, it } from "vitest";
import { createSiteApi, sha256Hex } from "../src/index.js";
import { d1SiteApiStore, SITE_API_STORE_SQL } from "../src/store.js";
import { memoryAdapter } from "../src/testing.js";
import { d1 } from "./d1.js";
import { KEY, allow, body, png, req } from "./helpers.js";

function replaying() {
  const adapter = memoryAdapter();
  const store = d1SiteApiStore(d1(SITE_API_STORE_SQL));
  const api = createSiteApi({ adapter, key: KEY, limiter: allow, log: () => {}, store });
  const send = async (path: string, init: RequestInit) => {
    const response = await api.handle(req(`/api/carrel/v1${path}`, init));
    return { status: response.status, replayed: response.headers.get("idempotent-replayed"), body: await response.json() };
  };
  return { adapter, store, api, send };
}

describe("replay (v0.15.0)", () => {
  it("answers a retry with the first answer and runs the write once, refuses the id on another request, and frees it after a failure", async () => {
    const { adapter, api, send } = replaying();
    expect((await (await api.handle(req("/api/carrel/v1/meta"))).json()).capabilities.replay).toBe(true);

    const save = body({ source: "# A\n", expectedVersion: null, changeId: "c1" });
    const first = await send("/content/a/draft", { method: "PUT", ...save });
    const again = await send("/content/a/draft", { method: "PUT", ...save });
    expect(first.status).toBe(200);
    expect(again).toEqual({ ...first, replayed: "true" });
    expect(adapter.store.get("a")!.history).toHaveLength(1);

    const other = await send("/content/a/draft", { method: "PUT", ...body({ source: "# B\n", expectedVersion: null, changeId: "c1" }) });
    expect(other.status).toBe(422);
    expect(other.body.message).toBe("This change id was already used for a different request.");

    // A refusal is kept too: the stale write answers the same 409 however often it is sent.
    const stale = body({ source: "# A2\n", expectedVersion: "old", changeId: "c2" });
    const conflict = await send("/content/a/draft", { method: "PUT", ...stale });
    expect(conflict.status).toBe(409);
    expect(await send("/content/a/draft", { method: "PUT", ...stale })).toEqual({ ...conflict, replayed: "true" });

    // A 404 frees the id, so the same id can run again once the item exists.
    expect((await send("/content/b?expectedVersion=v1&changeId=c3", { method: "DELETE" })).status).toBe(404);
    expect((await send("/content/b/draft", { method: "PUT", ...body({ source: "# B\n", expectedVersion: null, changeId: "c3" }) })).status).toBe(200);

    // An upload hashes its bytes: the same file under the same id is stored once.
    const upload = () => ({ method: "POST", body: new Blob([png(2, 2) as Uint8Array<ArrayBuffer>]), headers: { "content-type": "image/png" } });
    const up = await send("/media?filename=a.png&changeId=c4", upload());
    expect(up.status).toBe(201);
    expect((await send("/media?filename=a.png&changeId=c4", upload())).replayed).toBe("true");
    expect(adapter.mediaStore.size).toBe(1);
  });

  it("answers in-progress while the first is running, lets a retry take over a claim left by a dead request, and prunes old answers", async () => {
    const { adapter, store, api, send } = replaying();
    const save = body({ source: "# A\n", expectedVersion: null, changeId: "c1" });
    const claim = async (at: Date) => {
      // The claim exactly as the handler makes it: the route, and the hash of the query and the body.
      const requestHash = await sha256Hex(`\n${save.body as string}`);
      return store.claimWrite("c1", { route: "PUT /content/a/draft", requestHash, at: at.toISOString(), staleBefore: new Date(0).toISOString() });
    };

    expect(await claim(new Date())).toBeNull();
    const running = await send("/content/a/draft", { method: "PUT", ...save });
    expect(running.status).toBe(409);
    expect(running.body.error).toBe("in-progress");
    expect(adapter.store.has("a")).toBe(false);

    await store.pruneWrites(new Date(Date.now() + 1000).toISOString());
    expect(await claim(new Date(Date.now() - 10 * 60 * 1000))).toBeNull();
    expect((await send("/content/a/draft", { method: "PUT", ...save })).status).toBe(200);

    await api.runSchedules({ now: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000) });
    expect((await send("/content/a/draft", { method: "PUT", ...save })).status).toBe(409);
  });
});
