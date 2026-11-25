// The suite passes on the reference adapter and fails, by name, on each planted defect.

import { describe, expect, it } from "vitest";
import { createSiteApi } from "../src/index.js";
import { runConformance } from "../src/conformance.js";
import { memoryAdapter } from "../src/testing.js";
import { d1SiteApiStore, tombstoneResponse, SITE_API_STORE_SQL } from "../src/store.js";
import { d1 } from "./d1.js";
import { KEY, ORIGIN, allow, site, mountedFetch } from "./helpers.js";

type Adapter = ReturnType<typeof memoryAdapter>;

function failing(report: Awaited<ReturnType<typeof runConformance>>) {
  return report.checks.filter((c) => !c.ok).map((c) => c.name);
}

function metaEdited(
  s: ReturnType<typeof site>,
  edit: (meta: { capabilities: Record<string, unknown> }) => unknown,
): typeof fetch {
  return async (input, init) => {
    const response = await s.fetch(input, init);
    if (!new URL(new Request(input).url).pathname.endsWith("/meta") || !response.ok)
      return response;
    return Response.json(edit(await response.json()));
  };
}

/** The names of the checks that fail when the site stops declaring one capability. */
async function failingWithout(capability: string) {
  const silent = metaEdited(site(), (meta) => {
    const { [capability]: _gone, ...capabilities } = meta.capabilities;
    return { ...meta, capabilities };
  });
  return failing(await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: silent }));
}

function seedPng(s: ReturnType<typeof site>) {
  return s.adapter.media!.upload({
    bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    contentType: "image/png",
    filename: "real.png",
    alt: "",
    changeId: "seed",
  });
}

describe("conformance", () => {
  it("passes a conforming site, with the media checks when it offers media", async () => {
    const report = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: site().fetch });
    expect(failing(report)).toEqual([]);
    expect(report.ok).toBe(true);
    // Every check is also a probe; the probe post's steps are off by default and listed as skipped.
    expect(report.probes.filter((p) => !p.skipped).map((p) => p.name)).toEqual(
      report.checks.map((c) => c.name),
    );
    expect(report.probes.filter((p) => p.skipped)).toHaveLength(12);
    expect(report.probes.find((p) => p.skipped)).toMatchObject({
      name: "probe post: created as a draft",
      detail: "probePosts is off",
    });
  });

  it("passes a v0.14.0 content group, and a site with a store, whose stale write it sends twice and sees replayed", async () => {
    expect(
      failing(
        await runConformance({
          baseUrl: ORIGIN,
          key: KEY,
          fetch: site(memoryAdapter({ contentExtras: false })).fetch,
        }),
      ),
    ).toEqual([]);
    const api = createSiteApi({
      adapter: memoryAdapter(),
      key: KEY,
      limiter: allow,
      log: () => {},
      store: d1SiteApiStore(d1(SITE_API_STORE_SQL)),
    });
    const report = await runConformance({
      baseUrl: ORIGIN,
      key: KEY,
      fetch: (async (i: RequestInfo | URL, init?: RequestInit) =>
        api.handle(new Request(i, init))) as typeof fetch,
    });
    expect(failing(report)).toEqual([]);
    expect(report.checks.find((c) => c.name.startsWith("replay:"))?.ok).toBe(true);
  });

  it("runs only the content checks on a site with no media manager", async () => {
    const report = await runConformance({
      baseUrl: ORIGIN,
      key: KEY,
      fetch: site(memoryAdapter({ media: false })).fetch,
    });
    expect(failing(report)).toEqual([]);
    expect(report.checks.some((c) => c.name.startsWith("media"))).toBe(false);
  });

  it.each([
    ["contentDelete", "content delete of an unknown id"],
    ["contentTags", "content tags"],
    ["mentionReset", "mention reset"],
  ] as const)(
    "expects 501 from %s on a site without it, and 404 where it has it",
    async (option, prefix) => {
      const detail = async (adapter?: ReturnType<typeof memoryAdapter>) => {
        const report = await runConformance({
          baseUrl: ORIGIN,
          key: KEY,
          fetch: site(adapter).fetch,
        });
        expect(failing(report)).toEqual([]);
        return report.checks.find((c) => c.name.startsWith(prefix))?.detail;
      };
      expect(await detail(memoryAdapter({ [option]: false }))).toBe("501 not-implemented");
      expect(await detail()).toBe("404 not-found");
    },
  );

  it("expects 501 from every mentions check on a site without the group, and runs only the five that apply", async () => {
    const report = await runConformance({
      baseUrl: ORIGIN,
      key: KEY,
      fetch: site(memoryAdapter({ mentions: false })).fetch,
    });
    expect(failing(report)).toEqual([]);
    const mentions = report.checks.filter((c) => c.name.startsWith("mention"));
    expect(mentions.map((c) => c.detail)).toEqual([
      "501 not-implemented",
      "401",
      "501 not-implemented",
      "501 not-implemented",
      "501 not-implemented",
    ]);
  });

  it("with a real mention in the queue, the stale-version probe runs against it and changes nothing", async () => {
    const adapter = memoryAdapter();
    const id = adapter.receiveMention({
      sourceUrl: "https://a.example/post",
      targetId: "first-post",
    });
    const before = structuredClone(adapter.mentionStore.get(id));
    const report = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: site(adapter).fetch });
    expect(failing(report)).toEqual([]);
    expect(report.checks.find((c) => c.name.startsWith("mention decide on a stale"))?.detail).toBe(
      `409 version-conflict on mention ${id}, unchanged`,
    );
    expect(adapter.mentionStore.get(id)).toEqual(before);
    expect(adapter.purged).toEqual([]);
  });

  it("expects 501 from every lens on a site that names none, and passes it", async () => {
    const report = await runConformance({
      baseUrl: ORIGIN,
      key: KEY,
      fetch: site(memoryAdapter({ mediaLenses: false })).fetch,
    });
    expect(failing(report)).toEqual([]);
    expect(report.checks.find((c) => c.name.startsWith("media lenses"))?.detail).toBe(
      "501 for every lens",
    );
  });

  it("PLANT: fails a site that answers a lens it does not name with its whole library", async () => {
    const adapter = memoryAdapter();
    (adapter.media as { lenses?: readonly string[] }).lenses = ["unattached"];
    const s = site(adapter);
    // A site that serves every lens but names one: what it answers for the others is not what was asked.
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.searchParams.get("lens") && url.searchParams.get("lens") !== "unattached")
        url.searchParams.set("lens", "unattached");
      return s.fetch(url, init);
    }) as typeof globalThis.fetch;
    const report = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch });
    expect(failing(report)).toEqual([
      "media lenses: each one the site names answers, and one it does not is not implemented",
    ]);
  });

  it("expects 501 from the 404 report on a site without it, and the report where it has one", async () => {
    const without = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: site().fetch });
    expect(without.checks.find((c) => c.name.startsWith("not-found report"))?.detail).toBe(
      "501 not-implemented",
    );
    const rows = [
      {
        path: "/old-post",
        kind: "page" as const,
        hits: 3,
        referrers: [{ host: "a.example", hits: 3 }],
      },
    ];
    const withReport = await runConformance({
      baseUrl: ORIGIN,
      key: KEY,
      fetch: site(memoryAdapter({ notFound: rows })).fetch,
    });
    expect(failing(withReport)).toEqual([]);
    expect(
      withReport.checks.filter((c) => c.name.startsWith("not-found report")).map((c) => c.detail),
    ).toEqual(["1 missing path(s) in 7 days", "400 invalid"]);
  });

  it.each([
    [
      "decides a mention it does not hold",
      (a: Adapter) =>
        (a.mentions!.decide = async () => ({ status: "approved", version: "m9", purged: null })),
      "mention decide of an unknown id: refused, or not implemented where the site has no mentions",
    ],
    [
      "resets a mention it does not hold",
      (a: Adapter) =>
        (a.mentions!.reset = async () => ({ status: "pending", version: "m9", purged: null })),
      "mention reset of an unknown id: refused, or not implemented where the site has no reset",
    ],
    [
      "deletes a mention it does not hold",
      (a: Adapter) => (a.mentions!.delete = async () => ({ purged: null })),
      "mention delete of an unknown id: refused, or not implemented where the site has no mentions",
    ],
    [
      "tags a post it does not hold",
      (a: Adapter) =>
        (a.content.setTags = async (id, input) => ({
          id,
          version: "v9",
          status: "draft",
          changeId: input.changeId,
        })),
      "content tags of an unknown id: refused, or not implemented where the site keeps no tags",
    ],
    [
      "answers a delete of an item it does not hold as done",
      (a: Adapter) => (a.content.delete = async () => {}),
      "content delete of an unknown id: refused, or not implemented where the site has no delete",
    ],
    [
      "writes a transcript for an id it does not hold",
      (a: Adapter) => (a.content.setTranscript = async () => ({ version: "v1" })),
      "content transcript of an unknown id: refused, or not implemented where transcripts are read only",
    ],
    [
      "answers a delete of a file it does not hold as done",
      (a: Adapter) => (a.media!.delete = async () => {}),
      "media delete of an unknown id: refused",
    ],
    [
      "accepts an alt write on a file it does not hold",
      (a: Adapter) => (a.media!.setAlt = async () => ({ version: "x" })),
      "media alt of an unknown id: refused, or not implemented where the site lacks it",
    ],
  ])("PLANT: fails a site that %s", async (_name, plant, check) => {
    const adapter = memoryAdapter();
    plant(adapter);
    const report = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: site(adapter).fetch });
    expect(failing(report)).toEqual([check]);
  });

  it("PLANT: fails a site that ignores the version on a mention decision", async () => {
    const adapter = memoryAdapter();
    adapter.receiveMention({ sourceUrl: "https://a.example/post", targetId: "first-post" });
    const decide = adapter.mentions!.decide;
    adapter.mentions!.decide = (id, input) =>
      decide(id, {
        ...input,
        expectedVersion: adapter.mentionStore.get(id)?.version ?? input.expectedVersion,
      });
    const report = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: site(adapter).fetch });
    expect(failing(report)).toEqual([
      "mention decide on a stale version: refused, whatever mention is first",
    ]);
  });

  it("PLANT: fails a site whose revision list leaves out the current version", async () => {
    const adapter = memoryAdapter();
    await adapter.content.saveDraft("a-post", {
      source: "---\ntitle: A\n---\nOne",
      expectedVersion: null,
      changeId: "chg_1",
    });
    const revisions = adapter.content.revisions.bind(adapter.content);
    adapter.content.revisions = async (id) => (await revisions(id))?.slice(1) ?? null;
    const report = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: site(adapter).fetch });
    expect(failing(report)).toContain("revisions: the newest is the item's current version");
  });

  it("changes nothing on a conforming site: no content, no file stored, no file deleted or edited", async () => {
    const s = site();
    const item = await seedPng(s);
    await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: s.fetch });
    expect(s.adapter.mediaStore.get(item.id)?.item).toEqual(item);
    expect(s.adapter.store.size).toBe(0);
    expect(s.adapter.deletedContent).toEqual([]);
    expect([...s.adapter.mediaStore.keys()]).toEqual(["uploads/1-real.png"]);
    expect(s.adapter.deleted).toEqual([]);
  });

  it("with probeMediaUpload, uploads a file of its own and deletes that file and no other", async () => {
    const s = site();
    await seedPng(s);
    const report = await runConformance({
      baseUrl: ORIGIN,
      key: KEY,
      fetch: s.fetch,
      probeMediaUpload: true,
    });
    expect(failing(report)).toEqual([]);
    expect(report.checks.find((c) => c.name.startsWith("media round trip"))).toMatchObject({
      name: "media round trip: upload, read, delete its own file",
      ok: true,
    });
    expect([...s.adapter.mediaStore.keys()]).toEqual(["uploads/1-real.png"]);
    expect(s.adapter.deleted).toEqual(["uploads/2-carrel-conformance-probe.png"]);
  });

  it("PLANT: fails a site that accepts a type it never declared", async () => {
    const s = site(
      memoryAdapter({
        media: { maxBytes: 1000, types: ["image/png", "application/x-carrel-conformance-probe"] },
      }),
    );
    const report = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: s.fetch });
    expect(failing(report)).toEqual(["media upload of a type the site does not accept: refused"]);
  });

  it("expects 501 from every media write on a v0.2.0 site, and passes it", async () => {
    const report = await runConformance({
      baseUrl: ORIGIN,
      key: KEY,
      fetch: site(memoryAdapter({ mediaWrites: false })).fetch,
    });
    expect(failing(report)).toEqual([]);
    const details = report.checks
      .filter((c) =>
        /^media (alt|tags|trash|restore|focus|caption|replace|bulk|empty)/.test(c.name),
      )
      .map((c) => c.detail);
    expect(details).toHaveLength(12);
    expect(details.every((d) => d.startsWith("501"))).toBe(true);
  });

  it.each([
    [
      "mentions",
      [
        "mentions: advertised in capabilities, or answered 501",
        "mention decide of an unknown id: refused, or not implemented where the site has no mentions",
        "mention delete of an unknown id: refused, or not implemented where the site has no mentions",
        "mention reset of an unknown id: refused, or not implemented where the site has no reset",
      ],
    ],
    [
      "contentDelete",
      ["content delete of an unknown id: refused, or not implemented where the site has no delete"],
    ],
    [
      "mediaTrash",
      [
        "media trash of an unknown id: refused, or not implemented where the site lacks it",
        "media restore of an unknown id: refused, or not implemented where the site lacks it",
        "media bulk: an unknown id is that file's own not-found, and the request answers 200",
        "media empty trash with a body outside the contract: refused, or not implemented where the site has no trash",
      ],
    ],
    ["mediaUpload", ["media: upload limits declared"]],
  ])(
    "PLANT: fails a site that offers %s but does not say so in its capabilities",
    async (capability, expected) => {
      expect(await failingWithout(capability)).toEqual(expected);
    },
  );

  it("PLANT: fails a site that ignores expectedVersion", async () => {
    const adapter = memoryAdapter();
    const save = adapter.content.saveDraft;
    adapter.content.saveDraft = (id, input) => save(id, { ...input, expectedVersion: null });
    const report = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: site(adapter).fetch });
    expect(failing(report)).toContain("stale expectedVersion: refused");
  });

  it("PLANT: fails a site that serves the key off its prefix", async () => {
    const api = createSiteApi({ adapter: memoryAdapter(), key: KEY, limiter: allow });
    const leaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.startsWith("/api/carrel/")) {
        // The defect: rewrites any version to v1, so the key reaches beyond the prefix.
        const url = new URL(request.url);
        url.pathname = url.pathname.replace(/^\/api\/carrel\/[^/]+/, "/api/carrel/v1");
        return api.handle(new Request(url, request));
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const report = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: leaky });
    expect(failing(report)).toEqual(["key off-prefix: not served"]);
  });

  it("PLANT: fails a site on a different contract", async () => {
    const s = site();
    const drifted = metaEdited(s, (meta) => {
      return { ...meta, schemaHash: "0".repeat(64), packageVersion: "0.0.9" };
    });
    const report = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch: drifted });
    expect(failing(report)).toEqual(["meta: answers with this contract's schema hash"]);
  });

  it("PLANT: fails a site with the wrong key configured", async () => {
    const report = await runConformance({
      baseUrl: ORIGIN,
      key: `${KEY}-other`,
      fetch: site().fetch,
    });
    expect(failing(report)).toContain("meta: answers with this contract's schema hash");
    expect(report.ok).toBe(false);
  });

  // A site whose public routes answer as a real site's do, for the probe post.
  function liveSite(
    options: { tombstones?: boolean; contentDelete?: boolean; deleteFromTrashOnly?: boolean } = {},
  ) {
    const adapter = memoryAdapter({
      site: { id: "memory", name: "Memory site", origin: ORIGIN },
      ...(options.contentDelete === false ? { contentDelete: false } : {}),
      ...(options.deleteFromTrashOnly ? { deleteFromTrashOnly: true } : {}),
    });
    const store = d1SiteApiStore(d1(SITE_API_STORE_SQL));
    const api = createSiteApi({
      adapter,
      key: KEY,
      limiter: allow,
      log: () => {},
      store,
      hooks: [{ name: "probe-hook", run: () => true }],
    });
    const fetch = mountedFetch(api, async (request) => {
      const { pathname } = new URL(request.url);
      const moved = adapter.redirects.get(pathname);
      if (moved) return new Response(null, { status: 301, headers: { location: moved } });
      if (
        [...adapter.store.values()].some(
          (s) => s.doc.status === "published" && s.doc.path === pathname,
        )
      )
        return new Response("<p>post</p>");
      if (options.tombstones !== false && (await store.isGone(pathname)))
        return tombstoneResponse(request);
      return new Response("Not found", { status: 404 });
    });
    return { adapter, fetch };
  }

  it("with probePosts, takes a post of its own through its life, lists every probe, and leaves nothing behind, on a site that deletes only from the trash", async () => {
    const { adapter, fetch: inner } = liveSite({ deleteFromTrashOnly: true });
    // A stored page is purged after the write answers: the first answer for a moved or deleted page is the stale one.
    const stale = new Set<string>();
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const answer = await inner(input, init);
      const url = new Request(input).url;
      if (![301, 410].includes(answer.status) || stale.has(url)) return answer;
      stale.add(url);
      return new Response("<p>post</p>");
    }) as typeof globalThis.fetch;
    const report = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch, probePosts: true });
    expect(failing(report)).toEqual([]);
    const post = report.probes.filter((p) => p.name.startsWith("probe post:"));
    expect(post.map((p) => [p.name.slice(12), p.skipped ?? false])).toEqual([
      ["created as a draft", false],
      ["every declared post and search field reads back as written", false],
      ["q matches body text", false],
      ["a preview link works, honors a short expiry, and answers 404 once revoked", false],
      ["published, and its public page answers", false],
      ["each declared hook recorded a run for the publish", false],
      ["backlinks answer in shape", false],
      [
        "a draft saved over the live post reads hasDraft and lists as published and as a draft",
        false,
      ],
      ["a rename answers 301 from the old path", false],
      ["trash and restore", false],
      ["a delete answers 410 on the old path", false],
      ["cleaned up", false],
    ]);
    expect(post[5]!.detail).toBe("probe-hook");
    expect(adapter.store.size).toBe(0);
  });

  it("starts the probe post from the site's own new-post source and share-image form, for a site that requires both", async () => {
    const { adapter, fetch: inner } = liveSite();
    // A site that needs a slug, and takes the share image as a path (or, with `url`, as a whole address).
    const picky = (url: boolean) =>
      ((input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        return request.method === "PUT" &&
          /\/content\/carrel-conformance-[0-9a-f]{8}\/draft/.test(request.url)
          ? request
              .clone()
              .json()
              .then((body: { source: string }) =>
                /^slug:/m.test(body.source) &&
                /^image: "https?:/m.test(body.source) === url &&
                (!url || /^authors: \["Foxing"\]/m.test(body.source))
                  ? inner(request)
                  : Response.json(
                      { error: "refused", message: "invalid frontmatter: slug" },
                      { status: 422 },
                    ),
              )
          : inner(input, init);
      }) as typeof globalThis.fetch;
    const base = { baseUrl: ORIGIN, key: KEY, probePosts: true };
    const newSource = (id: string) => `---\ntitle: ""\nslug: ${id}\n---\n`;
    const refused = await runConformance({ ...base, fetch: picky(false) });
    expect(failing(refused)).toEqual(["probe post: created as a draft"]);
    expect(refused.checks.find((c) => !c.ok)!.detail).toBe(
      "create: 422 refused (invalid frontmatter: slug)",
    );
    expect(failing(await runConformance({ ...base, fetch: picky(false), newSource }))).toEqual([]);
    expect(
      failing(
        await runConformance({
          ...base,
          fetch: picky(true),
          newSource,
          imageAsUrl: true,
          author: "Foxing",
        }),
      ),
    ).toEqual([]);
    expect(adapter.store.size).toBe(0);
  });

  it("PLANT: fails a site whose not-found page never answers 410, and still deletes its probe post; skips a page site", async () => {
    const { adapter, fetch } = liveSite({ tombstones: false });
    const report = await runConformance({
      baseUrl: ORIGIN,
      key: KEY,
      fetch,
      probePosts: true,
      hookWaitMs: 600,
    });
    expect(failing(report)).toEqual(["probe post: a delete answers 410 on the old path"]);
    expect(adapter.store.size).toBe(0);
    const page = await runConformance({
      baseUrl: ORIGIN,
      key: KEY,
      fetch: liveSite({ contentDelete: false }).fetch,
      probePosts: true,
    });
    expect(failing(page)).toEqual([]);
    expect(
      page.probes
        .filter((p) => p.name.startsWith("probe post:"))
        .every((p) => p.skipped && /cannot delete/.test(p.detail!)),
    ).toBe(true);
  });

  it("PLANT: a rename that moved the post but answered an error does not leave the probe post behind", async () => {
    const { adapter, fetch: inner } = liveSite();
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const answer = await inner(request);
      return request.method === "POST" && request.url.endsWith("/rename")
        ? new Response("boom", { status: 500 })
        : answer;
    }) as typeof globalThis.fetch;
    const report = await runConformance({ baseUrl: ORIGIN, key: KEY, fetch, probePosts: true });
    expect(failing(report)).toContain("probe post: a rename answers 301 from the old path");
    expect(failing(report)).not.toContain("probe post: cleaned up");
    expect(adapter.store.size).toBe(0);
  });

  it("skips the write probe when told to", async () => {
    const report = await runConformance({
      baseUrl: ORIGIN,
      key: KEY,
      fetch: site().fetch,
      probeWrites: false,
    });
    expect(report.checks.map((c) => c.name)).not.toContain("stale expectedVersion: refused");
  });
});
