import { afterEach, describe, expect, it } from "vitest";

import { keysMatch } from "../src/server.js";

type Subtle = { timingSafeEqual?: (a: Uint8Array, b: Uint8Array) => boolean };
const subtle = crypto.subtle as Subtle;
const original = Object.getOwnPropertyDescriptor(subtle, "timingSafeEqual");

function stub(fn: Subtle["timingSafeEqual"]): void {
  Object.defineProperty(subtle, "timingSafeEqual", { value: fn, configurable: true, writable: true });
}

afterEach(() => {
  if (original) Object.defineProperty(subtle, "timingSafeEqual", original);
  else delete subtle.timingSafeEqual;
});

describe("keysMatch", () => {
  it("hands two 32-byte digests to the runtime's timingSafeEqual and trusts its answer", async () => {
    const sizes: number[][] = [];
    stub((a, b) => {
      sizes.push([a.byteLength, b.byteLength]);
      return false;
    });
    // Equal keys, but the runtime says no: the runtime's answer decides.
    expect(await keysMatch("same-key", "same-key")).toBe(false);
    expect(sizes).toEqual([[32, 32]]);
    stub(() => true);
    expect(await keysMatch("one-key", "another-key-entirely")).toBe(true);
  });

  it("without the runtime method, still tells equal, different and different-length keys apart", async () => {
    stub(undefined);
    expect(await keysMatch("k".repeat(40), "k".repeat(40))).toBe(true);
    expect(await keysMatch("k".repeat(40), `${"k".repeat(39)}x`)).toBe(false);
    expect(await keysMatch("short", "k".repeat(40))).toBe(false);
  });
});
