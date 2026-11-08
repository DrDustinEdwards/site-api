// The media kit (v0.14.0): the parts a mistake in would ship silently. A write the site refused or lost to another must
// reach the handler as the error it answers; a preview found by a crawler must say noindex and cannot be broken out of by
// its title; a site's cost cap must stop the suggester before the model is paid for; and a gateway or an answer gone
// wrong must not reach the person as a failure or as alt text.

import { describe, expect, it, vi } from "vitest";
import { NotFoundError, RefusedError, VersionConflictError } from "../src/adapter.js";
import {
  answerWrite,
  mediaRev,
  mediaSuggester,
  previewDocument,
  type SuggestEnv,
} from "../src/media-kit.js";

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
    expect(() => answerWrite({ ok: false, reason: "refused", message: "A static asset." })).toThrow(
      RefusedError,
    );
    expect([mediaRev("r12"), mediaRev("r012"), mediaRev("12"), mediaRev("r-1")]).toEqual([
      12, -1, -1, -1,
    ]);
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

  it("stops before the model when beforeCall throws, calls Claude with the picture, meters what it spent, and withholds a chatbot's leftovers", async () => {
    const reply = (value: unknown, status = 200) =>
      new Response(
        JSON.stringify(
          status === 200
            ? {
                id: "msg_1",
                type: "message",
                role: "assistant",
                stop_reason: "end_turn",
                content: [{ type: "text", text: JSON.stringify(value) }],
                usage: { input_tokens: 5, output_tokens: 7 },
              }
            : { type: "error", error: { type: "invalid_request_error", message: "bad" } },
        ),
        { status, headers: { "content-type": "application/json" } },
      );
    const fetchMock = vi.fn(async (..._args: unknown[]) =>
      reply({ alt: " A dog. ", tags: ["dog", 3] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const output = async () => ({ response: () => new Response("jpeg") });
      const images = { input: () => ({ output, transform: () => ({ output }) }) };
      const env: SuggestEnv = { ANTHROPIC_API_KEY: "sk-ant-test", IMAGES: images };
      const picture = () => new Response("png").body!;

      await expect(
        mediaSuggester({ app: "sample", describe: "on a sample site" })(
          { IMAGES: images },
          picture(),
        ),
      ).rejects.toThrow("ANTHROPIC_API_KEY");

      const capped = mediaSuggester({
        app: "sample",
        describe: "on a sample site",
        beforeCall: () => Promise.reject(new Error("cap")),
      });
      await expect(capped(env, picture())).rejects.toThrow("cap");
      expect(fetchMock).not.toHaveBeenCalled();

      const afterCall = vi.fn();
      const suggest = mediaSuggester({ app: "sample", describe: "on a sample site", afterCall });
      expect(await suggest(env, { body: picture() }, "a.png")).toEqual({
        tags: ["dog"],
        alt: "A dog.",
        model: "claude-haiku-5-5",
      });
      const [url, init] = fetchMock.mock.calls[0] as [string, { body: string }];
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      const body = JSON.parse(init.body);
      expect(body.model).toBe("claude-haiku-5-5");
      expect(body.messages[0].content[0]).toMatchObject({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg" },
      });
      expect(afterCall).toHaveBeenCalledWith(
        env,
        { model: "claude-haiku-5-5", input: 5, output: 7, cacheRead: 0, cacheWrite: 0 },
        "a.png",
      );

      fetchMock.mockResolvedValueOnce(
        reply({ alt: "As an AI language model, I see a dog.", tags: ["dog"] }),
      );
      expect(await suggest(env, picture())).toEqual({
        tags: ["dog"],
        alt: null,
        model: "claude-haiku-5-5",
      });

      fetchMock.mockImplementation(async () => reply(null, 400));
      await expect(suggest(env, picture())).rejects.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
