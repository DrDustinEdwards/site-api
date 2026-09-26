// The Carrel side: a typed client for one site. Every response is checked against the contract, so
// a site that drifts fails here by name instead of somewhere later in Carrel.

import type { z } from "zod";
import {
  ContentDoc,
  ContentList,
  Diff,
  ErrorBody,
  Meta,
  PREFIX,
  RevisionList,
  WriteResult,
  type ListQuery,
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

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    const response = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${config.key}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
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
    diff: (id: string, from: string, to?: string) => get(Diff, "GET", `/content/${enc(id)}/diff${query({ from, to })}`),
    preview: async (input: PreviewInput) => (await call("POST", "/preview", input)).text(),
  };
}

export type SiteClient = ReturnType<typeof createSiteClient>;
