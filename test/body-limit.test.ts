import { describe, expect, it, vi } from "vitest";
import { memoryAdapter } from "../src/testing.js";
import { req, site } from "./helpers.js";

// A JSON body is counted as it arrives. Before, request.text() held the whole body in memory and only then
// checked its size, so a client that sent no Content-Length (or an understated one) chose how much was held.
describe("PLANT: a 10 MB JSON body", () => {
  it("is refused as too large when it declares no length, and never reaches the site", async () => {
    const adapter = memoryAdapter();
    const saved = vi.spyOn(adapter.content, "saveDraft");
    const { api } = site(adapter);
    const chunk = new TextEncoder().encode("x".repeat(1_000_000));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ === 10) return controller.close();
        controller.enqueue(chunk);
      },
    });
    const response = await api.handle(
      req("/api/carrel/v1/content/a/draft", {
        method: "PUT",
        body: stream,
        headers: { "content-type": "application/json" },
        duplex: "half",
      } as RequestInit),
    );
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: "too-large" });
    expect(saved).not.toHaveBeenCalled();
    expect(sent, "the stream is canceled, not read to its end").toBeLessThan(10);
  });
});
