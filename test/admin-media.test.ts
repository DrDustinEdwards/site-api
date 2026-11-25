// The content kit's media: view data and intents, against the in-memory reference site.

import { describe, expect, it } from "vitest";
import {
  loadMedia,
  loadMediaChanges,
  readMediaQuery,
  runMediaIntent,
  type ContentSource,
} from "../src/admin.js";
import { localClient } from "../src/client.js";
import { png, withDns } from "./helpers.js";
import { EDITOR, PNG, post, setup, upload } from "./admin-helpers.js";

describe("media", () => {
  it("loads the library and the trash with absolute addresses, the inspector's uses, and the site's offers", async () => {
    const { client, source } = setup();
    const a = await upload(client, "a.png");
    const b = await upload(client, "b.png");
    await client.media.trash(b.id, { expectedVersion: b.version!, changeId: "t1" });
    await post(client, "uses", `title: U\n---\n![x](/media/${a.id})`);
    const library = await loadMedia(source, { inspect: a.id });
    expect(library.rows.map((r) => [r.id, r.src])).toEqual([
      [a.id, `https://memory.example/media/${a.id}`],
    ]);
    expect(library.detail?.usedBy).toEqual([expect.objectContaining({ id: "uses" })]);
    expect(library.offers).toMatchObject({ media: true, alt: true, tags: true, trash: true });
    expect((await loadMedia(source, { view: "trash" })).rows.map((r) => r.id)).toEqual([b.id]);
    expect(await loadMedia(setup({ media: false }).source)).toMatchObject({
      rows: [],
      offers: { media: false, upload: null },
    });
  });

  it("sends a lens and a sort the site answers (v0.6.0), drops a lens it does not, and sorts the page itself where the site did not", async () => {
    const { adapter, client, source } = setup();
    const small = await upload(client, "b.png");
    await client.media.setAlt(small.id, {
      alt: "Described",
      expectedVersion: small.version!,
      changeId: "s1",
    });
    // A file stored before v0.19.0, with no alt and no one's choice: the lens names it, and leaves the decorative b.png out.
    await adapter.media!.upload({
      bytes: PNG,
      contentType: "image/png",
      filename: "a.png",
      alt: "",
      changeId: "u-a",
    });
    await client.media.setAlt(small.id, {
      alt: "",
      decorative: true,
      expectedVersion: adapter.mediaStore.get(small.id)!.item.version!,
      changeId: "s2",
    });
    const lensed = await loadMedia(source, { lens: "no-alt", sort: "name" });
    expect(lensed.rows.map((r) => r.filename)).toEqual(["a.png"]);
    expect(lensed.page).toEqual({ nextCursor: null, total: 1, changeCursor: expect.any(String) });
    expect(lensed.offers.lenses).toEqual([
      "unattached",
      "no-alt",
      "large",
      "license-expired",
      "oversized",
    ]);
    expect((await loadMedia(source, { sort: "name" })).rows.map((r) => r.filename)).toEqual([
      "a.png",
      "b.png",
    ]);

    const old = setup({ mediaLenses: false });
    await upload(old.client, "b.png");
    await upload(old.client, "a.png");
    const fallback = await loadMedia(old.source, { lens: "no-alt", sort: "name", dir: "desc" });
    expect(fallback.offers.lenses).toEqual([]);
    expect(fallback.rows.map((r) => r.filename)).toEqual(["b.png", "a.png"]);
    expect(fallback.page.sortedOnPage).toBe(true);
  });

  it("trashes in one bulk request, and Undo restores at the versions the trash made", async () => {
    const { adapter, client, source } = setup();
    const a = await upload(client, "a.png");
    const trashed = await runMediaIntent(source, {
      intent: "trash",
      ids: [a.id],
      versions: [a.version!],
    });
    expect(trashed).toMatchObject({
      ok: true,
      message: "Moved to the trash 1 file.",
      undo: { intent: "restore" },
    });
    expect(adapter.mediaStore.get(a.id)!.item.trashedAt).not.toBeNull();
    expect(
      (await runMediaIntent(source, { intent: trashed.undo!.intent, ...trashed.undo!.fields })).ok,
    ).toBe(true);
    expect(adapter.mediaStore.get(a.id)!.item.trashedAt).toBeNull();
  });

  it("refuses a write with no version the person saw, and names a stale one as a conflict", async () => {
    const { client, source } = setup();
    const a = await upload(client, "a.png");
    expect(
      (await runMediaIntent(source, { intent: "trash", ids: [a.id] })).outcomes![0],
    ).toMatchObject({ ok: false, message: expect.stringContaining("did not say which version") });
    const stale = await runMediaIntent(source, { intent: "trash", ids: [a.id], versions: ["m0"] });
    expect(stale).toMatchObject({ ok: false, conflict: { id: a.id, currentVersion: a.version } });
    const staleTag = await runMediaIntent(source, {
      intent: "tag-add",
      ids: [a.id],
      versions: ["m0"],
      tags: "x",
    });
    expect(staleTag).toMatchObject({
      ok: false,
      conflict: { id: a.id, currentVersion: a.version },
    });
  });

  it("adds a tag only to the files that lack it, and Undo removes it from those only", async () => {
    const { adapter, client, source } = setup();
    const a = await upload(client, "a.png");
    const b = await upload(client, "b.png");
    const bTagged = await client.media.setTags(b.id, {
      tags: ["blue"],
      expectedVersion: b.version!,
      changeId: "s1",
    });
    // A form with no script posts each ticked box's version under its own id.
    const added = await runMediaIntent(source, {
      intent: "tag-add",
      ids: [a.id, b.id],
      [`version:${a.id}`]: a.version!,
      [`version:${b.id}`]: bTagged.version,
      "version:unticked.png": "m9",
      tags: "Blue",
    });
    expect(added.outcomes).toEqual([
      { id: b.id, ok: true, message: "Already had those tags. Not changed." },
      { id: a.id, ok: true, message: "Tags added." },
    ]);
    expect(adapter.mediaStore.get(b.id)!.item.version).toBe(bTagged.version);
    expect(added.undo).toEqual({
      intent: "tag-remove",
      fields: {
        ids: [a.id],
        versions: [adapter.mediaStore.get(a.id)!.item.version],
        tags: ["blue"],
      },
    });
    await runMediaIntent(source, { intent: added.undo!.intent, ...added.undo!.fields });
    expect(adapter.mediaStore.get(a.id)!.item.tags).toEqual([]);
    expect(adapter.mediaStore.get(b.id)!.item.tags).toEqual(["blue"]);
  });

  it("sets a file's whole tag set, and Undo puts back the set it held", async () => {
    const { adapter, client, source } = setup();
    const a = await upload(client, "a.png");
    const first = await client.media.setTags(a.id, {
      tags: ["old"],
      expectedVersion: a.version!,
      changeId: "s1",
    });
    const set = await runMediaIntent(source, {
      intent: "tags",
      ids: [a.id],
      versions: [first.version],
      tags: "new, other",
    });
    // The outcome carries the version the write made, so the inspector's next field saves on it.
    expect(set.outcomes![0]!.version).toBe(adapter.mediaStore.get(a.id)!.item.version);
    expect(adapter.mediaStore.get(a.id)!.item.tags).toEqual(["new", "other"]);
    await runMediaIntent(source, { intent: set.undo!.intent, ...set.undo!.fields });
    expect(adapter.mediaStore.get(a.id)!.item.tags).toEqual(["old"]);
  });

  it("lets an Editor change a file's words only while no page uses it; the Owner always", async () => {
    const { adapter, client, source } = setup();
    const a = await upload(client, "a.png");
    const editor = { ...source, can: EDITOR };
    const caption = (s: ContentSource, text: string) =>
      runMediaIntent(s, {
        intent: "caption",
        ids: [a.id],
        versions: [adapter.mediaStore.get(a.id)!.item.version!],
        caption: text,
      });
    expect((await caption(editor, "Before it is used.")).ok).toBe(true);
    await post(client, "uses", `title: U\n---\n![x](/media/${a.id})`);
    expect(await caption(editor, "Changed on a live page.")).toMatchObject({ ok: false });
    expect(adapter.mediaStore.get(a.id)!.item.caption).toBe("Before it is used.");
    expect((await caption(source, "The Owner's words.")).ok).toBe(true);
  });

  it("deletes for good only from the trash, and a file in use is refused with its uses named", async () => {
    const { adapter, client, source } = setup();
    const a = await upload(client, "a.png");
    expect(
      (await runMediaIntent(source, { intent: "delete", ids: [a.id] })).outcomes![0],
    ).toMatchObject({ ok: false, message: expect.stringContaining("trash first") });
    const t = await client.media.trash(a.id, { expectedVersion: a.version!, changeId: "t1" });
    await post(client, "uses", `title: U\n---\n![x](/media/${a.id})`);
    const refusedDelete = await runMediaIntent(source, {
      intent: "delete",
      ids: [a.id],
      versions: [t.version],
      confirm: "1",
    });
    expect(refusedDelete.outcomes![0]).toMatchObject({
      ok: false,
      usedBy: [expect.objectContaining({ id: "uses" })],
    });
    expect(adapter.deleted).toEqual([]);
    expect(
      await runMediaIntent({ ...source, can: EDITOR }, { intent: "delete", ids: [a.id] }),
    ).toEqual({ ok: false, message: "Deleting a file for good is the Owner's step." });
  });

  it("empties the trash: deletes what nothing uses, keeps what a post uses, says which, and records each under the site's change id", async () => {
    const { adapter, client, source, records } = setup();
    for (const name of ["a.png", "b.png"]) {
      const item = await upload(client, name);
      await client.media.trash(item.id, {
        expectedVersion: item.version!,
        changeId: `t-${name.slice(0, 1)}`,
      });
    }
    const [first, second] = [...adapter.mediaStore.keys()];
    await post(client, "uses", `title: U\n---\n![x](/media/${second})`);
    expect((await runMediaIntent(source, { intent: "empty-trash" })).confirm).toMatchObject({
      typeToConfirm: "2",
    });
    expect(adapter.deleted).toEqual([]);
    const emptied = await runMediaIntent(source, { intent: "empty-trash", confirm: "2" });
    const trashOrder = [second, first];
    expect(records.filter((r) => r.kind === "media-delete").map((r) => r.changeId)).toEqual([
      expect.stringMatching(new RegExp(`-${trashOrder.indexOf(first!) + 1}$`)),
    ]);
    expect(emptied.message).toBe(
      "Deleted 1 file from the trash for good. 1 file is still used and stayed in the trash.",
    );
    expect(adapter.deleted).toEqual([first]);
    expect(emptied.outcomes!.find((o) => !o.ok)).toMatchObject({
      id: second,
      usedBy: [expect.objectContaining({ id: "uses" })],
    });
  });

  it("checks an upload against the site's limits before sending a byte, then uploads with its alt text", async () => {
    const { adapter, source, records } = setup({ media: { maxBytes: 64, types: ["image/png"] } });
    const big = await runMediaIntent(source, {
      intent: "upload",
      file: new File([new Uint8Array(65)], "big.png", { type: "image/png" }),
    });
    expect(big).toEqual({
      ok: false,
      message: "big.png is 1 KB; this site accepts files up to 1 KB.",
    });
    const wrong = await runMediaIntent(source, {
      intent: "upload",
      file: new File(["x"], "a.gif", { type: "image/gif" }),
    });
    expect(wrong.message).toBe("a.gif is image/gif; this site accepts png.");
    expect(adapter.mediaStore.size).toBe(0);
    const form = new FormData();
    form.set("intent", "upload");
    form.set("alt", "A square");
    form.set("file", new File([PNG], "sq.png", { type: "image/png" }));
    expect(await runMediaIntent(source, form)).toMatchObject({
      ok: true,
      message: "Uploaded sq.png.",
    });
    expect([...adapter.mediaStore.values()][0]!.item.alt).toBe("A square");
    expect(records).toEqual([expect.objectContaining({ kind: "media-upload" })]);
  });

  it("replaces a file as the Owner only, and sets and clears its focal point (v0.10.0)", async () => {
    const { adapter, client, source, records } = setup();
    const a = await upload(client, "a.png");
    const focused = await runMediaIntent(source, {
      intent: "focus",
      ids: [a.id],
      versions: [a.version!],
      focus: "0.3x0.6",
    });
    expect(focused).toMatchObject({ ok: true, message: "Focal point saved." });
    // A form with no script posts the point as two percents.
    const fromForm = await runMediaIntent(source, {
      intent: "focus",
      ids: [a.id],
      versions: [adapter.mediaStore.get(a.id)!.item.version!],
      x: "25.5",
      y: "100",
    });
    expect(fromForm).toMatchObject({ ok: true });
    expect(adapter.mediaStore.get(a.id)!.item.focus).toBe("0.255x1");
    expect(
      await runMediaIntent(source, {
        intent: "focus",
        ids: [a.id],
        versions: [adapter.mediaStore.get(a.id)!.item.version!],
        x: "120",
        y: "5",
      }),
    ).toEqual({ ok: false, message: "That is not a point on the picture." });
    const v = adapter.mediaStore.get(a.id)!.item.version!;
    const file = new File([PNG, new Uint8Array([7])], "a2.png", { type: "image/png" });
    expect(
      await runMediaIntent(
        { ...source, can: EDITOR },
        { intent: "replace", ids: [a.id], versions: [v], file },
      ),
    ).toEqual({ ok: false, message: "Replacing a file is the Owner's step." });
    const replaced = await runMediaIntent(source, {
      intent: "replace",
      ids: [a.id],
      versions: [v],
      file,
    });
    expect(replaced).toMatchObject({
      ok: true,
      message: expect.stringMatching(/^Replaced\. Every page/),
    });
    expect(adapter.mediaStore.get(a.id)!.item).toMatchObject({ focus: null, filename: "a2.png" });
    expect(records.map((r) => r.kind)).toEqual(["media-focus", "media-focus", "media-replace"]);
    // A site whose replace must keep the picture's size says so (v0.11.0), and the library's offers carry it.
    expect((await loadMedia(source)).offers.replaceKeepsSize).toBe(false);
    expect(
      (await loadMedia(setup({ mediaReplaceKeepsSize: true }).source)).offers.replaceKeepsSize,
    ).toBe(true);
  });

  it("imports from the web, says when an upload was already in the library, and saves credit and license (v0.13.0)", async () => {
    const remote = (async () =>
      new Response(png(30, 20) as Uint8Array<ArrayBuffer>, {
        headers: { "content-type": "image/png" },
      })) as typeof fetch;
    const { adapter, source, records } = setup({
      mediaDuplicates: true,
      mediaImportFetch: withDns(remote),
    });
    expect((await loadMedia(source)).offers).toMatchObject({
      import: true,
      credit: true,
      duplicates: true,
      transform: true,
      history: true,
      live: true,
      resize: { maxEdge: 2048 },
      resizePass: true,
    });
    const file = () =>
      new File([png(10, 10) as Uint8Array<ArrayBuffer>], "a.png", { type: "image/png" });
    expect(
      await runMediaIntent(source, { intent: "upload", alt: "A test picture", file: file() }),
    ).toMatchObject({ ok: true, message: "Uploaded a.png." });
    expect(
      await runMediaIntent(source, { intent: "upload", alt: "A test picture", file: file() }),
    ).toMatchObject({
      ok: true,
      message: "a.png is already in the library as a.png, so no second copy was stored.",
      outcomes: [{ duplicate: true }],
    });
    expect(
      await runMediaIntent(source, { intent: "import", url: "http://photos.example.com/b.png" }),
    ).toEqual({ ok: false, message: "Give the file's https address." });
    expect(
      await runMediaIntent(source, {
        intent: "import",
        url: "https://photos.example.com/b.png",
        alt: "A test picture",
      }),
    ).toMatchObject({ ok: true, message: "Imported b.png." });
    expect(records.map((r) => r.kind)).toEqual(["media-upload", "media-import"]);

    const [id] = [...adapter.mediaStore.keys()];
    const version = adapter.mediaStore.get(id!)!.item.version!;
    expect(
      await runMediaIntent(source, {
        intent: "credit",
        ids: [id!],
        versions: [version],
        licenseExpires: "soon",
      }),
    ).toEqual({ ok: false, message: "The license end is not a date." });
    const credited = await runMediaIntent(source, {
      intent: "credit",
      ids: [id!],
      versions: [version],
      credit: "Ada Example",
      license: "CC BY 4.0",
      sourceUrl: "https://example.com/a",
      licenseExpires: "2030-01-01",
    });
    expect(credited).toMatchObject({ ok: true, message: "Credit saved." });
    expect(adapter.mediaStore.get(id!)!.item).toMatchObject({
      credit: "Ada Example",
      license: "CC BY 4.0",
      sourceUrl: "https://example.com/a",
      licenseExpires: "2030-01-01",
    });
  });

  it("turns a picture as the Owner, and Undo puts its old bytes back; shrinks stored pictures after asking (v0.13.0)", async () => {
    const { adapter, source } = setup();
    const form = {
      intent: "upload",
      resize: "no",
      alt: "A test picture",
      file: new File([png(4000, 3000) as Uint8Array<ArrayBuffer>], "big.png", {
        type: "image/png",
      }),
    };
    await runMediaIntent(source, form);
    const [id] = [...adapter.mediaStore.keys()];
    const at = () => adapter.mediaStore.get(id!)!.item;
    expect(at()).toMatchObject({ width: 4000, height: 3000 });
    expect(
      await runMediaIntent(
        { ...source, can: EDITOR },
        { intent: "transform", ids: [id!], versions: [at().version!], op: "rotate-90" },
      ),
    ).toEqual({ ok: false, message: "Changing a file's picture is the Owner's step." });
    const turned = await runMediaIntent(source, {
      intent: "transform",
      ids: [id!],
      versions: [at().version!],
      op: "rotate-90",
    });
    expect(turned).toMatchObject({ ok: true, undo: { intent: "revert" } });
    expect(at()).toMatchObject({ width: 3000, height: 4000 });
    expect(
      await runMediaIntent(source, { intent: turned.undo!.intent, ...turned.undo!.fields }),
    ).toMatchObject({ ok: true, undo: { intent: "revert" } });
    expect(at()).toMatchObject({ width: 4000, height: 3000 });
    expect(
      (await loadMedia(source, { inspect: id! })).detail?.history?.map((r) => r.reason),
    ).toEqual(["revert", "transform", "upload"]);

    const ask = await runMediaIntent(source, {
      intent: "resize",
      ids: [id!],
      versions: [at().version!],
    });
    expect(ask.confirm).toMatchObject({ typeToConfirm: "1", items: [id] });
    expect(at().width).toBe(4000);
    expect(
      await runMediaIntent(source, { ...ask.confirm!.fields, intent: "resize", confirm: "1" }),
    ).toMatchObject({ ok: true, outcomes: [{ ok: true, message: "Shrunk to 2048x1536." }] });
  });

  it("shows the model's suggestions only when asked, less what the file has, and polls for what others changed (v0.13.0)", async () => {
    const { adapter, client, source } = setup();
    const a = await client.media.upload({
      bytes: png(10, 10),
      contentType: "image/png",
      filename: "river-dusk.png",
      alt: "A test picture",
      changeId: "u1",
    });
    await client.media.setTags(a.id, {
      tags: ["river"],
      expectedVersion: a.version!,
      changeId: "t1",
    });
    expect(
      readMediaQuery(
        new URLSearchParams(`inspect=${a.id}&suggest=1&orientation=square&kind=image`),
      ),
    ).toEqual({ inspect: a.id, suggest: true, orientation: "square", kind: "image" });
    const plain = await loadMedia(source, { inspect: a.id });
    expect(plain.detail?.suggestions).toBeUndefined();
    // Rows and the inspected file say which way the picture lies, by the package's orientationOf (v0.13.1).
    expect([plain.rows[0]?.orientation, plain.detail?.orientation]).toEqual(["square", "square"]);
    expect((await loadMedia(source, { inspect: a.id, suggest: true })).detail?.suggestions).toEqual(
      { tags: ["dusk"], alt: "A picture of river dusk.", model: "memory-suggester" },
    );

    // Someone else, in another admin, changes the file after this page loaded.
    const other = localClient(adapter, { log: () => {} });
    await other.media.setAlt(a.id, {
      alt: "The river at dusk",
      expectedVersion: adapter.mediaStore.get(a.id)!.item.version!,
      changeId: "o1",
    });
    const changes = await loadMediaChanges(source, plain.page.changeCursor!);
    expect(changes).toMatchObject({
      rows: [{ id: a.id, alt: "The river at dusk", src: `https://memory.example/media/${a.id}` }],
      removed: [],
      more: false,
    });
    expect(await loadMediaChanges(source, "999")).toEqual({ reload: true });
  });

  it("refuses what the site does not offer, before asking it", async () => {
    const { client, source } = setup({ mediaWrites: false });
    const a = await upload(client, "a.png");
    expect(await runMediaIntent(source, { intent: "trash", ids: [a.id], versions: ["x"] })).toEqual(
      { ok: false, message: "This site does not offer that." },
    );
  });
});
