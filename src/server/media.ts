// The media routes (v0.2.0, writes v0.4.0, focal point, caption and replace v0.10.0, the media library's ideas
// v0.13.0), mounted only when the site's adapter has media.

import { mediaType, jsonResponse } from "@dustinedwards/site-runtime/http";

import { NotFoundError, type MediaAdapter } from "../adapter.js";
import {
  MediaDeleteQuery,
  MediaDeleteResult,
  MediaDetail,
  MediaFileSuggestQuery,
  MediaFileSuggestions,
  MediaImportInput,
  MediaList,
  MediaListQuery,
  MediaUploadQuery,
} from "../contract.js";
import { checkUpload, kindOf } from "../media.js";
import type { SiteApiStore } from "../store.js";
import {
  BASE_HEADERS,
  BadRequest,
  ContractBreach,
  ID,
  checked,
  notImplemented,
  readBody,
  readQuery,
  type Log,
  type Route,
} from "./http.js";

import { checkAlt, mediaBytes, mediaId, nameOf, suggestionOf } from "./media-parts.js";
import { mediaEditRoutes } from "./media-edit.js";

export function mediaRoutes(
  media: MediaAdapter,
  log: Log,
  siteStore?: Pick<SiteApiStore, "uploadedMedia" | "putUploadedMedia">,
): Route[] {
  const bytes = mediaBytes(media, log, siteStore);
  const { uploaded, imported, store, changesSince } = bytes;

  return [
    {
      method: "GET",
      query: true,
      pattern: /^\/media$/,
      run: async (_m, url) => {
        const query = readQuery(url, MediaListQuery);
        if (query.changedSince !== undefined)
          return changesSince(query.changedSince, query.limit, url);
        if (query.lens && !(media.lenses ?? []).includes(query.lens))
          return notImplemented(`This site does not offer the ${query.lens} lens.`);
        if (query.sort === "used" && !media.usage)
          return notImplemented("This site does not count where its files are used.");
        if ((query.orientation || query.kind) && !media.filters)
          return notImplemented("This site does not filter files by orientation or kind.");
        const list = checked(MediaList, await media.list(query), "media list");
        // The first page is where a screen learns the point to poll from.
        if (media.changes && list.changeCursor === undefined)
          throw new ContractBreach(
            "media list: a site that answers changes gives changeCursor on every list",
          );
        return jsonResponse(list, 200, BASE_HEADERS);
      },
    },
    {
      method: "POST",
      query: true,
      pattern: /^\/media$/,
      run: async (_m, url, request) => {
        const query = readQuery(url, MediaUploadQuery);
        const contentType = mediaType(request.headers.get("content-type"));
        // The type first, so a file the site does not accept is never read at all; then the alt, before a byte is read.
        const wrongType = checkUpload(contentType, null, media.limits);
        if (wrongType) throw new BadRequest(wrongType.code, wrongType.message);
        const decorative = query.decorative === "yes";
        checkAlt(query.alt, decorative, query.filename, false);
        return store(await uploaded(request, contentType), contentType, {
          ...query,
          alt: decorative ? "" : (query.alt ?? "").trim(),
          decorative,
        });
      },
    },
    // v0.19.0: the model's alt text and tags for a file not yet stored, for the upload form to offer. Nothing is stored.
    {
      method: "POST",
      pattern: /^\/media\/suggestions$/,
      query: true,
      run: async (_m, url, request) => {
        if (!media.suggestFile)
          return notImplemented("This site does not suggest alt text before an upload.");
        const { url: address } = readQuery(url, MediaFileSuggestQuery);
        if (address && !media.importFetch)
          return notImplemented("This site does not import files from the web.");
        const file = address
          ? await imported(address)
          : { contentType: mediaType(request.headers.get("content-type")), bytes: null };
        const wrongType = checkUpload(file.contentType, null, media.limits);
        if (wrongType) throw new BadRequest(wrongType.code, wrongType.message);
        if (kindOf(file.contentType) !== "image")
          throw new BadRequest("invalid", "Only a picture has alt text to suggest.");
        const bytes = file.bytes ?? (await uploaded(request, file.contentType));
        const found = await media.suggestFile({ bytes, contentType: file.contentType });
        return jsonResponse(
          checked(MediaFileSuggestions, suggestionOf(found), "media file suggestions"),
          200,
          BASE_HEADERS,
        );
      },
    },
    // v0.13.0: the site's own copy of a file on the web, checked as an upload is.
    {
      method: "POST",
      pattern: /^\/media\/import$/,
      run: async (_m, _u, request) => {
        if (!media.importFetch)
          return notImplemented("This site does not import files from the web.");
        const input = await readBody(request, MediaImportInput);
        const decorative = input.decorative === true;
        checkAlt(input.alt, decorative, input.filename ?? nameOf(input.url), false);
        const { bytes, contentType, address } = await imported(input.url);
        return store(
          bytes,
          contentType,
          {
            ...input,
            filename: input.filename ?? nameOf(address),
            alt: decorative ? "" : (input.alt ?? "").trim(),
            decorative,
          },
          input.url,
        );
      },
    },
    {
      method: "GET",
      pattern: new RegExp(`^/media/${ID}$`),
      run: async (m) => {
        const item = await media.get(mediaId(m));
        if (!item) throw new NotFoundError("No such media.");
        return jsonResponse(checked(MediaDetail, item, "media"), 200, BASE_HEADERS);
      },
    },
    {
      method: "DELETE",
      query: true,
      pattern: new RegExp(`^/media/${ID}$`),
      run: async (m, url) => {
        const id = mediaId(m);
        const { changeId } = readQuery(url, MediaDeleteQuery);
        await media.delete(id, { changeId });
        return jsonResponse(
          checked(MediaDeleteResult, { id, deleted: true, changeId }, "media delete"),
          200,
          BASE_HEADERS,
        );
      },
    },
    ...mediaEditRoutes(media, log, bytes),
  ];
}
