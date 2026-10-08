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
  MediaItem,
  MediaList,
  MediaTrashEmptyResult,
  MediaWriteResult,
  MentionDecideInput,
  MentionDeleteResult,
  MentionList,
  MentionSweepResult,
  MentionWriteResult,
  Meta,
  PREFIX,
  RevisionList,
  RevisionSource,
  WriteResult,
  type ListQuery,
  type MediaAltInput,
  type MediaBulkInput,
  type MediaListQuery,
  type MediaTagsInput,
  type MediaTrashEmptyInput,
  type MediaTrashInput,
  type MentionListQuery,
  type PreviewInput,
  type PublishInput,
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

  function query(params: Record<string, string | number | undefined>): string {
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
    schedule: (id: string, input: ScheduleInput) => get(WriteResult, "POST", `/content/${enc(id)}/schedule`, input),
    unpublish: (id: string, input: UnpublishInput) => get(WriteResult, "POST", `/content/${enc(id)}/unpublish`, input),
    revisions: (id: string) => get(RevisionList, "GET", `/content/${enc(id)}/revisions`),
    /** One revision's source (v0.3.0), so each revision in the list opens. */
    revision: (id: string, version: string) => get(RevisionSource, "GET", `/content/${enc(id)}/revisions/${enc(version)}`),
    /** Optional per site (v0.3.0): a site with no delete answers SiteApiError with status 501. */
    delete: (id: string, input: { expectedVersion: string; changeId: string }) =>
      get(ContentDeleteResult, "DELETE", `/content/${enc(id)}${query(input)}`),
    diff: (id: string, from: string, to?: string) => get(Diff, "GET", `/content/${enc(id)}/diff${query({ from, to })}`),
    preview: async (input: PreviewInput) => (await call("POST", "/preview", input)).text(),
    /** The media group (v0.2.0). A refused delete throws SiteApiError whose body carries `usedBy`. */
    media: {
      list: (q: Partial<MediaListQuery> = {}) => get(MediaList, "GET", `/media${query(q)}`),
      get: (id: string) => get(MediaDetail, "GET", `/media/${enc(id)}`),
      upload: async (input: { bytes: Uint8Array; contentType: string; filename: string; alt?: string; changeId: string }) =>
        MediaItem.parse(
          await (
            await call("POST", `/media${query({ filename: input.filename, alt: input.alt, changeId: input.changeId })}`, undefined, {
              bytes: input.bytes,
              contentType: input.contentType,
            })
          ).json(),
        ),
      delete: (id: string, changeId: string) => get(MediaDeleteResult, "DELETE", `/media/${enc(id)}${query({ changeId })}`),
      /**
       * The writes of v0.4.0, each optional per site: a site without it answers SiteApiError with
       * status 501 (see meta().capabilities). A stale version is status 409 with the current version.
       */
      setAlt: (id: string, input: MediaAltInput) => get(MediaWriteResult, "PUT", `/media/${enc(id)}/alt`, input),
      setTags: (id: string, input: MediaTagsInput) => get(MediaWriteResult, "PUT", `/media/${enc(id)}/tags`, input),
      trash: (id: string, input: MediaTrashInput) => get(MediaWriteResult, "POST", `/media/${enc(id)}/trash`, input),
      restore: (id: string, input: MediaTrashInput) => get(MediaWriteResult, "POST", `/media/${enc(id)}/restore`, input),
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
      sweep: (changeId: string) => get(MentionSweepResult, "POST", "/mentions/sweep", { changeId }),
    },
  };
}

export type SiteClient = ReturnType<typeof createSiteClient>;
