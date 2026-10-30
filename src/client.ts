// The Carrel side: a typed client for one site. Every response is checked against the contract, so
// a site that drifts fails here by name instead of somewhere later in Carrel.

import type { z } from "zod";
import {
  ContentDeleteResult,
  ContentDoc,
  ContentList,
  Diff,
  ErrorBody,
  MediaBulkResult,
  MediaDeleteResult,
  MediaDetail,
  MediaHistory,
  MediaList,
  MediaReplaceResult,
  MediaResizePassResult,
  MediaSuggestions,
  MediaTransformResult,
  MediaTrashEmptyResult,
  MediaUploadResult,
  MediaWriteResult,
  MentionDecideInput,
  MentionDeleteResult,
  MentionList,
  MentionSweepResult,
  MentionWriteResult,
  Meta,
  PREFIX,
  PreviewLink,
  PreviewLinkList,
  PreviewLinkRevokeResult,
  RenameResult,
  RevisionList,
  RevisionSource,
  ScheduledUpdate,
  WriteResult,
  type ContentTagsInput,
  type ContentTrashInput,
  type ListQuery,
  type MediaAltInput,
  type MediaBulkInput,
  type MediaCaptionInput,
  type MediaCreditInput,
  type MediaFocusInput,
  type MediaImportInput,
  type MediaResizePassInput,
  type MediaRevertInput,
  type MediaTransformInput,
  type MediaListQuery,
  type MediaTagsInput,
  type MediaTrashEmptyInput,
  type MediaTrashInput,
  type MentionListQuery,
  type PreviewInput,
  type PreviewLinkInput,
  type PublishInput,
  type RenameInput,
  type SaveDraftInput,
  type ScheduleInput,
  type UnpublishInput,
} from "./contract.js";

export interface SiteClientConfig {
  /** The site's origin, such as https://dustinedwards.info. */
  baseUrl: string;
  key: string;
  fetch?: typeof fetch;
}

/** A refusal or failure from the site, with the contract's error body when the site sent one. */
export class SiteApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ErrorBody | null,
  ) {
    super(body ? `${status} ${body.error}: ${body.message}` : `site answered ${status}`);
    this.name = "SiteApiError";
  }
}

export function createSiteClient(config: SiteClientConfig) {
  const doFetch = config.fetch ?? fetch;
  const base = `${config.baseUrl.replace(/\/+$/, "")}${PREFIX}`;
  const enc = encodeURIComponent;

  async function call(method: string, path: string, body?: unknown, raw?: { bytes: Uint8Array; contentType: string }): Promise<Response> {
    const response = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.key}`,
        ...(raw ? { "content-type": raw.contentType } : body === undefined ? {} : { "content-type": "application/json" }),
      },
      // A Blob, which every fetch takes as a body whatever its buffer type.
      body: raw ? new Blob([raw.bytes as Uint8Array<ArrayBuffer>]) : body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      let parsed: ErrorBody | null = null;
      try {
        const result = ErrorBody.safeParse(await response.json());
        if (result.success) parsed = result.data;
      } catch {
        // Not JSON: the site's own error page, not ours.
      }
      throw new SiteApiError(response.status, parsed);
    }
    return response;
  }

  async function get<T extends z.ZodType>(schema: T, method: string, path: string, body?: unknown) {
    return schema.parse(await (await call(method, path, body)).json()) as z.infer<T>;
  }

  function query(params: Record<string, string | number | boolean | undefined>): string {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) search.set(k, String(v));
    const text = search.toString();
    return text ? `?${text}` : "";
  }

  return {
    meta: () => get(Meta, "GET", "/meta"),
    list: (q: Partial<ListQuery> = {}) => get(ContentList, "GET", `/content${query(q)}`),
    get: (id: string) => get(ContentDoc, "GET", `/content/${enc(id)}`),
    saveDraft: (id: string, input: SaveDraftInput) => get(WriteResult, "PUT", `/content/${enc(id)}/draft`, input),
    publish: (id: string, input: PublishInput) => get(WriteResult, "POST", `/content/${enc(id)}/publish`, input),
    /**
     * Schedules a draft to go live at `publishAt`, or (v0.10.0, where `scheduledUpdates`) a live item's update: the live
     * version stays served and `source` replaces it then. Sent again, it reschedules.
     */
    schedule: (id: string, input: ScheduleInput) => get(WriteResult, "POST", `/content/${enc(id)}/schedule`, input),
    /** Optional per site (v0.10.0): the update waiting on a live item, with its source. 404 when none, 501 without the capability. */
    scheduledUpdate: (id: string) => get(ScheduledUpdate, "GET", `/content/${enc(id)}/schedule`),
    /** Optional per site (v0.10.0): cancels a schedule. A live item stays live; a scheduled one returns to draft. */
    cancelSchedule: (id: string, input: { expectedVersion: string; changeId: string }) =>
      get(WriteResult, "DELETE", `/content/${enc(id)}/schedule${query(input)}`),
    unpublish: (id: string, input: UnpublishInput) => get(WriteResult, "POST", `/content/${enc(id)}/unpublish`, input),
    revisions: (id: string) => get(RevisionList, "GET", `/content/${enc(id)}/revisions`),
    /** One revision's source (v0.3.0), so each revision in the list opens. */
    revision: (id: string, version: string) => get(RevisionSource, "GET", `/content/${enc(id)}/revisions/${enc(version)}`),
    /** Optional per site (v0.3.0): a site with no delete answers SiteApiError with status 501. */
    delete: (id: string, input: { expectedVersion: string; changeId: string }) =>
      get(ContentDeleteResult, "DELETE", `/content/${enc(id)}${query(input)}`),
    /** Optional per site (v0.6.0): sets a post's whole tag set. A site without it answers SiteApiError with status 501. */
    setTags: (id: string, input: ContentTagsInput) => get(WriteResult, "PUT", `/content/${enc(id)}/tags`, input),
    /** Optional per site (v0.15.0, `contentRename`): moves an item to `newId`; its old path redirects to the new one. */
    rename: (id: string, input: RenameInput) => get(RenameResult, "POST", `/content/${enc(id)}/rename`, input),
    /** Optional per site (v0.15.0, `contentTrash`): to the trash (a live item leaves the site first) and back, as a draft. */
    trash: (id: string, input: ContentTrashInput) => get(WriteResult, "POST", `/content/${enc(id)}/trash`, input),
    restore: (id: string, input: ContentTrashInput) => get(WriteResult, "POST", `/content/${enc(id)}/restore`, input),
    diff: (id: string, from: string, to?: string) => get(Diff, "GET", `/content/${enc(id)}/diff${query({ from, to })}`),
    preview: async (input: PreviewInput) => (await call("POST", "/preview", input)).text(),
    /** Optional per site (v0.15.0, `previewLinks`): a link anyone can open to see an item's current source, without the key. */
    previewLinks: {
      create: (input: PreviewLinkInput) => get(PreviewLink, "POST", "/preview-links", input),
      list: (id: string) => get(PreviewLinkList, "GET", `/preview-links${query({ id })}`),
      revoke: (linkId: string, input: { changeId: string }) => get(PreviewLinkRevokeResult, "DELETE", `/preview-links/${enc(linkId)}${query(input)}`),
    },
    /** The media group (v0.2.0). A refused delete throws SiteApiError whose body carries `usedBy`. */
    media: {
      list: (q: Partial<MediaListQuery> = {}) => get(MediaList, "GET", `/media${query(q)}`),
      get: (id: string) => get(MediaDetail, "GET", `/media/${enc(id)}`),
      /**
       * v0.13.0: answers MediaUploadResult, the item with `duplicateOf` where the site already held these bytes (nothing new
       * was stored), `embedded` and `resizedFrom`. `resize: "no"` keeps this file's size on a site that shrinks uploads.
       */
      upload: async (input: { bytes: Uint8Array; contentType: string; filename: string; alt?: string; changeId: string; resize?: "no" }) =>
        MediaUploadResult.parse(
          await (
            await call("POST", `/media${query({ filename: input.filename, alt: input.alt, changeId: input.changeId, resize: input.resize })}`, undefined, {
              bytes: input.bytes,
              contentType: input.contentType,
            })
          ).json(),
        ),
      /** Takes `{ changeId }` (v0.6.0), like every other write; the change id alone still works. */
      delete: (id: string, input: { changeId: string } | string) =>
        get(MediaDeleteResult, "DELETE", `/media/${enc(id)}${query({ changeId: typeof input === "string" ? input : input.changeId })}`),
      /**
       * The writes of v0.4.0, each optional per site: a site without it answers SiteApiError with
       * status 501 (see meta().capabilities). A stale version is status 409 with the current version.
       */
      setAlt: (id: string, input: MediaAltInput) => get(MediaWriteResult, "PUT", `/media/${enc(id)}/alt`, input),
      setTags: (id: string, input: MediaTagsInput) => get(MediaWriteResult, "PUT", `/media/${enc(id)}/tags`, input),
      trash: (id: string, input: MediaTrashInput) => get(MediaWriteResult, "POST", `/media/${enc(id)}/trash`, input),
      restore: (id: string, input: MediaTrashInput) => get(MediaWriteResult, "POST", `/media/${enc(id)}/restore`, input),
      /**
       * v0.10.0, each optional per site (`mediaFocus`, `mediaCaption`, `mediaReplace`; 501 without). `focus` is "XxY"
       * from site-runtime's ./image `focusOf`, or null to clear it.
       */
      setFocus: (id: string, input: MediaFocusInput) => get(MediaWriteResult, "PUT", `/media/${enc(id)}/focus`, input),
      setCaption: (id: string, input: MediaCaptionInput) => get(MediaWriteResult, "PUT", `/media/${enc(id)}/caption`, input),
      /**
       * New bytes for a file under the same id and address, in the file's own type. Alt, caption and tags stay; the focal
       * point is cleared. `sizesNeedPurge` says whether the site's cache may still serve sizes of the old file.
       */
      replace: async (id: string, input: { bytes: Uint8Array; contentType: string; filename: string; expectedVersion: string; changeId: string }) =>
        MediaReplaceResult.parse(
          await (
            await call("PUT", `/media/${enc(id)}/file${query({ filename: input.filename, expectedVersion: input.expectedVersion, changeId: input.changeId })}`, undefined, {
              bytes: input.bytes,
              contentType: input.contentType,
            })
          ).json(),
        ),
      /**
       * v0.13.0, each optional per site (501 without; see meta().capabilities). `importUrl` has the site fetch an https
       * address into its own storage (`mediaImport`), answering as an upload does.
       */
      importUrl: (input: Omit<MediaImportInput, "alt"> & { alt?: string }) => get(MediaUploadResult, "POST", "/media/import", input),
      /** Credit, license, source and license end as one write (`mediaCredit`). */
      setCredit: (id: string, input: MediaCreditInput) => get(MediaWriteResult, "PUT", `/media/${enc(id)}/credit`, input),
      /** Turns or mirrors a picture (`mediaTransform`); `asNewFile` says the answer is a new file and the old one is as it was. */
      transform: (id: string, input: MediaTransformInput) => get(MediaTransformResult, "POST", `/media/${enc(id)}/transform`, input),
      /** A file's byte history, newest first, and a revert to one of its revisions (`mediaHistory`). */
      history: (id: string) => get(MediaHistory, "GET", `/media/${enc(id)}/history`),
      revert: (id: string, input: MediaRevertInput) => get(MediaTransformResult, "POST", `/media/${enc(id)}/revert`, input),
      /** What the site's model suggests (`mediaSuggestions`). Nothing is applied: accepting one is an alt or tags write. */
      suggestions: (id: string) => get(MediaSuggestions, "GET", `/media/${enc(id)}/suggestions`),
      /** Every file changed since a list's `changeCursor` (`mediaChanges`), with `removed`, the next `changeCursor` and `moreChanges`. */
      changes: (since: string, limit?: number) => get(MediaList, "GET", `/media${query({ changedSince: since, limit })}`),
      /** Shrinks up to MAX_RESIZE_PASS stored pictures to the site's `mediaResize` (`mediaResizePass`); check each outcome's `ok`. */
      resizePass: (input: MediaResizePassInput) => get(MediaResizePassResult, "POST", "/media/resize-pass", input),
      /** Deletes for good every trashed file the site allows, up to MAX_TRASH_EMPTY; `more` says to send it again. */
      emptyTrash: (input: MediaTrashEmptyInput) => get(MediaTrashEmptyResult, "POST", "/media/trash/empty", input),
      /** One request for many files; every file's outcome is its own, so check each `ok`. */
      bulk: (input: MediaBulkInput) => get(MediaBulkResult, "POST", "/media/bulk", input),
    },
    /** The mentions group (v0.5.0), optional per site: a site without it answers SiteApiError with status 501. */
    mentions: {
      list: (q: Partial<MentionListQuery> = {}) => get(MentionList, "GET", `/mentions${query(q)}`),
      decide: (id: string, input: MentionDecideInput) => get(MentionWriteResult, "POST", `/mentions/${enc(id)}/decide`, input),
      delete: (id: string, input: { expectedVersion: string; changeId: string }) =>
        get(MentionDeleteResult, "DELETE", `/mentions/${enc(id)}${query(input)}`),
      /** Takes `{ changeId }` (v0.6.0), like every other write; the change id alone still works. */
      sweep: (input: { changeId: string } | string) =>
        get(MentionSweepResult, "POST", "/mentions/sweep", { changeId: typeof input === "string" ? input : input.changeId }),
    },
  };
}

export type SiteClient = ReturnType<typeof createSiteClient>;

// A site's own admin: the same client, answered in process by its own adapter (./local.ts).
export { localClient, type LocalClientOptions } from "./local.js";
