import { describe, expect, it } from "vitest";
import { contentVersion } from "../src/index.js";

describe("contentVersion", () => {
  // The value the sites' own copies gave for this input, so a site that switches keeps its versions.
  it("is the first 32 hex characters of the SHA-256 of the parts' JSON", async () => {
    expect(await contentVersion(["# Hello", "published", null])).toBe("5bd85f716c47edf5dda4d734c867830d");
    expect(await contentVersion(["# Hello", "draft", null])).not.toBe(await contentVersion(["# Hello", "published", null]));
  });
});
