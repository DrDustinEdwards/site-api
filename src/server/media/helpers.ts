import { mediaType, jsonResponse } from "@dustinedwards/site-runtime/http";
import type { MediaSuggestion } from "../../media-kit.js";

import {
  MediaInUseError,
  NotFoundError,
  RefusedError,
  VersionConflictError,
  type MediaAdapter,
} from "../../adapter.js";
import {
  MediaBulkInput,
  MediaList,
  MediaTag,
  MediaTagsInput,
  MediaUploadResult,
  MediaWriteResult,
  type MediaBulkOutcome,
  type MediaDetail as MediaDetailType,
  type MediaResizeOutcome,
} from "../../contract.js";
import { altRefusal, checkUpload, fetchImport, readUpload } from "../../media.js";
import { addressRefusal, OutboundRefusal } from "../../outbound.js";
import { duplicateKey } from "../../media-upload.js";
import type { SiteApiStore } from "../../store.js";
import {
  BASE_HEADERS,
  BadRequest,
  ContractBreach,
  checked,
  describeFailure,
  notImplemented,
  type Log,
} from "../http.js";

export interface MediaRouteContext extends MediaHelpers {
  media: MediaAdapter;
  log: Log;
  siteStore?: Pick<SiteApiStore, "uploadedMedia" | "putUploadedMedia">;
  mediaId: (m: RegExpMatchArray) => string;
}

export function mediaHelpers(
  media: MediaAdapter,
  log: Log,
  siteStore?: Pick<SiteApiStore, "uploadedMedia" | "putUploadedMedia">,
) {
  /** An upload's body, read up to the site's limit and checked against its declared type. */
  async function uploaded(
    request: Parameters<typeof readUpload>[0],
    contentType: string,
  ): Promise<Uint8Array> {
    const read = await readUpload(request, media.limits);
    if (!read.ok) throw new BadRequest(read.refusal.code, read.refusal.message);
    const wrongBytes = checkUpload(contentType, read.bytes, media.limits);
    if (wrongBytes) throw new BadRequest(wrongBytes.code, wrongBytes.message);
    return read.bytes;
  }

  /** A file on the web, fetched through the site's importFetch and checked as an upload is. */
  async function imported(
    url: string,
  ): Promise<{ bytes: Uint8Array; contentType: string; address: string }> {
    // The address alone first (no fetch, no DNS), so an http or a private address is a 400 before anything is asked.
    const refusal = addressRefusal(url);
    if (refusal) throw new BadRequest("invalid", refusal);
    let response: Response;
    let address: string;
    try {
      ({ response, address } = await fetchImport(media.importFetch!, url));
    } catch (error) {
      if (error instanceof OutboundRefusal) throw new RefusedError(error.message);
      throw error;
    }
    const contentType = mediaType(response.headers.get("content-type"));
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
    if (current.version !== expectedVersion)
      throw new VersionConflictError(
        current.version ?? null,
        "The file changed since it was loaded.",
      );
    if (!current.deletable)
      throw new RefusedError(
        `This file is one of the site's own, so it is never ${done} through this API.`,
      );
    return current;
  }

  /**
   * Stores checked bytes (an upload or an import): the file already holding them where the site finds duplicates, so the
   * site never stores the same bytes twice, else the site's new file. The key is duplicateKey's: the bytes as
   * sent without their private metadata, which is what a site stores unless it converts or shrinks the picture. For a
   * file it converted or shrank, the store remembers which file each key became, since the site's own hashes are of other
   * bytes.
   */
  async function store(
    bytes: Uint8Array,
    contentType: string,
    fields: {
      filename: string;
      alt: string;
      decorative: boolean;
      changeId: string;
      resize?: "no" | undefined;
    },
    sourceUrl?: string,
  ): Promise<Response> {
    const hash = await duplicateKey(bytes, contentType);
    if (media.findByHash) {
      const twin = (await media.findByHash(hash)) ?? (await sentBefore(hash));
      if (twin)
        return jsonResponse(
          checked(MediaUploadResult, { ...twin, duplicateOf: twin.id }, "media duplicate"),
          200,
          BASE_HEADERS,
        );
    }
    const uploaded = await media.upload({
      bytes,
      contentType,
      filename: fields.filename,
      alt: fields.alt,
      ...(fields.decorative ? { decorative: true } : {}),
      changeId: fields.changeId,
      sha256: hash,
      resize: media.resize !== undefined && fields.resize !== "no",
      ...(sourceUrl ? { sourceUrl } : {}),
    });
    // An import is served from the site's own storage: an address back at the source would be a hotlink.
    if (sourceUrl && (uploaded.url === sourceUrl || uploaded.downloadUrl === sourceUrl))
      throw new ContractBreach(`import of ${sourceUrl} is served from its source`);
    const answer = checked(MediaUploadResult, uploaded, "uploaded media");
    // The file is stored either way: a store that fails (a site that has not applied SITE_API_STORE_SQL_V0_21) loses only
    // this key, as the package's other bookkeeping does, and says so in the log.
    if (media.findByHash && siteStore) {
      await siteStore
        .putUploadedMedia(hash, answer.id, new Date().toISOString())
        .catch((error: unknown) =>
          log({ siteApi: "media-uploads-store-failed", error: String(error) }),
        );
    }
    return jsonResponse(answer, 201, BASE_HEADERS);
  }

  /** The file an earlier upload with this key became, where the site still holds it (trashed or not); else null. */
  async function sentBefore(sha256: string) {
    const id = siteStore
      ? await siteStore
          .uploadedMedia(sha256)
          .catch(
            (error: unknown) => (
              log({ siteApi: "media-uploads-store-failed", error: String(error) }),
              null
            ),
          )
      : null;
    const found = id ? await media.get(id) : null;
    if (!found) return null;
    const { usedBy: _usedBy, twins: _twins, ...item } = found;
    return item;
  }

  /** The files changed since a cursor: a poll takes no other filter, so it never misses a file another filter would hide. */
  async function changesSince(since: string, limit: number, url: URL): Promise<Response> {
    if (!media.changes) return notImplemented("This site does not say what changed since.");
    const other = [...url.searchParams.keys()].filter((k) => k !== "changedSince" && k !== "limit");
    if (other.length > 0)
      throw new BadRequest(
        "invalid",
        `changedSince takes only limit, not ${[...new Set(other)].join(", ")}.`,
      );
    const found = await media.changes({ since, limit });
    if (found.items.length + found.removed.length > limit)
      throw new ContractBreach(
        `media changes: ${found.items.length + found.removed.length} answered for a limit of ${limit}`,
      );
    return jsonResponse(
      checked(
        MediaList,
        {
          items: found.items,
          nextCursor: null,
          changeCursor: found.cursor,
          removed: found.removed,
          moreChanges: found.more,
        },
        "media changes",
      ),
      200,
      BASE_HEADERS,
    );
  }
  return { uploaded, imported, held, store, sentBefore, changesSince };
}

type MediaHelpers = ReturnType<typeof mediaHelpers>;

/** Refuses, as 400 before anything is read or stored, an alt the contract does not take (altRefusal); an upload or import may carry none. */
export function checkAlt(
  alt: string | undefined,
  decorative: boolean,
  filename: string | null,
  required = true,
): void {
  const refusal = altRefusal(alt, decorative, filename, required);
  if (refusal) throw new BadRequest("invalid", `alt: ${refusal}`);
}

/** A model's words, in the contract's spelling: what cannot be a tag is dropped, never passed on, and a blank alt is none. */
export function suggestionOf(found: MediaSuggestion): {
  tags: string[];
  alt: string | null;
  model: string;
  usage?: MediaSuggestion["usage"];
} {
  const tags = [
    ...new Set(
      found.tags.map((t) =>
        t
          .trim()
          .toLowerCase()
          .replace(/[\s_]+/g, "-"),
      ),
    ),
  ]
    .filter((t) => MediaTag.safeParse(t).success)
    .slice(0, 12);
  return {
    tags,
    alt: found.alt?.trim() ? found.alt.trim().slice(0, 2000) : null,
    model: found.model,
    ...(found.usage ? { usage: found.usage } : {}),
  };
}

/** The name an import keeps when it names none: the address's last segment, made a plain file name. */
export function nameOf(address: string): string {
  const last = new URL(address).pathname.split("/").filter(Boolean).pop() ?? "";
  let name: string;
  try {
    name = decodeURIComponent(last);
  } catch {
    name = last;
  }
  // A file name may not hold control characters or a path, on purpose.
  const plain = name
    // oxlint-disable-next-line no-control-regex
    .replace(/[/\\\u0000-\u001f]+/g, "-")
    .trim()
    .slice(0, 200);
  return plain || "import";
}

/** One file's failure as a per-file outcome's error, in the words describeFailure gives it. */
export function failedOutcome(
  error: unknown,
  log: Log,
): Omit<Extract<MediaResizeOutcome, { ok: false }>, "id" | "changeId"> {
  const failure = describeFailure(error, log);
  const code =
    (["not-found", "version-conflict", "refused", "invalid"] as const).find(
      (c) => c === failure.code,
    ) ?? "internal";
  return {
    ok: false as const,
    error: code,
    message: failure.message,
    ...(failure.currentVersion !== undefined ? { currentVersion: failure.currentVersion } : {}),
  };
}

/** What a bulk op needs that the adapter lacks, as the 501 message, else null. */
export function bulkLacking(m: MediaAdapter, op: MediaBulkInput["op"]): string | null {
  if ((op === "trash" || op === "restore") && !(m.trash && m.restore))
    return "This site has no media trash.";
  if ((op === "add-tags" || op === "remove-tags") && !m.setTags)
    return "This site does not keep media tags.";
  return null;
}

/** One file's bulk outcome. Every failure is caught here, so no file's failure stops the next. */
export async function bulkOne(
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
    if (!expectedVersion)
      throw new BadRequest(
        "invalid",
        `expectedVersion: ${op} needs the version the caller last saw.`,
      );
    if (op === "trash" || op === "restore") {
      const result = await (op === "trash"
        ? m.trash!(id, { expectedVersion, changeId })
        : m.restore!(id, { expectedVersion, changeId }));
      return {
        ok: true,
        id,
        changeId,
        version: checked(MediaWriteResult, { id, version: result.version, changeId }, `media ${op}`)
          .version,
      };
    }
    // Tags: the new set is worked out from what the site holds now, and refused if that is not the
    // version the caller saw. The adapter checks again on the write, which closes the gap.
    const current = await m.get(id);
    if (!current) throw new NotFoundError("No such media.");
    if (current.version !== expectedVersion)
      throw new VersionConflictError(current.version ?? null);
    const held = new Set(current.tags ?? []);
    for (const tag of tags) {
      if (op === "add-tags") held.add(tag);
      else held.delete(tag);
    }
    const next = [...held].sort();
    if (!MediaTagsInput.shape.tags.safeParse(next).success)
      throw new RefusedError("A file carries at most 12 tags.");
    const result = await m.setTags!(id, { tags: next, expectedVersion, changeId });
    return {
      ok: true,
      id,
      changeId,
      version: checked(MediaWriteResult, { id, version: result.version, changeId }, "media tags")
        .version,
    };
  } catch (error) {
    const usedBy = error instanceof MediaInUseError ? error.usedBy : undefined;
    return { ...failedOutcome(error, log), id, changeId, ...(usedBy ? { usedBy } : {}) };
  }
}

/** True when `after` is no larger than `before` on either edge and has its proportions, to the pixel a rounding moves. */
export function keepsProportions(
  before: { width: number | null; height: number | null },
  after: { width: number | null; height: number | null },
): boolean {
  const [w0, h0, w1, h1] = [before.width, before.height, after.width, after.height];
  if (w0 === null || h0 === null || w1 === null || h1 === null) return false;
  return w1 <= w0 && h1 <= h0 && Math.abs(w1 * h0 - h1 * w0) <= Math.max(w0, h0);
}
