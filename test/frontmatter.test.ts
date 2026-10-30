// The frontmatter writes: the source comes back unchanged except for the one block a write names, and
// an unknown key, a comment or a list nobody asked about survives byte for byte.

import { describe, expect, it } from "vitest";

import { JsonSourceError, joinSource, jsonSource, readKey, readList, searchFieldsOf, setBlock, setRawKey, setSearchFields, setTags, splitSource, tagsOf } from "../src/frontmatter.js";

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

describe("jsonSource", () => {
  const post = jsonSource({ title: "text", slug: "text", tags: "list", featured: "flag" }, { required: ["title"] });

  it("round-trips its fields as JSON lines and leaves an undefined one out", () => {
    const source = post.write({ title: 'A "quoted" title', slug: null, tags: ["a", "b"], featured: true }, "Body\n");
    expect(source).toBe('---\ntitle: "A \\"quoted\\" title"\nslug: null\ntags: ["a","b"]\nfeatured: true\n---\nBody\n');
    expect(post.read(source)).toEqual({ values: { title: 'A "quoted" title', slug: null, tags: ["a", "b"], featured: true }, body: "Body\n" });
    expect(jsonSource({ title: "text" }, { blankLine: true }).write({}, "B")).toBe("---\n\n---\n\nB");
    expect(post.read("---\r\ntitle: Plain words\r\n---\r\n\r\nBody").values).toEqual({ title: "Plain words" });
  });

  it("names every problem at once", () => {
    let err: unknown;
    try {
      post.read('---\nslug: "x\ntags: "x"\nfeatured: yes\nextra: 1\nslug: "b"\nno colon\n---\nBody');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(JsonSourceError);
    expect((err as JsonSourceError).problems).toEqual([
      "slug: the value is not valid JSON.",
      'tags must be a list of strings, such as ["a", "b"].',
      "featured: the value is not valid JSON.",
      "extra is not a field. The fields are title, slug, tags, featured.",
      "slug appears twice.",
      'This front matter line is not "key: value": no colon',
      "title is required.",
    ]);
  });

  it("reads a source without front matter as all body, unless a field is required", () => {
    expect(jsonSource({ title: "text" }).read("Just a body")).toEqual({ values: {}, body: "Just a body" });
    expect(() => post.read("Just a body")).toThrow(JsonSourceError);
  });
});

describe("search fields", () => {
  it("round-trips through the frontmatter and a jsonSource site, and a blank removes the key", () => {
    const front = setSearchFields(parts.front!, { searchTitle: 'Say "hi": a guide', description: "One line.", noindex: true, image: " " });
    expect(searchFieldsOf(front)).toEqual({ searchTitle: 'Say "hi": a guide', description: "One line.", image: "", imageAlt: "", canonical: "", noindex: true });
    expect(jsonSource({ searchTitle: "text", noindex: "flag" }).read(`---\n${readLines(front, ["searchTitle", "noindex"])}\n---\n`).values).toEqual({ searchTitle: 'Say "hi": a guide', noindex: true });
    const cleared = setSearchFields(front, { searchTitle: "", description: "One table.", noindex: false });
    expect(cleared).toBe(parts.front);
  });
});

function readLines(front: string, keys: string[]): string {
  return front.split("\n").filter((line) => keys.some((key) => line.startsWith(`${key}:`))).join("\n");
}
