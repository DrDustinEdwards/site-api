// The frontmatter writes: the source comes back unchanged except for the one block a write names, and
// an unknown key, a comment or a list nobody asked about survives byte for byte.

import { describe, expect, it } from "vitest";

import { joinSource, readKey, readList, setBlock, setRawKey, setTags, splitSource, tagsOf } from "../src/frontmatter.js";

const SOURCE = [
  "---",
  'title: "Every product"',
  "slug: every-product",
  "# kept: a comment",
  'description: "One table."',
  "date: 2026-07-30",
  "draft: false",
  "tags: [cloudflare, workers]",
  "further_reading:",
  "  - https://example.com/a",
  "key_takeaways:",
  '  - "First."',
  '  - "Second."',
  "weird_key: some value: with a colon",
  "---",
  "",
  "The body.",
  "",
].join("\n");

const parts = splitSource(SOURCE);

describe("splitSource and joinSource", () => {
  it("round-trips every shape of source byte for byte", () => {
    for (const source of [SOURCE, "no frontmatter\n", "---\ntitle: x\n---", "---\r\ntitle: x\r\n---\r\nBody\r\n", "---\n---\nBody", ""]) {
      expect(joinSource(splitSource(source))).toBe(source);
    }
    expect(parts.body).toBe("The body.\n");
  });
});

describe("reads", () => {
  it("reads a key quoted or not, and a list in flow or block form", () => {
    expect(readKey(parts.front, "title")).toBe("Every product");
    expect(readKey(parts.front, "weird_key")).toBe("some value: with a colon");
    expect(readKey(parts.front, "missing")).toBe("");
    expect(readList(parts.front, "key_takeaways")).toEqual(["First.", "Second."]);
    expect(tagsOf(parts.front)).toEqual(["cloudflare", "workers"]);
    expect(tagsOf(null)).toEqual([]);
  });
});

describe("writes", () => {
  it("changes only the tags line and returns every other byte of the file as it was", () => {
    const out = joinSource({ ...parts, front: setTags(parts.front!, ["cloudflare", "workers", "edge"]) });
    expect(out).toBe(SOURCE.replace("tags: [cloudflare, workers]", "tags: [cloudflare, workers, edge]"));
  });

  it("writes an emptied tag list as tags: [], leaves the same list alone, and adds the key when missing", () => {
    expect(setTags(parts.front!, [])).toContain("tags: []");
    expect(setTags(parts.front!, ["cloudflare", "workers"])).toBe(parts.front);
    expect(setTags("title: x", ["a"])).toBe("title: x\ntags: [a]");
  });

  it("turns a block-form list into the flow form and touches nothing else", () => {
    expect(setTags("title: x\ntags:\n  - a\n  - b\nslug: y", ["a", "b", "c"])).toBe("title: x\ntags: [a, b, c]\nslug: y");
  });

  it("sets one raw key in place or at the end, and never rewrites a line that already says it", () => {
    expect(setRawKey(parts.front!, "draft", "true")).toBe(parts.front!.replace("draft: false", "draft: true"));
    expect(setRawKey("title: x", "draft", "true")).toBe("title: x\ndraft: true");
    expect(setRawKey(parts.front!, "draft", "false")).toBe(parts.front);
  });

  it("replaces a multi-line block, removes an emptied one, and leaves an identical one alone", () => {
    expect(setBlock(parts.front!, "key_takeaways", ["key_takeaways:", '  - "One"'])).toBe(parts.front!.replace('key_takeaways:\n  - "First."\n  - "Second."', 'key_takeaways:\n  - "One"'));
    expect(setBlock(parts.front!, "further_reading", [])).toBe(parts.front!.replace("further_reading:\n  - https://example.com/a\n", ""));
    expect(setBlock(parts.front!, "key_takeaways", ["key_takeaways:", '  - "First."', '  - "Second."'])).toBe(parts.front);
    expect(setBlock(parts.front!, "missing", [])).toBe(parts.front);
  });
});

describe("edge sources", () => {
  it("reads and writes a CRLF frontmatter as CRLF, without a second key", () => {
    const front = splitSource("---\r\ntitle: Hello\r\ntags: [old]\r\n---\r\nBody\r\n").front!;
    expect(readKey(front, "title")).toBe("Hello");
    expect(setRawKey(front, "title", '"Hi"')).toBe('title: "Hi"\r\ntags: [old]');
    expect(setTags(front, ["new"])).toBe("title: Hello\r\ntags: [new]");
  });

  it("quotes a tag that YAML would not read back as the same string", () => {
    const written = setTags("title: x", ["News", "Field notes", "no", "true", "*", "{", "2026", "c#"]);
    expect(written).toBe('title: x\ntags: [News, Field notes, "no", "true", "*", "{", "2026", "c#"]');
    expect(tagsOf(written)).toEqual(["News", "Field notes", "no", "true", "*", "{", "2026", "c#"]);
  });
});
