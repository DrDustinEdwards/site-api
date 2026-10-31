// The frontmatter writes: the source comes back unchanged except for the one block a write names, and
// an unknown key, a comment or a list nobody asked about survives byte for byte.

import { describe, expect, it } from "vitest";

import { JsonSourceError, joinSource, jsonSource, missingAltFields, postFieldsOf, searchFieldsOf, setPostFields, setSearchFields, setTags, splitSource, tagsOf } from "../src/frontmatter.js";

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

// The block reader and writer (splitSource, readKey, setBlock and the rest) are Prelum's and tested there.
describe("reads", () => {
  it("reads the tags in flow form, and none from no frontmatter", () => {
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
});

describe("edge sources", () => {
  it("writes the tags of a CRLF frontmatter as CRLF", () => {
    const front = splitSource("---\r\ntitle: Hello\r\ntags: [old]\r\n---\r\nBody\r\n").front!;
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

describe("post fields (v0.17.0)", () => {
  it("keeps authors in order with a comma in a name, reads a hand-written list, and a blank or a bad part removes the key", () => {
    const front = setPostFields(parts.front!, { authors: ["Smith, Jr.", " Ada "], excerpt: "Short.", series: "Notes", seriesPart: 2 });
    expect(postFieldsOf(front)).toEqual({ authors: ["Smith, Jr.", "Ada"], excerpt: "Short.", series: "Notes", seriesPart: 2, featureImage: "", featureImageAlt: "", featureImageDecorative: false });
    expect(jsonSource({ authors: "list" }).read(`---\n${readLines(front, ["authors"])}\n---\n`).values).toEqual({ authors: ["Smith, Jr.", "Ada"] });
    expect(postFieldsOf("authors:\n  - Ada\n  - Grace\nseriesPart: 0").authors).toEqual(["Ada", "Grace"]);
    expect(postFieldsOf("seriesPart: 0").seriesPart).toBeNull();
    expect(setPostFields(front, { authors: [], excerpt: " ", series: "", seriesPart: null })).toBe(parts.front);
  });

  // v0.19.0 (A2, D8): a feature or share image with no alt blocks, unless the post marks it decorative.
  it("names a feature or share image with no alt text, where the site renders it, and passes one marked decorative", () => {
    const declared = { searchFields: ["image", "imageAlt"], postFields: ["featureImage", "featureImageAlt"] };
    const bare = setSearchFields(setPostFields(parts.front!, { featureImage: "/media/a.png" }), { image: "/media/b.png" });
    expect(missingAltFields(bare, declared)).toEqual(["imageAlt", "featureImageAlt"]);
    expect(missingAltFields(bare, {})).toEqual([]);
    const decorative = setPostFields(bare, { featureImageDecorative: true });
    expect(missingAltFields(decorative, declared)).toEqual(["imageAlt"]);
    const described = setPostFields(bare, { featureImageAlt: "A heron.", featureImageDecorative: false });
    expect(postFieldsOf(described)).toMatchObject({ featureImage: "/media/a.png", featureImageAlt: "A heron.", featureImageDecorative: false });
    expect(missingAltFields(described, { postFields: declared.postFields })).toEqual([]);
  });
});

function readLines(front: string, keys: string[]): string {
  return front.split("\n").filter((line) => keys.some((key) => line.startsWith(`${key}:`))).join("\n");
}
