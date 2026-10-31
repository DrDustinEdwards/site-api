// The media kit (v0.14.0): the parts a mistake in would ship silently. A write the site refused or lost to another must
// reach the handler as the error it answers; a preview found by a crawler must say noindex and cannot be broken out of by
// its title; a site's cost cap must stop the suggester before the model is paid for; and a gateway or an answer gone
// wrong must not reach the person as a failure or as alt text.

import { describe, expect, it, vi } from "vitest";
import { NotFoundError, RefusedError, VersionConflictError } from "../src/adapter.js";
import { answerWrite, mediaRev, mediaSuggester, previewDocument, type SuggestEnv } from "../src/media-kit.js";

describe("media kit", () => {
  it("answers a write as its version, or as the error the handler maps to 404, 409 or 422", () => {
    expect(answerWrite({ ok: true, rev: 7 })).toEqual({ version: "r7" });
    expect(() => answerWrite({ ok: false, reason: "missing" })).toThrow(NotFoundError);
    const stale = (() => {
      try {
        answerWrite({ ok: false, reason: "stale", rev: 8 });
      } catch (error) {
        return error;
      }
    })();
    expect(stale).toBeInstanceOf(VersionConflictError);
    expect((stale as VersionConflictError).currentVersion).toBe("r8");
    expect(() => answerWrite({ ok: false, reason: "refused", message: "A static asset." })).toThrow(RefusedError);
    expect([mediaRev("r12"), mediaRev("r012"), mediaRev("12"), mediaRev("r-1")]).toEqual([12, -1, -1, -1]);
  });

  it("writes a preview noindex, with its title and attributes escaped", () => {
    const html = previewDocument({
      title: "</title><script>x()</script>",
      body: "<main>Body</main>",
      stylesheets: ["/site.css"],
      origin: "https://example.com",
      attributes: { "data-theme": '"><script>' },
    });
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).not.toContain("<script>");
    expect(html).toContain('<link rel="stylesheet" href="https://example.com/site.css">');
    expect(html).toContain("<body><main>Body</main></body>");
  });

  it("stops before the model when beforeCall throws, and reads the model's JSON wherever it put it", async () => {
    const run = vi.fn(async () => ({ response: 'Sure: {"alt": " A dog. ", "tags": ["dog", 3]}', usage: { prompt_tokens: 5 } }));
    const output = async () => ({ response: () => new Response("jpeg") });
    const images = { input: () => ({ output, transform: () => ({ output }) }) };
    const env: SuggestEnv = { AI: { run }, IMAGES: images };
    const picture = () => new Response("png").body!;

    const capped = mediaSuggester({ app: "sample", describe: "on a sample site", beforeCall: () => Promise.reject(new Error("cap")) });
    await expect(capped(env, picture())).rejects.toThrow("cap");
    expect(run).not.toHaveBeenCalled();

    const afterCall = vi.fn();
    const suggest = mediaSuggester({ app: "sample", describe: "on a sample site", afterCall });
    expect(await suggest(env, { body: picture() }, "a.png")).toEqual({ tags: ["dog"], alt: "A dog.", model: expect.any(String) });
    expect(afterCall).toHaveBeenCalledWith(env, expect.objectContaining({ promptTokens: 5, completionTokens: 0 }), "a.png");
  });

  it("PLANT: a custom-domain gateway never fails a suggestion, and alt text with a chatbot's leftovers is not offered", async () => {
    const run = vi.fn(async (_model: string, _input: unknown, _options?: object) => ({ response: { alt: "As an AI language model, I see a dog.", tags: ["dog"] } }));
    const output = async () => ({ response: () => new Response("jpeg") });
    const images = { input: () => ({ output, transform: () => ({ output }) }) };
    const suggest = mediaSuggester({ app: "sample", describe: "on a sample site" });
    const custom = "https://ai.example.com/anthropic";
    const gatewayOn = async (env: Partial<SuggestEnv>) => {
      await suggest({ AI: { run }, IMAGES: images, ...env }, new Response("png").body!);
      return (run.mock.calls.at(-1)?.[2] as { gateway?: { id: string } }).gateway?.id;
    };
    expect(await gatewayOn({ AI_GATEWAY_BASE_URL: custom, AI_GATEWAY_ID: "sample-gw" })).toBe("sample-gw");
    expect(await gatewayOn({ AI_GATEWAY_BASE_URL: custom })).toBeUndefined();
    expect(await suggest({ AI: { run }, IMAGES: images }, new Response("png").body!)).toEqual({ tags: ["dog"], alt: null, model: expect.any(String) });
  });
});
