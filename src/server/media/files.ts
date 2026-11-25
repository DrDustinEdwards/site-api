import { mediaType, jsonResponse } from "@dustinedwards/site-runtime/http";

import { NotFoundError, RefusedError } from "../../adapter.js";
import {
  MediaCreditInput,
  MediaHistory,
  MediaReplaceQuery,
  MediaReplaceResult,
  MediaRevertInput,
  MediaSuggestions,
  MediaTransformInput,
  MediaTransformResult,
  MediaWriteResult,
} from "../../contract.js";
import { checkUpload, kindOf, readUpload, turnsSize } from "../../media.js";
import { stripMetadata } from "../../media-upload.js";
import {
  BASE_HEADERS,
  BadRequest,
  ContractBreach,
  ID,
  checked,
  notImplemented,
  readBody,
  readQuery,
  type Route,
} from "../http.js";
import { suggestionOf } from "./helpers.js";
import type { MediaRouteContext } from "./helpers.js";

export function fileRoutes(ctx: MediaRouteContext): Route[] {
  const { media, mediaId, held } = ctx;
  return [
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
          // A replacement's private metadata goes before the site sees it, as an upload's does in prepareUpload.
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
    // Each 501 where the adapter lacks it.
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
  ];
}
