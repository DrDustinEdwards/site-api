// v0.36.0: an item's transcript is replaced through its own route, live at once, from the transcriptVersion it was
// written from, and the item's version stays, so a draft of the post is still good after a transcript fix.

import { describe, expect, it } from "vitest";
import { createSiteClient, SiteApiError } from "../src/client.js";
import { memoryAdapter } from "../src/testing.js";
import { KEY, ORIGIN, site } from "./helpers.js";

const VTT = (words: string) => `WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n${words}\n`;

function setup(options: Parameters<typeof memoryAdapter>[0] = {}) {
  const adapter = memoryAdapter(options);
  const c = createSiteClient({ baseUrl: ORIGIN, key: KEY, fetch: site(adapter).fetch });
  return { adapter, c };
}

describe("content transcript (v0.36.0)", () => {
  it("replaces the transcript at the version read, keeps the item's version, and refuses a stale one", async () => {
    const { adapter, c } = setup();
    const saved = await c.saveDraft("ep", {
      source: "---\ntitle: Ep\n---\nBody\n",
      expectedVersion: null,
      changeId: "c1",
    });
    adapter.transcripts.set("ep", VTT("Wheel's disease"));
    const before = await c.get("ep");
    expect(before.transcriptVersion).toMatch(/^[0-9a-f]{32}$/);

    const written = await c.setTranscript("ep", {
      transcript: VTT("Weil's disease").replace(/\n/g, "\r\n"),
      expectedTranscriptVersion: before.transcriptVersion!,
      changeId: "t1",
    });
    const after = await c.get("ep");
    expect(after.transcript).toBe(VTT("Weil's disease"));
    expect(after.version).toBe(saved.version);
    expect(written).toEqual({
      id: "ep",
      version: saved.version,
      transcriptVersion: after.transcriptVersion,
      changeId: "t1",
    });

    const stale = await c
      .setTranscript("ep", {
        transcript: VTT("Hell on Wheels"),
        expectedTranscriptVersion: before.transcriptVersion!,
        changeId: "t2",
      })
      .catch((e: unknown) => e);
    expect(stale).toBeInstanceOf(SiteApiError);
    expect((stale as SiteApiError).status).toBe(409);
    expect((await c.get("ep")).transcript).toBe(VTT("Weil's disease"));
  });

  it("refuses text that is not WebVTT before the site sees it, and answers 501 where transcripts are read only", async () => {
    const { c } = setup();
    await c.saveDraft("ep", { source: "# Ep\n", expectedVersion: null, changeId: "c1" });
    const notVtt = await c
      .setTranscript("ep", {
        transcript: "Just words.",
        expectedTranscriptVersion: null,
        changeId: "t1",
      })
      .catch((e: unknown) => e);
    expect((notVtt as SiteApiError).status).toBe(400);

    const { c: plain } = setup({ contentTranscript: false });
    await plain.saveDraft("ep", { source: "# Ep\n", expectedVersion: null, changeId: "c1" });
    const off = await plain
      .setTranscript("ep", {
        transcript: VTT("x"),
        expectedTranscriptVersion: null,
        changeId: "t1",
      })
      .catch((e: unknown) => e);
    expect((off as SiteApiError).status).toBe(501);
    expect((await plain.meta()).capabilities.contentTranscript).toBeUndefined();
  });
});
