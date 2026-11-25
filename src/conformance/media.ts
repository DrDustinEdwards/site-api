import {
  MEDIA_LENSES,
  MediaBulkResult,
  MediaDeleteResult,
  MediaDetail,
  MediaItem,
  MediaList,
  PREFIX,
} from "../contract.js";
import type { ConformanceContext } from "./context.js";
import { MEDIA_PROBE_ID, PROBE_TYPE, PROBE_PNG, STALE_VERSION } from "./context.js";

// The media group: only for a site that offers it.
export async function mediaChecks(ctx: ConformanceContext): Promise<void> {
  const { config, doFetch, origin, auth, capabilities, check, probe, errorCode, expectStatus } =
    ctx;

  if (capabilities?.media) {
    await check("media: upload limits declared", async () => {
      const limits = capabilities.mediaUpload;
      if (!limits) throw new Error("capabilities.media is true but mediaUpload is missing");
      return `${limits.maxBytes} bytes, ${limits.types.join(", ")}`;
    });

    await check("media list: answers in the contract's shape", async () => {
      const response = await doFetch(`${origin}${PREFIX}/media?limit=1`, { headers: auth });
      expectStatus(response, 200, "media list");
      const list = MediaList.parse(await response.json());
      return `${list.items.length} file(s) on the first page`;
    });

    // v0.6.0 lenses: every one the site names answers in shape; one it does not name answers 501.
    await check(
      "media lenses: each one the site names answers, and one it does not is not implemented",
      async () => {
        const named = capabilities.mediaLenses ?? [];
        for (const lens of MEDIA_LENSES) {
          const response = await doFetch(`${origin}${PREFIX}/media?lens=${lens}&limit=1`, {
            headers: auth,
          });
          if (named.includes(lens)) {
            expectStatus(response, 200, `media lens ${lens}`);
            MediaList.parse(await response.json());
          } else {
            expectStatus(response, 501, `media lens ${lens} on a site that does not name it`);
          }
        }
        return named.length > 0 ? `answers ${named.join(", ")}` : "501 for every lens";
      },
    );

    if (config.probeWrites !== false) {
      await check("media delete of an unknown id: refused", async () => {
        const response = await doFetch(
          `${origin}${PREFIX}/media/${encodeURIComponent(MEDIA_PROBE_ID)}?changeId=${probe()}`,
          { method: "DELETE", headers: auth },
        );
        expectStatus(response, 404, "unknown media delete");
        const code = await errorCode(response);
        if (code !== "not-found")
          throw new Error(`error code ${code ?? "missing"}, expected not-found`);
        return "404 not-found";
      });

      await check("media upload of a type the site does not accept: refused", async () => {
        const response = await doFetch(
          `${origin}${PREFIX}/media?filename=carrel-conformance-probe.bin&alt=Conformance%20probe&changeId=${probe()}`,
          {
            method: "POST",
            headers: { ...auth, "content-type": PROBE_TYPE },
            body: "A conforming site refuses this upload.",
          },
        );
        expectStatus(response, 400, "disallowed upload");
        const code = await errorCode(response);
        if (code !== "invalid")
          throw new Error(`error code ${code ?? "missing"}, expected invalid`);
        return "400 invalid";
      });

      // v0.4.0 writes. Each is optional: where the site declares the capability, the probe is refused as
      // a real error; where it does not, the same request must answer 501. Nothing here can change a file.
      const probeId = encodeURIComponent(MEDIA_PROBE_ID);
      const send = (method: string, path: string, body: unknown) =>
        doFetch(`${origin}${PREFIX}${path}`, {
          method,
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const stale = { expectedVersion: STALE_VERSION, changeId: probe() };

      async function refusedOrAbsent(
        offered: boolean,
        response: Response,
        status: number,
        code: string,
        what: string,
      ) {
        if (!offered) {
          expectStatus(response, 501, `${what} without the capability`);
          const got = await errorCode(response);
          if (got !== "not-implemented")
            throw new Error(`error code ${got ?? "missing"}, expected not-implemented`);
          return "501 not-implemented";
        }
        expectStatus(response, status, what);
        const got = await errorCode(response);
        if (got !== code) throw new Error(`error code ${got ?? "missing"}, expected ${code}`);
        return `${status} ${code}`;
      }

      const writes: Array<[string, boolean | undefined, string, string, unknown]> = [
        ["alt", capabilities.mediaAlt, "PUT", "alt", { alt: "probe", ...stale }],
        ["tags", capabilities.mediaTags, "PUT", "tags", { tags: ["probe"], ...stale }],
        ["trash", capabilities.mediaTrash, "POST", "trash", stale],
        ["restore", capabilities.mediaTrash, "POST", "restore", stale],
        ["focus", capabilities.mediaFocus, "PUT", "focus", { focus: "0.5x0.5", ...stale }],
        ["caption", capabilities.mediaCaption, "PUT", "caption", { caption: "probe", ...stale }],
        // v0.13.0
        [
          "credit",
          capabilities.mediaCredit,
          "PUT",
          "credit",
          { credit: "probe", license: "", sourceUrl: null, licenseExpires: null, ...stale },
        ],
        ["transform", capabilities.mediaTransform, "POST", "transform", { op: "flip-h", ...stale }],
        ["revert", capabilities.mediaHistory, "POST", "revert", { to: "probe", ...stale }],
      ];
      for (const [name, offered, method, route, body] of writes) {
        await check(
          `media ${name} of an unknown id: refused, or not implemented where the site lacks it`,
          async () =>
            refusedOrAbsent(
              Boolean(offered),
              await send(method, `/media/${probeId}/${route}`, body),
              404,
              "not-found",
              `media ${name}`,
            ),
        );
      }

      // v0.13.0 reads of the probe id: a site answers 404 before it would ask its model anything.
      const reads: Array<[string, boolean | undefined, string]> = [
        ["history", capabilities.mediaHistory, "history"],
        ["suggestions", capabilities.mediaSuggestions, "suggestions"],
      ];
      for (const [name, offered, route] of reads) {
        await check(
          `media ${name} of an unknown id: refused, or not implemented where the site lacks it`,
          async () =>
            refusedOrAbsent(
              Boolean(offered),
              await doFetch(`${origin}${PREFIX}/media/${probeId}/${route}`, { headers: auth }),
              404,
              "not-found",
              `media ${name}`,
            ),
        );
      }

      // An import of an http address is refused before anything is fetched.
      await check(
        "media import of an http address: refused, or not implemented where the site lacks it",
        async () =>
          refusedOrAbsent(
            Boolean(capabilities.mediaImport),
            await send("POST", "/media/import", {
              url: "http://example.com/a.png",
              changeId: probe(),
            }),
            400,
            "invalid",
            "media import over http",
          ),
      );

      await check(
        "media alt with a body outside the contract: refused, or not implemented where the site lacks it",
        async () =>
          refusedOrAbsent(
            Boolean(capabilities.mediaAlt),
            await send("PUT", `/media/${probeId}/alt`, { alt: 7 }),
            400,
            "invalid",
            "malformed alt",
          ),
      );

      await check(
        "media focus outside 0 to 1: refused, or not implemented where the site lacks it",
        async () =>
          refusedOrAbsent(
            Boolean(capabilities.mediaFocus),
            await send("PUT", `/media/${probeId}/focus`, { focus: "2x2", ...stale }),
            400,
            "invalid",
            "focus outside the picture",
          ),
      );

      // v0.10.0: a replace of the probe id, in a type the site accepts, is a 404 before any byte is read.
      await check(
        "media replace of an unknown id: refused, or not implemented where the site lacks it",
        async () => {
          const type = capabilities.mediaUpload?.types[0] ?? "image/png";
          const response = await doFetch(
            `${origin}${PREFIX}/media/${probeId}/file?filename=probe&expectedVersion=${STALE_VERSION}&changeId=${probe()}`,
            {
              method: "PUT",
              headers: { ...auth, "content-type": type },
              body: new Uint8Array([0]),
            },
          );
          return refusedOrAbsent(
            Boolean(capabilities.mediaReplace),
            response,
            404,
            "not-found",
            "media replace",
          );
        },
      );

      await check(
        "media bulk: an unknown id is that file's own not-found, and the request answers 200",
        async () => {
          const response = await send("POST", "/media/bulk", {
            op: "trash",
            items: [{ id: MEDIA_PROBE_ID, ...stale }],
          });
          if (!capabilities.mediaTrash)
            return refusedOrAbsent(false, response, 200, "", "media bulk trash");
          expectStatus(response, 200, "media bulk");
          const result = MediaBulkResult.parse(await response.json());
          const only = result.results[0];
          if (result.results.length !== 1 || !only || only.ok || only.error !== "not-found") {
            throw new Error(
              `expected one failed not-found outcome, got ${JSON.stringify(result.results)}`,
            );
          }
          return "200, not-found for the file";
        },
      );

      await check(
        "media bulk tag op with no tags: refused, or not implemented where the site lacks tags",
        async () =>
          refusedOrAbsent(
            Boolean(capabilities.mediaTags),
            await send("POST", "/media/bulk", {
              op: "add-tags",
              items: [{ id: MEDIA_PROBE_ID, ...stale }],
            }),
            400,
            "invalid",
            "bulk add-tags without tags",
          ),
      );

      // Empty-trash deletes real files, so only its refusal of a malformed body is probed.
      await check(
        "media empty trash with a body outside the contract: refused, or not implemented where the site has no trash",
        async () =>
          refusedOrAbsent(
            Boolean(capabilities.mediaTrash),
            await send("POST", "/media/trash/empty", {}),
            400,
            "invalid",
            "malformed empty trash",
          ),
      );
    }

    if (config.probeMediaUpload && capabilities.mediaUpload?.types.includes("image/png")) {
      await check("media round trip: upload, read, delete its own file", async () => {
        const up = await doFetch(
          `${origin}${PREFIX}/media?filename=carrel-conformance-probe.png&alt=Conformance%20probe&changeId=${probe()}`,
          {
            method: "POST",
            headers: { ...auth, "content-type": "image/png" },
            body: new Blob([PROBE_PNG]),
          },
        );
        expectStatus(up, 201, "upload");
        const item = MediaItem.parse(await up.json());
        const path = `${origin}${PREFIX}/media/${encodeURIComponent(item.id)}`;
        const read = await doFetch(path, { headers: auth });
        expectStatus(read, 200, "read back");
        const detail = MediaDetail.parse(await read.json());
        if (detail.usedBy.length > 0)
          throw new Error(`its own new file is reported in use: ${JSON.stringify(detail.usedBy)}`);
        // Only the id the site just gave this upload: never any other file.
        const del = await doFetch(`${path}?changeId=${probe()}`, {
          method: "DELETE",
          headers: auth,
        });
        expectStatus(del, 200, "delete");
        MediaDeleteResult.parse(await del.json());
        expectStatus(await doFetch(path, { headers: auth }), 404, "after delete");
        return `uploaded and deleted ${item.id}`;
      });
    }
  }
}
