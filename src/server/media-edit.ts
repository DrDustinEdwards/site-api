// The media routes that change one file, and the bulk and trash routes.

import { mediaType, jsonResponse } from "@dustinedwards/site-runtime/http";
import { focusOf } from "@dustinedwards/site-runtime/image";

import { NotFoundError, RefusedError, type MediaAdapter } from "../adapter.js";
import {
  MAX_TRASH_EMPTY,
  MediaAltInput,
  MediaBulkInput,
  MediaBulkResult,
  MediaCaptionInput,
  MediaCreditInput,
  MediaFocusInput,
  MediaHistory,
  MediaReplaceQuery,
  MediaReplaceResult,
  MediaResizePassInput,
  MediaResizePassResult,
  MediaRevertInput,
  MediaSuggestions,
  MediaTagsInput,
  MediaTransformInput,
  MediaTransformResult,
  MediaTrashEmptyInput,
  MediaTrashEmptyResult,
  MediaTrashInput,
  MediaWriteResult,
  type MediaBulkOutcome,
  type MediaResizeOutcome,
  type MediaUse,
} from "../contract.js";
import { checkUpload, kindOf, readUpload, turnsSize } from "../media.js";
import { stripMetadata } from "../media-upload.js";
import {
  BASE_HEADERS,
  BadRequest,
  ContractBreach,
  ID,
  checked,
  describeFailure,
  notImplemented,
  readBody,
  readQuery,
  type Log,
  type Route,
} from "./http.js";

import {
  TRASH_PAGE,
  bulkLacking,
  bulkOne,
  checkAlt,
  failedOutcome,
  keepsProportions,
  mediaId,
  suggestionOf,
  type mediaBytes,
} from "./media-parts.js";

export function mediaEditRoutes(
  media: MediaAdapter,
  log: Log,
  { held }: ReturnType<typeof mediaBytes>,
): Route[] {
  return [
    // v0.4.0 writes. A site whose adapter lacks the method answers 501 whatever the body says.
    {
      method: "PUT",
      pattern: new RegExp(`^/media/${ID}/alt$`),
      run: async (m, _u, request) => {
        const id = mediaId(m);
        if (!media.setAlt)
          return notImplemented("This site does not edit alt text through the API.");
        const input = await readBody(request, MediaAltInput);
        const decorative = input.decorative === true;
        // An alt that may be the file's own name is checked against it; a decorative choice needs no read.
        checkAlt(
          input.alt,
          decorative,
          decorative ? null : ((await media.get(id))?.filename ?? null),
        );
        const result = await media.setAlt(id, { ...input, alt: input.alt.trim(), decorative });
        return jsonResponse(
          checked(
            MediaWriteResult,
            { id, version: result.version, changeId: input.changeId },
            "media alt",
          ),
          200,
          BASE_HEADERS,
        );
      },
    },
    {
      method: "PUT",
      pattern: new RegExp(`^/media/${ID}/tags$`),
      run: async (m, _u, request) => {
        const id = mediaId(m);
        if (!media.setTags) return notImplemented("This site does not keep media tags.");
        const input = await readBody(request, MediaTagsInput);
        const result = await media.setTags(id, { ...input, tags: [...new Set(input.tags)].sort() });
        return jsonResponse(
          checked(
            MediaWriteResult,
            { id, version: result.version, changeId: input.changeId },
            "media tags",
          ),
          200,
          BASE_HEADERS,
        );
      },
    },
    // v0.10.0, each 501 where the adapter lacks it.
    {
      method: "PUT",
      pattern: new RegExp(`^/media/${ID}/focus$`),
      run: async (m, _u, request) => {
        const id = mediaId(m);
        if (!media.setFocus)
          return notImplemented("This site does not keep a focal point on files.");
        const input = await readBody(request, MediaFocusInput);
        // In the one spelling site-runtime's ./image writes into a crop's URL, so the stored point and the URL agree.
        const focus = input.focus === null ? null : focusOf(input.focus);
        const result = await media.setFocus(id, { ...input, focus });
        return jsonResponse(
          checked(
            MediaWriteResult,
            { id, version: result.version, changeId: input.changeId },
            "media focus",
          ),
          200,
          BASE_HEADERS,
        );
      },
    },
    {
      method: "PUT",
      pattern: new RegExp(`^/media/${ID}/caption$`),
      run: async (m, _u, request) => {
        const id = mediaId(m);
        if (!media.setCaption) return notImplemented("This site does not keep captions on files.");
        const input = await readBody(request, MediaCaptionInput);
        const result = await media.setCaption(id, input);
        return jsonResponse(
          checked(
            MediaWriteResult,
            { id, version: result.version, changeId: input.changeId },
            "media caption",
          ),
          200,
          BASE_HEADERS,
        );
      },
    },
    {
      method: "PUT",
      query: true,
      pattern: new RegExp(`^/media/${ID}/file$`),
      run: async (m, url, request) => {
        const id = mediaId(m);
        if (!media.replace) return notImplemented("This site does not replace files.");
        const query = readQuery(url, MediaReplaceQuery);
        const contentType = mediaType(request.headers.get("content-type"));
        // As an upload: a type the site does not accept is refused unread.
        const wrongType = checkUpload(contentType, null, media.limits);
        if (wrongType) throw new BadRequest(wrongType.code, wrongType.message);
        const current = await held(id, query.expectedVersion, "replaced");
        // The address names the type (photo.png), so a file of another type would be served under a name that lies.
        if (mediaType(current.contentType) !== contentType) {
          throw new BadRequest(
            "invalid",
            `This file is ${current.contentType}, and the replacement is ${contentType}. A replacement keeps the address, so it must be the same type; upload it as a new file instead.`,
          );
        }
        const read = await readUpload(request, media.limits);
        if (!read.ok) throw new BadRequest(read.refusal.code, read.refusal.message);
        const wrongBytes = checkUpload(contentType, read.bytes, media.limits);
        if (wrongBytes) throw new BadRequest(wrongBytes.code, wrongBytes.message);
        const { item, sizesNeedPurge } = await media.replace(id, {
          // A replacement's private metadata goes before the site sees it, as an upload's does in prepareUpload (v0.19.0).
          bytes: stripMetadata(read.bytes, contentType),
          contentType,
          filename: query.filename,
          expectedVersion: query.expectedVersion,
          changeId: query.changeId,
        });
        // Every page that uses the file links this id and address; a site that moved either broke them.
        if (item.id !== id || item.url !== current.url)
          throw new ContractBreach(
            `replace moved ${id} to ${item.id} at ${item.url}; a replace keeps the id and the address`,
          );
        return jsonResponse(
          checked(
            MediaReplaceResult,
            { ...item, changeId: query.changeId, sizesNeedPurge },
            "media replace",
          ),
          200,
          BASE_HEADERS,
        );
      },
    },
    // v0.13.0, each 501 where the adapter lacks it.
    {
      method: "PUT",
      pattern: new RegExp(`^/media/${ID}/credit$`),
      run: async (m, _u, request) => {
        const id = mediaId(m);
        if (!media.setCredit)
          return notImplemented("This site does not keep credit and license on files.");
        const input = await readBody(request, MediaCreditInput);
        const result = await media.setCredit(id, {
          ...input,
          credit: input.credit.trim(),
          license: input.license.trim(),
          ...(input.copyright !== undefined ? { copyright: input.copyright.trim() } : {}),
        });
        return jsonResponse(
          checked(
            MediaWriteResult,
            { id, version: result.version, changeId: input.changeId },
            "media credit",
          ),
          200,
          BASE_HEADERS,
        );
      },
    },
    {
      method: "POST",
      pattern: new RegExp(`^/media/${ID}/transform$`),
      run: async (m, _u, request) => {
        const id = mediaId(m);
        if (!media.transform) return notImplemented("This site does not turn or mirror pictures.");
        const input = await readBody(request, MediaTransformInput);
        const current = await held(id, input.expectedVersion, "turned");
        if (kindOf(current.contentType) !== "image")
          throw new RefusedError("Only a picture turns or mirrors.");
        // A quarter turn swaps the width and height. Where the site's addresses carry the size, that is a new file, and the
        // pages that use the old one keep it; a square picture keeps its size and turns in place.
        const square = current.width !== null && current.width === current.height;
        const asNewFile = Boolean(media.replaceKeepsSize) && turnsSize(input.op) && !square;
        const { item, sizesNeedPurge } = await media.transform(id, { ...input, asNewFile });
        if (asNewFile ? item.id === id : item.id !== id || item.url !== current.url) {
          throw new ContractBreach(
            `transform of ${id} answered ${item.id} at ${item.url}; ${asNewFile ? "a new file has a new id" : "in place keeps the id and the address"}`,
          );
        }
        return jsonResponse(
          checked(
            MediaTransformResult,
            { ...item, changeId: input.changeId, sizesNeedPurge, asNewFile },
            "media transform",
          ),
          200,
          BASE_HEADERS,
        );
      },
    },
    {
      method: "GET",
      pattern: new RegExp(`^/media/${ID}/history$`),
      run: async (m) => {
        const id = mediaId(m);
        if (!media.history || !media.revert)
          return notImplemented("This site does not keep a file's earlier versions.");
        const revisions = await media.history(id);
        if (!revisions) throw new NotFoundError("No such media.");
        return jsonResponse(
          checked(MediaHistory, { id, revisions }, "media history"),
          200,
          BASE_HEADERS,
        );
      },
    },
    {
      method: "POST",
      pattern: new RegExp(`^/media/${ID}/revert$`),
      run: async (m, _u, request) => {
        const id = mediaId(m);
        if (!media.history || !media.revert)
          return notImplemented("This site does not keep a file's earlier versions.");
        const input = await readBody(request, MediaRevertInput);
        const current = await held(id, input.expectedVersion, "reverted");
        const target = (await media.history(id))?.find((r) => r.rev === input.to);
        if (!target) throw new NotFoundError("This file has no such earlier version.");
        if (target.current) throw new RefusedError("Those are already the file's bytes.");
        if (
          media.replaceKeepsSize &&
          (target.width !== current.width || target.height !== current.height)
        ) {
          throw new RefusedError(
            "That version is another size, and this site's addresses carry the size. Download it and upload it as a new file instead.",
          );
        }
        const { item, sizesNeedPurge } = await media.revert(id, input);
        if (item.id !== id || item.url !== current.url)
          throw new ContractBreach(
            `revert moved ${id} to ${item.id} at ${item.url}; a revert keeps the id and the address`,
          );
        return jsonResponse(
          checked(
            MediaTransformResult,
            { ...item, changeId: input.changeId, sizesNeedPurge, asNewFile: false },
            "media revert",
          ),
          200,
          BASE_HEADERS,
        );
      },
    },
    {
      method: "GET",
      pattern: new RegExp(`^/media/${ID}/suggestions$`),
      run: async (m) => {
        const id = mediaId(m);
        if (!media.suggest) return notImplemented("This site does not suggest tags or alt text.");
        const found = await media.suggest(id);
        if (!found) throw new NotFoundError("No such media.");
        return jsonResponse(
          checked(MediaSuggestions, { id, ...suggestionOf(found) }, "media suggestions"),
          200,
          BASE_HEADERS,
        );
      },
    },
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
            // v0.22.0: where a replace keeps the size, pages hold each picture's width and height, so a shrink may only make
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
              // Nothing gone yet: fail as before. Otherwise stop here and say what is already gone, so a retry
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
