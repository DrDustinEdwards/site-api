import { describe, expect, it } from "vitest";
import { orderAndPage } from "../src/adapter.js";

const rows = [
  { title: "b", at: 2 },
  { title: "A", at: 3 },
  { title: "c", at: 1 },
];
const keys = {
  updated: (r: (typeof rows)[number]) => r.at,
  published: (r: (typeof rows)[number]) => r.at,
  title: (r: (typeof rows)[number]) => r.title,
};

describe("orderAndPage", () => {
  it("orders dates newest first and titles A to Z, flips on dir, and cuts the page at the cursor", () => {
    expect(orderAndPage(rows, { limit: 2 }, keys)).toMatchObject({
      page: [rows[1], rows[0]],
      total: 3,
      nextCursor: "2",
      sorted: { sort: "updated", dir: "desc" },
    });
    expect(orderAndPage(rows, { sort: "title", limit: 5 }, keys).page.map((r) => r.title)).toEqual([
      "A",
      "b",
      "c",
    ]);
    expect(
      orderAndPage(rows, { sort: "title", dir: "desc", cursor: "2", limit: 5 }, keys),
    ).toMatchObject({
      page: [rows[1]],
      nextCursor: null,
    });
  });
});
