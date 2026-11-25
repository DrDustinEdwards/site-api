import {
  BacklinkList,
  ContentDoc,
  HookRunList,
  ContentList,
  PreviewLink,
  PreviewLinkList,
  RenameResult,
  PREFIX,
  WriteResult,
} from "../contract.js";
import { splitSource } from "@drdustinedwards/site-helpers/frontmatter";
import {
  postFieldsOf,
  searchFieldsOf,
  setPostFields,
  setSearchFields,
  type PostValues,
  type SearchValues,
} from "../frontmatter.js";
import type { ConformanceContext } from "./context.js";

// The probe post: one post of the run's own, each step a probe, and the post deleted at the end whatever failed.
export async function probePost(ctx: ConformanceContext): Promise<void> {
  const { run, config, doFetch, origin, auth, capabilities, check, skip, probe, expectStatus } =
    ctx;
  const names = [
    "probe post: created as a draft",
    "probe post: every declared post and search field reads back as written",
    "probe post: q matches body text",
    "probe post: a preview link works, honors a short expiry, and answers 404 once revoked",
    "probe post: published, and its public page answers",
    "probe post: each declared hook recorded a run for the publish",
    "probe post: backlinks answer in shape",
    "probe post: a draft saved over the live post reads hasDraft and lists as published and as a draft",
    "probe post: a rename answers 301 from the old path",
    "probe post: trash and restore",
    "probe post: a delete answers 410 on the old path",
    "probe post: cleaned up",
  ] as const;
  const why = !config.probePosts
    ? "probePosts is off"
    : config.probeWrites === false
      ? "probeWrites is off"
      : !capabilities
        ? "meta did not answer"
        : capabilities.contentDelete !== true
          ? "the site cannot delete content (a page site), so a probe post could not be cleaned up"
          : null;
  if (why) {
    for (const name of names) skip(name, why);
    return;
  }
  const caps = capabilities!;
  const json = (method: string, path: string, body?: unknown) =>
    doFetch(`${origin}${PREFIX}${path}`, {
      method,
      headers: { ...auth, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function ok<T>(
    response: Response,
    schema: { parse(v: unknown): T },
    what: string,
  ): Promise<T> {
    if (!response.ok) {
      // The refusal's own words (a site says which field it refused), which the report would otherwise hide.
      const body = (await response.json().catch(() => null)) as {
        error?: string;
        message?: string;
      } | null;
      const words = body?.message ? ` (${body.message})` : "";
      throw new Error(`${what}: ${response.status} ${body?.error ?? ""}${words}`.trim());
    }
    return schema.parse(await response.json());
  }
  // The site's own public route, through baseUrl, never following a redirect. Given the status it should answer, it asks
  // again for up to hookWaitMs: a stored page is purged after the write answers, so the old answer can outlive it briefly.
  const publicPage = async (path: string, status?: number) => {
    const until = Date.now() + (config.hookWaitMs ?? 5000);
    for (;;) {
      const answer = await doFetch(`${origin}${path}`, { redirect: "manual" });
      if (status === undefined || answer.status === status || Date.now() >= until) {
        await answer.body?.cancel().catch(() => {});
        return answer;
      }
      await answer.body?.cancel().catch(() => {});
      await new Promise((done) => setTimeout(done, 500));
    }
  };
  // A site may delete only from its trash (germomics does), so a probe post goes to the trash before every delete.
  const trashFirst = async (doc: { version: string; status: string; trashedAt?: string | null }) =>
    caps.contentTrash && !doc.trashedAt
      ? (
          await ok(
            await json("POST", `/content/${id}/trash`, {
              expectedVersion: doc.version,
              changeId: probe(),
            }),
            WriteResult,
            "trash before delete",
          )
        ).version
      : doc.version;
  const step = async (name: string, passedOver: string | null, run: () => Promise<string>) =>
    passedOver ? (skip(name, passedOver), false) : check(name, run);

  let id = `carrel-conformance-${run}`;
  // Set before the rename is sent: a rename that failed after the site moved the post leaves it under this id.
  let renamedTo: string | null = null;
  let version = "";
  let path = "";
  const word = `probeword${run.replace(/[^a-z0-9]/gi, "")}`;
  const postValues: Partial<PostValues> = {
    excerpt: "Conformance excerpt.",
    authors: [config.author ?? "Conformance Probe"],
    series: "Conformance series",
    seriesPart: 1,
    featureImage: "/conformance-probe.png",
    featureImageAlt: "Conformance probe picture.",
  };
  const searchValues: Partial<SearchValues> = {
    searchTitle: "Conformance search title",
    description: "Conformance description.",
    image: `${config.imageAsUrl ? new URL(origin).origin : ""}/conformance-probe.png`,
    imageAlt: "Conformance probe picture.",
    canonical: `${new URL(origin).origin}/conformance-probe`,
    // Kept out of search wherever the site renders noindex.
    noindex: true,
  };
  const postFields = caps.postFields ?? [];
  const searchFields = caps.searchFields ?? [];
  // The site's own starting source, as Carrel's New post sends it (a site may require a slug, a date or JSON fields
  // beyond the title); only the title is the probe's.
  const title = `title: "Conformance probe ${run}"`;
  const base = config.newSource ? splitSource(config.newSource(id)).front : null;
  let front = base ? base.replace(/^title:.*$/m, title) : title;
  front = setPostFields(front, Object.fromEntries(postFields.map((f) => [f, postValues[f]])));
  front = setSearchFields(front, Object.fromEntries(searchFields.map((f) => [f, searchValues[f]])));
  const source = `---\n${front}\n---\n\nA conformance probe, deleted when the check ends. ${word}\n`;
  const read = async () =>
    ok(await json("GET", `/content/${encodeURIComponent(id)}`), ContentDoc, "read");

  try {
    const made = await check(names[0], async () => {
      version = (
        await ok(
          await json("PUT", `/content/${id}/draft`, {
            source,
            expectedVersion: null,
            changeId: probe(),
          }),
          WriteResult,
          "create",
        )
      ).version;
      return `${id} at ${version}`;
    });
    if (!made) {
      for (const name of names.slice(1, -1)) skip(name, "the probe post could not be created");
      return;
    }

    await step(
      names[1],
      postFields.length + searchFields.length === 0
        ? "the site declares no post or search fields"
        : null,
      async () => {
        const back = splitSource((await read()).source).front;
        const [post, search] = [postFieldsOf(back), searchFieldsOf(back)];
        const changed = [
          ...postFields.filter((f) => JSON.stringify(post[f]) !== JSON.stringify(postValues[f])),
          ...searchFields.filter(
            (f) => JSON.stringify(search[f]) !== JSON.stringify(searchValues[f]),
          ),
        ];
        if (changed.length) throw new Error(`read back changed: ${changed.join(", ")}`);
        return [...postFields, ...searchFields].join(", ");
      },
    );

    await check(names[2], async () => {
      const list = await ok(
        await json("GET", `/content?q=${word}&limit=50`),
        ContentList,
        "search",
      );
      if (!list.items.some((i) => i.id === id))
        throw new Error(`q=${word}, a word only in the body, did not list ${id}`);
      return `q=${word} lists it`;
    });

    await step(names[3], caps.previewLinks ? null : "the site makes no preview links", async () => {
      const hours = caps.previewLinkHours ? { expiresInHours: 1 } : { hours: 1 };
      const link = await ok(
        await json("POST", "/preview-links", { id, changeId: probe(), ...hours }),
        PreviewLink,
        "preview link",
      );
      const left = Date.parse(link.expiresAt) - Date.now();
      if (left > 65 * 60_000 || left < 50 * 60_000)
        throw new Error(`asked for 1 hour, it expires at ${link.expiresAt}`);
      // On the site's own route, through baseUrl: the link's origin may be the site's public one.
      const at = `${origin}${new URL(link.url).pathname}`;
      const open = await doFetch(at);
      await open.body?.cancel().catch(() => {});
      expectStatus(open, 200, "preview link");
      if (!/noindex/i.test(open.headers.get("x-robots-tag") ?? ""))
        throw new Error("the preview link's page does not say noindex");
      const listed = (
        await ok(
          await json("GET", `/preview-links?id=${encodeURIComponent(id)}`),
          PreviewLinkList,
          "preview links",
        )
      ).items[0];
      if (!listed) throw new Error("the new link is not listed");
      await ok(
        await json("DELETE", `/preview-links/${listed.id}?changeId=${probe()}`),
        { parse: (v) => v },
        "revoke",
      );
      const revoked = await doFetch(at);
      await revoked.body?.cancel().catch(() => {});
      expectStatus(revoked, 404, "revoked preview link");
      return "200 noindex, expires in an hour, 404 once revoked";
    });

    const published = probe();
    const live = await check(names[4], async () => {
      version = (
        await ok(
          await json("POST", `/content/${id}/publish`, {
            expectedVersion: version,
            changeId: published,
          }),
          WriteResult,
          "publish",
        )
      ).version;
      const doc = await read();
      if (doc.status !== "published" || !doc.path)
        throw new Error(`after publish: ${doc.status}, path ${doc.path ?? "none"}`);
      path = doc.path;
      expectStatus(await publicPage(path, 200), 200, `public page ${path}`);
      return `${path} answers 200`;
    });

    await step(
      names[5],
      !live
        ? "the probe post did not publish"
        : caps.hooks?.length
          ? null
          : "the site declares no hooks it keeps runs of",
      async () => {
        const wanted = caps.hooks!;
        const until = Date.now() + (config.hookWaitMs ?? 5000);
        for (;;) {
          const runs = (
            await ok(
              await json("GET", `/hooks/recent?changeId=${published}`),
              HookRunList,
              "hook runs",
            )
          ).items;
          const missing = wanted.filter((h) => !runs.some((r) => r.hook === h));
          if (missing.length === 0) {
            const failed = wanted.filter((h) => !runs.some((r) => r.hook === h && r.ok));
            if (failed.length) throw new Error(`failed: ${failed.join(", ")}`);
            return wanted.join(", ");
          }
          if (Date.now() >= until) throw new Error(`no run recorded for ${missing.join(", ")}`);
          await new Promise((done) => setTimeout(done, 500));
        }
      },
    );

    await step(names[6], caps.backlinks ? null : "the site does not list backlinks", async () => {
      const list = await ok(
        await json("GET", `/content/${encodeURIComponent(id)}/backlinks`),
        BacklinkList,
        "backlinks",
      );
      return `${list.items.length} backlink(s)`;
    });

    await step(
      names[7],
      !live
        ? "the probe post did not publish"
        : caps.contentHasDraft
          ? null
          : "the site does not mark a live item's pending draft",
      async () => {
        version = (
          await ok(
            await json("PUT", `/content/${id}/draft`, {
              source: `${source}\nA pending edit.\n`,
              expectedVersion: version,
              changeId: probe(),
            }),
            WriteResult,
            "draft over live",
          )
        ).version;
        const doc = await read();
        if (doc.status !== "published" || doc.hasDraft !== true)
          throw new Error(
            `after a draft over the live post: ${doc.status}, hasDraft ${String(doc.hasDraft)}`,
          );
        for (const status of ["published", "draft"] as const) {
          const list = await ok(
            await json("GET", `/content?status=${status}&limit=200`),
            ContentList,
            `status=${status}`,
          );
          const row = list.items.find((i) => i.id === id);
          if (!row) throw new Error(`status=${status} does not list it`);
          if (row.status !== "published" || row.hasDraft !== true)
            throw new Error(
              `status=${status} lists it as ${row.status}, hasDraft ${String(row.hasDraft)}`,
            );
        }
        return "hasDraft true, listed under published and draft";
      },
    );

    await step(
      names[8],
      !live
        ? "the probe post did not publish"
        : caps.contentRename
          ? null
          : "the site does not rename content",
      async () => {
        const newId = `${id}-renamed`;
        renamedTo = newId;
        const written = await ok(
          await json("POST", `/content/${id}/rename`, {
            newId,
            expectedVersion: version,
            changeId: probe(),
          }),
          RenameResult,
          "rename",
        );
        [id, version] = [newId, written.version];
        const old = path;
        path = (await read()).path ?? "";
        const answer = await publicPage(old, 301);
        expectStatus(answer, 301, `old path ${old}`);
        const to = new URL(answer.headers.get("location") ?? "", origin).pathname;
        if (to !== path) throw new Error(`301 to ${to}, expected ${path}`);
        return `${old} 301 to ${path}`;
      },
    );

    await step(names[9], caps.contentTrash ? null : "the site has no content trash", async () => {
      const trashed = await ok(
        await json("POST", `/content/${id}/trash`, {
          expectedVersion: version,
          changeId: probe(),
        }),
        WriteResult,
        "trash",
      );
      const binned = await ok(
        await json("GET", "/content?trashed=true&limit=200"),
        ContentList,
        "trash list",
      );
      if (!binned.items.some((i) => i.id === id)) throw new Error("not listed in the trash");
      version = (
        await ok(
          await json("POST", `/content/${id}/restore`, {
            expectedVersion: trashed.version,
            changeId: probe(),
          }),
          WriteResult,
          "restore",
        )
      ).version;
      const doc = await read();
      if (doc.status !== "draft" || doc.trashedAt)
        throw new Error(`after restore: ${doc.status}, trashedAt ${doc.trashedAt ?? "null"}`);
      return "trashed, listed in the trash, restored as a draft";
    });

    await step(
      names[10],
      !live
        ? "the probe post did not publish"
        : caps.replay
          ? null
          : "the site has no store, so it keeps no tombstones",
      async () => {
        const doc = await read();
        version =
          doc.status === "published"
            ? doc.version
            : (
                await ok(
                  await json("POST", `/content/${id}/publish`, {
                    expectedVersion: doc.version,
                    changeId: probe(),
                  }),
                  WriteResult,
                  "publish again",
                )
              ).version;
        const gone = (await read()).path ?? path;
        version = await trashFirst({ version, status: "published" });
        expectStatus(
          await json(
            "DELETE",
            `/content/${id}?expectedVersion=${encodeURIComponent(version)}&changeId=${probe()}`,
          ),
          200,
          "delete",
        );
        expectStatus(await publicPage(gone, 410), 410, `deleted page ${gone}`);
        return `${gone} answers 410`;
      },
    );
  } finally {
    await check(names[11], async () => {
      let left = await json("GET", `/content/${encodeURIComponent(id)}`);
      // A rename that threw never moved `id`, yet the site may have moved the post: look under the new id before
      // calling the post gone, or it stays on the site for good.
      if (left.status === 404 && renamedTo && renamedTo !== id) {
        const moved = await json("GET", `/content/${encodeURIComponent(renamedTo)}`);
        if (moved.status !== 404) [id, left] = [renamedTo, moved];
      }
      if (left.status === 404) return `${id} is gone`;
      const doc = await ok(left, ContentDoc, "read before cleaning up");
      const current = await trashFirst(doc);
      expectStatus(
        await json(
          "DELETE",
          `/content/${id}?expectedVersion=${encodeURIComponent(current)}&changeId=${probe()}`,
        ),
        200,
        "cleanup delete",
      );
      return `deleted ${id}`;
    });
  }
}
