import { jsonResponse } from "@dustinedwards/site-runtime/http";

import {
  MAX_TRASH_EMPTY,
  MediaBulkInput,
  MediaBulkResult,
  MediaResizePassInput,
  MediaResizePassResult,
  MediaTrashEmptyInput,
  MediaTrashEmptyResult,
  MediaTrashInput,
  MediaWriteResult,
  type MediaBulkOutcome,
  type MediaResizeOutcome,
  type MediaUse,
} from "../../contract.js";
import {
  BASE_HEADERS,
  BadRequest,
  ContractBreach,
  ID,
  checked,
  describeFailure,
  notImplemented,
  readBody,
  type Route,
} from "../http.js";
import { failedOutcome, bulkLacking, bulkOne, keepsProportions } from "./helpers.js";
import type { MediaRouteContext } from "./helpers.js";

/** How many trashed files one page of the empty-trash gather asks the site for. */
const TRASH_PAGE = 200;

export function bulkRoutes(ctx: MediaRouteContext): Route[] {
  const { media, log, mediaId, held } = ctx;
  return [
    {
      method: "POST",
      pattern: /^\/media\/resize-pass$/,
      run: async (_m, _u, request) => {
        if (!media.resize || !media.shrink)
          return notImplemented("This site does not shrink stored pictures.");
        const input = await readBody(request, MediaResizePassInput);
        const results: MediaResizeOutcome[] = [];
        // One at a time, like bulk: image work is slow, and one file's refusal is that file's outcome alone.
        for (const { id, expectedVersion, changeId } of input.items) {
          try {
            // Where a replace keeps the size, pages hold each picture's width and height, so a shrink may only make
            // the picture smaller in the same proportions (the boxes those pages drew still fit it). A site whose addresses
            // carry the size leaves `shrink` out altogether.
            const before = media.replaceKeepsSize
              ? await held(id, expectedVersion, "shrunk")
              : null;
            const { resized, item } = await media.shrink(id, { expectedVersion, changeId });
            if (item.id !== id) throw new ContractBreach(`shrink moved ${id} to ${item.id}`);
            if (before && resized && !keepsProportions(before, item)) {
              throw new ContractBreach(
                `shrink of ${id} went from ${before.width}x${before.height} to ${item.width}x${item.height}; on a site whose replace keeps the size a shrink only makes a picture smaller, in the same proportions`,
              );
            }
            results.push({
              ok: true,
              id,
              changeId,
              resized,
              ...(item.version ? { version: item.version } : {}),
              width: item.width,
              height: item.height,
              bytes: item.bytes,
            });
          } catch (error) {
            results.push({ ...failedOutcome(error, log), id, changeId });
          }
        }
        return jsonResponse(
          checked(MediaResizePassResult, { results }, "media resize pass"),
          200,
          BASE_HEADERS,
        );
      },
    },
    ...(["trash", "restore"] as const).map((action): Route => ({
      method: "POST",
      pattern: new RegExp(`^/media/${ID}/${action}$`),
      run: async (m, _u, request) => {
        const id = mediaId(m);
        if (!media.trash || !media.restore) return notImplemented("This site has no media trash.");
        const input = await readBody(request, MediaTrashInput);
        const result = await (action === "trash"
          ? media.trash(id, input)
          : media.restore(id, input));
        return jsonResponse(
          checked(
            MediaWriteResult,
            { id, version: result.version, changeId: input.changeId },
            `media ${action}`,
          ),
          200,
          BASE_HEADERS,
        );
      },
    })),
    {
      method: "POST",
      pattern: /^\/media\/trash\/empty$/,
      run: async (_m, _u, request) => {
        if (!media.trash || !media.restore) return notImplemented("This site has no media trash.");
        const input = await readBody(request, MediaTrashEmptyInput);
        // Gather first, then delete: a cursor into a list that is shrinking would skip files.
        const ids: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await media.list({
            trashed: "only",
            limit: TRASH_PAGE,
            ...(cursor ? { cursor } : {}),
          });
          for (const item of page.items) if (item.trashedAt) ids.push(item.id);
          cursor = page.nextCursor ?? undefined;
        } while (cursor && ids.length <= MAX_TRASH_EMPTY);
        let more = ids.length > MAX_TRASH_EMPTY;
        const deleted: string[] = [];
        const refused: Array<{ id: string; message: string; usedBy?: MediaUse[] }> = [];
        for (const [n, id] of ids.slice(0, MAX_TRASH_EMPTY).entries()) {
          try {
            await media.delete(id, { changeId: `${input.changeId}-${n + 1}` });
            deleted.push(id);
          } catch (error) {
            const failure = describeFailure(error, log);
            if (failure.code !== "refused" && failure.code !== "not-found") {
              // Nothing gone yet: fail. Otherwise stop here and say what is already gone, so a retry
              // knows where it stands.
              if (deleted.length === 0) throw error;
              refused.push({ id, message: failure.message });
              more = true;
              break;
            }
            refused.push({
              id,
              message: failure.message,
              ...(failure.usedBy ? { usedBy: failure.usedBy } : {}),
            });
          }
        }
        return jsonResponse(
          checked(
            MediaTrashEmptyResult,
            { changeId: input.changeId, deleted, refused, more },
            "media trash empty",
          ),
          200,
          BASE_HEADERS,
        );
      },
    },
    {
      method: "POST",
      pattern: /^\/media\/bulk$/,
      run: async (_m, _u, request) => {
        const input = await readBody(request, MediaBulkInput);
        const lacking = bulkLacking(media, input.op);
        if (lacking) return notImplemented(lacking);
        if (
          (input.op === "add-tags" || input.op === "remove-tags") &&
          (!input.tags || input.tags.length === 0)
        ) {
          throw new BadRequest("invalid", "tags: name at least one tag.");
        }
        const results: MediaBulkOutcome[] = [];
        // One at a time, in order: a site's index and cache purge are not built for a burst, and one
        // file's refusal (a stale version, a file in use) is that file's outcome and nothing more.
        for (const item of input.items) {
          results.push(await bulkOne(media, input.op, input.tags ?? [], item, log));
        }
        return jsonResponse(
          checked(MediaBulkResult, { op: input.op, results }, "media bulk"),
          200,
          BASE_HEADERS,
        );
      },
    },
  ];
}
