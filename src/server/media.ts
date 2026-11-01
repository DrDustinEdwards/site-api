// The media routes (v0.2.0, writes v0.4.0, focal point, caption and replace v0.10.0, the media library's ideas
// v0.13.0), mounted only when the site's adapter has media.

import { focusOf } from "@dustinedwards/site-runtime/image";

import { MediaInUseError, NotFoundError, RefusedError, VersionConflictError, type MediaAdapter } from "../adapter.js";
import {
  MAX_TRASH_EMPTY,
  MediaAltInput,
  MediaBulkInput,
  MediaBulkResult,
  MediaCaptionInput,
  MediaCreditInput,
  MediaDeleteQuery,
  MediaDeleteResult,
  MediaDetail,
  MediaFileSuggestQuery,
  MediaFileSuggestions,
  MediaFocusInput,
  MediaHistory,
  MediaId,
  MediaImportInput,
  MediaList,
  MediaListQuery,
  MediaReplaceQuery,
  MediaReplaceResult,
  MediaResizePassInput,
  MediaResizePassResult,
  MediaRevertInput,
  MediaSuggestions,
  MediaTag,
  MediaTagsInput,
  MediaTransformInput,
  MediaTransformResult,
  MediaTrashEmptyInput,
  MediaTrashEmptyResult,
  MediaTrashInput,
  MediaUploadQuery,
  MediaUploadResult,
  MediaWriteResult,
  type MediaBulkOutcome,
  type MediaDetail as MediaDetailType,
  type MediaResizeOutcome,
  type MediaUse,
} from "../contract.js";
import { ImportRefusal, altRefusal, checkUpload, essence, fetchImport, importRefusal, kindOf, readUpload, turnsSize } from "../media.js";
import { duplicateKey, stripMetadata } from "../media-upload.js";
import type { SiteApiStore } from "../store.js";
import { BadRequest, ContractBreach, ID, checked, describeFailure, fail, json, pathParam, readBody, readQuery, type Log, type Route } from "./http.js";

/** How many trashed files one page of the empty-trash gather asks the site for. */
const TRASH_PAGE = 200;

export function mediaRoutes(media: MediaAdapter, log: Log, siteStore?: Pick<SiteApiStore, "uploadedMedia" | "putUploadedMedia">): Route[] {
  const mediaId = (m: RegExpMatchArray) => pathParam(m[1], MediaId, "media id");

  return [
    {
      method: "GET",
      pattern: /^\/media$/,
      run: async (_m, url) => {
        const query = readQuery(url, MediaListQuery);
        if (query.changedSince !== undefined) return changesSince(query.changedSince, query.limit, url);
        if (query.lens && !(media.lenses ?? []).includes(query.lens)) return fail("not-implemented", `This site does not offer the ${query.lens} lens.`);
        if (query.sort === "used" && !media.usage) return fail("not-implemented", "This site does not count where its files are used.");
        if ((query.orientation || query.kind) && !media.filters) return fail("not-implemented", "This site does not filter files by orientation or kind.");
        const list = checked(MediaList, await media.list(query), "media list");
        // The first page is where a screen learns the point to poll from.
        if (media.changes && list.changeCursor === undefined) throw new ContractBreach("media list: a site that answers changes gives changeCursor on every list");
        return json(200, list);
      },
    },
    {
      method: "POST",
      pattern: /^\/media$/,
      run: async (_m, url, request) => {
        const query = readQuery(url, MediaUploadQuery);
        const contentType = essence(request.headers.get("content-type"));
        // The type first, so a file the site does not accept is never read at all; then the alt, before a byte is read.
        const wrongType = checkUpload(contentType, null, media.limits);
        if (wrongType) throw new BadRequest(wrongType.code, wrongType.message);
        const decorative = query.decorative === "yes";
        checkAlt(query.alt, decorative, query.filename);
        return store(await uploaded(request, contentType), contentType, { ...query, alt: decorative ? "" : query.alt!.trim(), decorative });
      },
    },
    // v0.19.0: the model's alt text and tags for a file not yet stored, for the upload form to offer. Nothing is stored.
    {
      method: "POST",
      pattern: /^\/media\/suggestions$/,
      run: async (_m, url, request) => {
        if (!media.suggestFile) return fail("not-implemented", "This site does not suggest alt text before an upload.");
        const { url: address } = readQuery(url, MediaFileSuggestQuery);
        if (address && !media.importFetch) return fail("not-implemented", "This site does not import files from the web.");
        const file = address ? await imported(address) : { contentType: essence(request.headers.get("content-type")), bytes: null };
        const wrongType = checkUpload(file.contentType, null, media.limits);
        if (wrongType) throw new BadRequest(wrongType.code, wrongType.message);
        if (kindOf(file.contentType) !== "image") throw new BadRequest("invalid", "Only a picture has alt text to suggest.");
        const bytes = file.bytes ?? (await uploaded(request, file.contentType));
        const found = await media.suggestFile({ bytes, contentType: file.contentType });
        return json(200, checked(MediaFileSuggestions, suggestionOf(found), "media file suggestions"));
      },
    },
    // v0.13.0: the site's own copy of a file on the web, checked as an upload is.
    {
      method: "POST",
      pattern: /^\/media\/import$/,
      run: async (_m, _u, request) => {
        if (!media.importFetch) return fail("not-implemented", "This site does not import files from the web.");
        const input = await readBody(request, MediaImportInput);
        const decorative = input.decorative === true;
        checkAlt(input.alt, decorative, input.filename ?? nameOf(input.url));
        const { bytes, contentType, address } = await imported(input.url);
        return store(bytes, contentType, { ...input, filename: input.filename ?? nameOf(address), alt: decorative ? "" : input.alt!.trim(), decorative }, input.url);
      },
    },
    {
      method: "GET",
      pattern: new RegExp(`^/media/${ID}$`),
      run: async (m) => {
        const item = await media.get(mediaId(m));
        if (!item) throw new NotFoundError("No such media.");
        return json(200, checked(MediaDetail, item, "media"));
      },
    },
    {
      method: "DELETE",
      pattern: new RegExp(`^/media/${ID}$`),
      run: async (m, url) => {
        const id = mediaId(m);
        const { changeId } = readQuery(url, MediaDeleteQuery);
        await media.delete(id, { changeId });
        return json(200, checked(MediaDeleteResult, { id, deleted: true, changeId }, "media delete"));
      },
    },
    // v0.4.0 writes. A site whose adapter lacks the method answers 501 whatever the body says.
    {
      method: "PUT",
      pattern: new RegExp(`^/media/${ID}/alt$`),
      run: async (m, _u, request) => {
        const id = mediaId(m);
        if (!media.setAlt) return fail("not-implemented", "This site does not edit alt text through the API.");
        const input = await readBody(request, MediaAltInput);
        const decorative = input.decorative === true;
        // An alt that may be the file's own name is checked against it; a decorative choice needs no read.
        checkAlt(input.alt, decorative, decorative ? null : ((await media.get(id))?.filename ?? null));
        const result = await media.setAlt(id, { ...input, alt: input.alt.trim(), decorative });
        return json(200, checked(MediaWriteResult, { id, version: result.version, changeId: input.changeId }, "media alt"));
      },
    },
    {
      method: "PUT",
      pattern: new RegExp(`^/media/${ID}/tags$`),
      run: async (m, _u, request) => {
        const id = mediaId(m);
        if (!media.setTags) return fail("not-implemented", "This site does not keep media tags.");
        const input = await readBody(request, MediaTagsInput);
        const result = await media.setTags(id, { ...input, tags: [...new Set(input.tags)].sort() });
        return json(200, checked(MediaWriteResult, { id, version: result.version, changeId: input.changeId }, "media tags"));
      },
    },
    // v0.10.0, each 501 where the adapter lacks it.
    {
      method: "PUT",
      pattern: new RegExp(`^/media/${ID}/focus$`),
      run: async (m, _u, request) => {
        const id = mediaId(m);
        if (!media.setFocus) return fail("not-implemented", "This site does not keep a focal point on files.");
        const input = await readBody(request, MediaFocusInput);
        // In the one spelling site-runtime's ./image writes into a crop's URL, so the stored point and the URL agree.
        const focus = input.focus === null ? null : focusOf(input.focus);
        const result = await media.setFocus(id, { ...input, focus });
        return json(200, checked(MediaWriteResult, { id, version: result.version, changeId: input.changeId }, "media focus"));
      },
    },
    {
      method: "PUT",
      pattern: new RegExp(`^/media/${ID}/caption$`),
      run: async (m, _u, request) => {
        const id = mediaId(m);
        if (!media.setCaption) return fail("not-implemented", "This site does not keep captions on files.");
        const input = await readBody(request, MediaCaptionInput);
        const result = await media.setCaption(id, input);
        return json(200, checked(MediaWriteResult, { id, version: result.version, changeId: input.changeId }, "media caption"));
      },
    },
    {
      method: "PUT",
      pattern: new RegExp(`^/media/${ID}/file$`),
      run: async (m, url, request) => {
        const id = mediaId(m);
        if (!media.replace) return fail("not-implemented", "This site does not replace files.");
        const query = readQuery(url, MediaReplaceQuery);
        const contentType = essence(request.headers.get("content-type"));
        // As an upload: a type the site does not accept is refused unread.
        const wrongType = checkUpload(contentType, null, media.limits);
        if (wrongType) throw new BadRequest(wrongType.code, wrongType.message);
        const current = await held(id, query.expectedVersion, "replaced");
        // The address names the type (photo.png), so a file of another type would be served under a name that lies.
        if (essence(current.contentType) !== contentType) {
          throw new BadRequest("invalid", `This file is ${current.contentType}, and the replacement is ${contentType}. A replacement keeps the address, so it must be the same type; upload it as a new file instead.`);
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
        if (item.id !== id || item.url !== current.url) throw new ContractBreach(`replace moved ${id} to ${item.id} at ${item.url}; a replace keeps the id and the address`);
        return json(200, checked(MediaReplaceResult, { ...item, changeId: query.changeId, sizesNeedPurge }, "media replace"));
      },
    },
    // v0.13.0, each 501 where the adapter lacks it.
    {
      method: "PUT",
      pattern: new RegExp(`^/media/${ID}/credit$`),
      run: async (m, _u, request) => {
        const id = mediaId(m);
        if (!media.setCredit) return fail("not-implemented", "This site does not keep credit and license on files.");
        const input = await readBody(request, MediaCreditInput);
        const result = await media.setCredit(id, {
          ...input,
          credit: input.credit.trim(),
          license: input.license.trim(),
          ...(input.copyright !== undefined ? { copyright: input.copyright.trim() } : {}),
        });
        return json(200, checked(MediaWriteResult, { id, version: result.version, changeId: input.changeId }, "media credit"));
      },
    },
    {
      method: "POST",
      pattern: new RegExp(`^/media/${ID}/transform$`),
      run: async (m, _u, request) => {
        const id = mediaId(m);
        if (!media.transform) return fail("not-implemented", "This site does not turn or mirror pictures.");
        const input = await readBody(request, MediaTransformInput);
        const current = await held(id, input.expectedVersion, "turned");
        if (kindOf(current.contentType) !== "image") throw new RefusedError("Only a picture turns or mirrors.");
        // A quarter turn swaps the width and height. Where the site's addresses carry the size, that is a new file, and the
        // pages that use the old one keep it; a square picture keeps its size and turns in place.
        const square = current.width !== null && current.width === current.height;
        const asNewFile = Boolean(media.replaceKeepsSize) && turnsSize(input.op) && !square;
        const { item, sizesNeedPurge } = await media.transform(id, { ...input, asNewFile });
        if (asNewFile ? item.id === id : item.id !== id || item.url !== current.url) {
          throw new ContractBreach(`transform of ${id} answered ${item.id} at ${item.url}; ${asNewFile ? "a new file has a new id" : "in place keeps the id and the address"}`);
        }
        return json(200, checked(MediaTransformResult, { ...item, changeId: input.changeId, sizesNeedPurge, asNewFile }, "media transform"));
      },
    },
    {
      method: "GET",
      pattern: new RegExp(`^/media/${ID}/history$`),
      run: async (m) => {
        const id = mediaId(m);
        if (!media.history || !media.revert) return fail("not-implemented", "This site does not keep a file's earlier versions.");
        const revisions = await media.history(id);
        if (!revisions) throw new NotFoundError("No such media.");
        return json(200, checked(MediaHistory, { id, revisions }, "media history"));
      },
    },
    {
      method: "POST",
      pattern: new RegExp(`^/media/${ID}/revert$`),
      run: async (m, _u, request) => {
        const id = mediaId(m);
        if (!media.history || !media.revert) return fail("not-implemented", "This site does not keep a file's earlier versions.");
        const input = await readBody(request, MediaRevertInput);
        const current = await held(id, input.expectedVersion, "reverted");
        const target = (await media.history(id))?.find((r) => r.rev === input.to);
        if (!target) throw new NotFoundError("This file has no such earlier version.");
        if (target.current) throw new RefusedError("Those are already the file's bytes.");
        if (media.replaceKeepsSize && (target.width !== current.width || target.height !== current.height)) {
          throw new RefusedError("That version is another size, and this site's addresses carry the size. Download it and upload it as a new file instead.");
        }
        const { item, sizesNeedPurge } = await media.revert(id, input);
        if (item.id !== id || item.url !== current.url) throw new ContractBreach(`revert moved ${id} to ${item.id} at ${item.url}; a revert keeps the id and the address`);
        return json(200, checked(MediaTransformResult, { ...item, changeId: input.changeId, sizesNeedPurge, asNewFile: false }, "media revert"));
      },
    },
    {
      method: "GET",
      pattern: new RegExp(`^/media/${ID}/suggestions$`),
      run: async (m) => {
        const id = mediaId(m);
        if (!media.suggest) return fail("not-implemented", "This site does not suggest tags or alt text.");
        const found = await media.suggest(id);
        if (!found) throw new NotFoundError("No such media.");
        return json(200, checked(MediaSuggestions, { id, ...suggestionOf(found) }, "media suggestions"));
      },
    },
    {
      method: "POST",
      pattern: /^\/media\/resize-pass$/,
      run: async (_m, _u, request) => {
        if (!media.resize || !media.shrink) return fail("not-implemented", "This site does not shrink stored pictures.");
        if (media.replaceKeepsSize) return fail("not-implemented", "This site's addresses carry each picture's size, so a stored picture is never shrunk in place.");
        const input = await readBody(request, MediaResizePassInput);
        const results: MediaResizeOutcome[] = [];
        // One at a time, like bulk: image work is slow, and one file's refusal is that file's outcome alone.
        for (const { id, expectedVersion, changeId } of input.items) {
          try {
            const { resized, item } = await media.shrink(id, { expectedVersion, changeId });
            if (item.id !== id) throw new ContractBreach(`shrink moved ${id} to ${item.id}`);
            results.push({ ok: true, id, changeId, resized, ...(item.version ? { version: item.version } : {}), width: item.width, height: item.height, bytes: item.bytes });
          } catch (error) {
            results.push({ ...failedOutcome(error, log), id, changeId });
          }
        }
        return json(200, checked(MediaResizePassResult, { results }, "media resize pass"));
      },
    },
    {
      method: "POST",
      pattern: new RegExp(`^/media/${ID}/trash$`),
      run: async (m, _u, request) => {
        const id = mediaId(m);
        if (!media.trash || !media.restore) return fail("not-implemented", "This site has no media trash.");
        const input = await readBody(request, MediaTrashInput);
        const result = await media.trash(id, input);
        return json(200, checked(MediaWriteResult, { id, version: result.version, changeId: input.changeId }, "media trash"));
      },
    },
    {
      method: "POST",
      pattern: new RegExp(`^/media/${ID}/restore$`),
      run: async (m, _u, request) => {
        const id = mediaId(m);
        if (!media.trash || !media.restore) return fail("not-implemented", "This site has no media trash.");
        const input = await readBody(request, MediaTrashInput);
        const result = await media.restore(id, input);
        return json(200, checked(MediaWriteResult, { id, version: result.version, changeId: input.changeId }, "media restore"));
      },
    },
    {
      method: "POST",
      pattern: /^\/media\/trash\/empty$/,
      run: async (_m, _u, request) => {
        if (!media.trash || !media.restore) return fail("not-implemented", "This site has no media trash.");
        const input = await readBody(request, MediaTrashEmptyInput);
        // Gather first, then delete: a cursor into a list that is shrinking would skip files.
        const ids: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await media.list({ trashed: "only", limit: TRASH_PAGE, ...(cursor ? { cursor } : {}) });
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
            refused.push({ id, message: failure.message, ...(failure.usedBy ? { usedBy: failure.usedBy } : {}) });
          }
        }
        return json(200, checked(MediaTrashEmptyResult, { changeId: input.changeId, deleted, refused, more }, "media trash empty"));
      },
    },
    {
      method: "POST",
      pattern: /^\/media\/bulk$/,
      run: async (_m, _u, request) => {
        const input = await readBody(request, MediaBulkInput);
        const lacking = bulkLacking(media, input.op);
        if (lacking) return fail("not-implemented", lacking);
        if ((input.op === "add-tags" || input.op === "remove-tags") && (!input.tags || input.tags.length === 0)) {
          throw new BadRequest("invalid", "tags: name at least one tag.");
        }
        const results: MediaBulkOutcome[] = [];
        // One at a time, in order: a site's index and cache purge are not built for a burst, and one
        // file's refusal (a stale version, a file in use) is that file's outcome and nothing more.
        for (const item of input.items) {
          results.push(await bulkOne(media, input.op, input.tags ?? [], item, log));
        }
        return json(200, checked(MediaBulkResult, { op: input.op, results }, "media bulk"));
      },
    },
  ];

  /** An upload's body, read up to the site's limit and checked against its declared type. */
  async function uploaded(request: Parameters<typeof readUpload>[0], contentType: string): Promise<Uint8Array> {
    const read = await readUpload(request, media.limits);
    if (!read.ok) throw new BadRequest(read.refusal.code, read.refusal.message);
    const wrongBytes = checkUpload(contentType, read.bytes, media.limits);
    if (wrongBytes) throw new BadRequest(wrongBytes.code, wrongBytes.message);
    return read.bytes;
  }

  /** A file on the web, fetched through the site's importFetch and checked as an upload is. */
  async function imported(url: string): Promise<{ bytes: Uint8Array; contentType: string; address: string }> {
    const refusal = importRefusal(url);
    if (refusal) throw new BadRequest("invalid", refusal);
    let response: Response;
    let address: string;
    try {
      ({ response, address } = await fetchImport(media.importFetch!, url));
    } catch (error) {
      if (error instanceof ImportRefusal) throw new RefusedError(error.message);
      throw error;
    }
    const contentType = essence(response.headers.get("content-type"));
    const wrongType = checkUpload(contentType, null, media.limits);
    if (wrongType) {
      await response.body?.cancel().catch(() => {});
      throw new BadRequest(wrongType.code, wrongType.message);
    }
    return { bytes: await uploaded(response, contentType), contentType, address };
  }

  /** The file at the version the caller saw, and one the site lets this API change: the checks before a write to its bytes. */
  async function held(id: string, expectedVersion: string, done: string): Promise<MediaDetailType> {
    const current = await media.get(id);
    if (!current) throw new NotFoundError("No such media.");
    if (current.version !== expectedVersion) throw new VersionConflictError(current.version ?? null, "The file changed since it was loaded.");
    if (!current.deletable) throw new RefusedError(`This file is one of the site's own, so it is never ${done} through this API.`);
    return current;
  }

  /**
   * Stores checked bytes (an upload or an import): the file already holding them where the site finds duplicates, so the
   * site never stores the same bytes twice, else the site's new file. The key is duplicateKey's (v0.21.0): the bytes as
   * sent without their private metadata, which is what a site stores unless it converts or shrinks the picture. For a
   * file it converted or shrank, the store remembers which file each key became, since the site's own hashes are of other
   * bytes.
   */
  async function store(
    bytes: Uint8Array,
    contentType: string,
    fields: { filename: string; alt: string; decorative: boolean; changeId: string; resize?: "no" | undefined },
    sourceUrl?: string,
  ): Promise<Response> {
    const sha256 = await duplicateKey(bytes, contentType);
    if (media.findByHash) {
      const twin = (await media.findByHash(sha256)) ?? (await sentBefore(sha256));
      if (twin) return json(200, checked(MediaUploadResult, { ...twin, duplicateOf: twin.id }, "media duplicate"));
    }
    const uploaded = await media.upload({
      bytes,
      contentType,
      filename: fields.filename,
      alt: fields.alt,
      ...(fields.decorative ? { decorative: true } : {}),
      changeId: fields.changeId,
      sha256,
      resize: media.resize !== undefined && fields.resize !== "no",
      ...(sourceUrl ? { sourceUrl } : {}),
    });
    // An import is served from the site's own storage: an address back at the source would be a hotlink.
    if (sourceUrl && (uploaded.url === sourceUrl || uploaded.downloadUrl === sourceUrl)) throw new ContractBreach(`import of ${sourceUrl} is served from its source`);
    const answer = checked(MediaUploadResult, uploaded, "uploaded media");
    if (media.findByHash && siteStore) await siteStore.putUploadedMedia(sha256, answer.id, new Date().toISOString());
    return json(201, answer);
  }

  /** The file an earlier upload with this key became, where the site still holds it (trashed or not); else null. */
  async function sentBefore(sha256: string) {
    const id = siteStore ? await siteStore.uploadedMedia(sha256) : null;
    const found = id ? await media.get(id) : null;
    if (!found) return null;
    const { usedBy: _usedBy, twins: _twins, ...item } = found;
    return item;
  }

  /** The files changed since a cursor: a poll takes no other filter, so it never misses a file another filter would hide. */
  async function changesSince(since: string, limit: number, url: URL): Promise<Response> {
    if (!media.changes) return fail("not-implemented", "This site does not say what changed since.");
    const other = [...url.searchParams.keys()].filter((k) => k !== "changedSince" && k !== "limit");
    if (other.length > 0) throw new BadRequest("invalid", `changedSince takes only limit, not ${[...new Set(other)].join(", ")}.`);
    const found = await media.changes({ since, limit });
    if (found.items.length + found.removed.length > limit) throw new ContractBreach(`media changes: ${found.items.length + found.removed.length} answered for a limit of ${limit}`);
    return json(200, checked(MediaList, { items: found.items, nextCursor: null, changeCursor: found.cursor, removed: found.removed, moreChanges: found.more }, "media changes"));
  }
}

/** Refuses, as 400 before anything is read or stored, an alt the contract does not take (altRefusal). */
function checkAlt(alt: string | undefined, decorative: boolean, filename: string | null): void {
  const refusal = altRefusal(alt, decorative, filename);
  if (refusal) throw new BadRequest("invalid", `alt: ${refusal}`);
}

/** A model's words, in the contract's spelling: what cannot be a tag is dropped, never passed on, and a blank alt is none. */
function suggestionOf(found: { tags: string[]; alt: string | null; model: string }): { tags: string[]; alt: string | null; model: string } {
  const tags = [...new Set(found.tags.map((t) => t.trim().toLowerCase().replace(/[\s_]+/g, "-")))].filter((t) => MediaTag.safeParse(t).success).slice(0, 12);
  return { tags, alt: found.alt?.trim() ? found.alt.trim().slice(0, 2000) : null, model: found.model };
}

/** The name an import keeps when it names none: the address's last segment, made a plain file name. */
function nameOf(address: string): string {
  const last = new URL(address).pathname.split("/").filter(Boolean).pop() ?? "";
  let name: string;
  try {
    name = decodeURIComponent(last);
  } catch {
    name = last;
  }
  // A file name may not hold control characters or a path, on purpose.
  // oxlint-disable-next-line no-control-regex
  const plain = name.replace(/[/\\\u0000-\u001f]+/g, "-").trim().slice(0, 200);
  return plain || "import";
}

/** One file's failure as a per-file outcome's error, in the words describeFailure gives it. */
function failedOutcome(error: unknown, log: Log): Omit<Extract<MediaResizeOutcome, { ok: false }>, "id" | "changeId"> {
  const failure = describeFailure(error, log);
  const code = (["not-found", "version-conflict", "refused", "invalid"] as const).find((c) => c === failure.code) ?? "internal";
  return {
    ok: false as const,
    error: code,
    message: failure.message,
    ...(failure.currentVersion !== undefined ? { currentVersion: failure.currentVersion } : {}),
  };
}

/** What a bulk op needs that the adapter lacks, as the 501 message, else null. */
function bulkLacking(m: MediaAdapter, op: MediaBulkInput["op"]): string | null {
  if ((op === "trash" || op === "restore") && !(m.trash && m.restore)) return "This site has no media trash.";
  if ((op === "add-tags" || op === "remove-tags") && !m.setTags) return "This site does not keep media tags.";
  return null;
}

/** One file's bulk outcome. Every failure is caught here, so no file's failure stops the next. */
async function bulkOne(
  m: MediaAdapter,
  op: MediaBulkInput["op"],
  tags: string[],
  item: MediaBulkInput["items"][number],
  log: Log,
): Promise<MediaBulkOutcome> {
  const { id, changeId } = item;
  try {
    if (op === "delete") {
      await m.delete(id, { changeId });
      return { ok: true, id, changeId };
    }
    const expectedVersion = item.expectedVersion;
    if (!expectedVersion) throw new BadRequest("invalid", `expectedVersion: ${op} needs the version the caller last saw.`);
    if (op === "trash" || op === "restore") {
      const result = await (op === "trash" ? m.trash!(id, { expectedVersion, changeId }) : m.restore!(id, { expectedVersion, changeId }));
      return { ok: true, id, changeId, version: checked(MediaWriteResult, { id, version: result.version, changeId }, `media ${op}`).version };
    }
    // Tags: the new set is worked out from what the site holds now, and refused if that is not the
    // version the caller saw. The adapter checks again on the write, which closes the gap.
    const current = await m.get(id);
    if (!current) throw new NotFoundError("No such media.");
    if (current.version !== expectedVersion) throw new VersionConflictError(current.version ?? null);
    const held = new Set(current.tags ?? []);
    for (const tag of tags) {
      if (op === "add-tags") held.add(tag);
      else held.delete(tag);
    }
    const next = [...held].sort();
    if (!MediaTagsInput.shape.tags.safeParse(next).success) throw new RefusedError("A file carries at most 12 tags.");
    const result = await m.setTags!(id, { tags: next, expectedVersion, changeId });
    return { ok: true, id, changeId, version: checked(MediaWriteResult, { id, version: result.version, changeId }, "media tags").version };
  } catch (error) {
    const usedBy = error instanceof MediaInUseError ? error.usedBy : undefined;
    return { ...failedOutcome(error, log), id, changeId, ...(usedBy ? { usedBy } : {}) };
  }
}
