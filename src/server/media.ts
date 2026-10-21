// The media routes (v0.2.0, writes v0.4.0), mounted only when the site's adapter has media.

import { NotFoundError, RefusedError, VersionConflictError, type MediaAdapter } from "../adapter.js";
import {
  MAX_TRASH_EMPTY,
  MediaAltInput,
  MediaBulkInput,
  MediaBulkResult,
  MediaDeleteQuery,
  MediaDeleteResult,
  MediaDetail,
  MediaId,
  MediaItem,
  MediaList,
  MediaListQuery,
  MediaTagsInput,
  MediaTrashEmptyInput,
  MediaTrashEmptyResult,
  MediaTrashInput,
  MediaUploadQuery,
  MediaWriteResult,
  type MediaBulkOutcome,
  type MediaUse,
} from "../contract.js";
import { checkUpload, essence, readUpload } from "../media.js";
import { BadRequest, ID, checked, describeFailure, fail, json, pathParam, readBody, readQuery, type Log, type Route } from "./http.js";

/** How many trashed files one page of the empty-trash gather asks the site for. */
const TRASH_PAGE = 200;

export function mediaRoutes(media: MediaAdapter, log: Log): Route[] {
  const mediaId = (m: RegExpMatchArray) => pathParam(m[1], MediaId, "media id");

  return [
    {
      method: "GET",
      pattern: /^\/media$/,
      run: async (_m, url) => {
        const query = readQuery(url, MediaListQuery);
        if (query.lens && !(media.lenses ?? []).includes(query.lens)) return fail("not-implemented", `This site does not offer the ${query.lens} lens.`);
        return json(200, checked(MediaList, await media.list(query), "media list"));
      },
    },
    {
      method: "POST",
      pattern: /^\/media$/,
      run: async (_m, url, request) => {
        const query = readQuery(url, MediaUploadQuery);
        const contentType = essence(request.headers.get("content-type"));
        // The type first, so a file the site does not accept is never read at all.
        const wrongType = checkUpload(contentType, null, media.limits);
        if (wrongType) throw new BadRequest(wrongType.code, wrongType.message);
        const read = await readUpload(request, media.limits);
        if (!read.ok) throw new BadRequest(read.refusal.code, read.refusal.message);
        const wrongBytes = checkUpload(contentType, read.bytes, media.limits);
        if (wrongBytes) throw new BadRequest(wrongBytes.code, wrongBytes.message);
        const item = await media.upload({ bytes: read.bytes, contentType, filename: query.filename, alt: query.alt, changeId: query.changeId });
        return json(201, checked(MediaItem, item, "uploaded media"));
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
        const result = await media.setAlt(id, input);
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
    const failure = describeFailure(error, log);
    const code = (["not-found", "version-conflict", "refused", "invalid"] as const).find((c) => c === failure.code) ?? "internal";
    return {
      ok: false,
      id,
      changeId,
      error: code,
      message: failure.message,
      ...(failure.currentVersion !== undefined ? { currentVersion: failure.currentVersion } : {}),
      ...(failure.usedBy ? { usedBy: failure.usedBy } : {}),
    };
  }
}
