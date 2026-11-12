// Shareable preview links (v0.17.0), on a site that gives the package a store. Carrel makes one for an item under the
// key; anyone holding its address sees the item's current source rendered, with no key, until it expires or is revoked.
// The site keeps only the SHA-256 of each token, so its store cannot open a link.

import { jsonResponse } from "@dustinedwards/site-runtime/http";
import { base64url } from "@dustinedwards/site-runtime/encoding";
import { NotFoundError, type SiteAdapter } from "../adapter.js";
import {
  PREVIEW_LINK_DEFAULT_HOURS,
  PreviewLink,
  PreviewLinkInput,
  PreviewLinkList,
  PreviewLinkListQuery,
  PreviewLinkRevokeQuery,
  PreviewLinkRevokeResult,
} from "../contract.js";
import { sha256Hex } from "@dustinedwards/site-runtime/encoding";
import type { SiteApiStore } from "../store.js";
import {
  BASE_HEADERS,
  BadRequest,
  ContractBreach,
  checked,
  readBody,
  readQuery,
  type Route,
} from "./http.js";

/** Where a site serves its preview links, outside the API's prefix: `GET {origin}/preview/<token>`. */
export const PREVIEW_LINK_PATH = "/preview/";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const LINK_ID = /^[0-9a-f]{12}$/;
const HOUR = 60 * 60 * 1000;

export function previewLinkRoutes(adapter: SiteAdapter, store: SiteApiStore): Route[] {
  return [
    {
      method: "POST",
      pattern: /^\/preview-links$/,
      run: async (_m, _u, request) => {
        const input = await readBody(request, PreviewLinkInput);
        if (!(await adapter.content.get(input.id))) throw new NotFoundError();
        const token = base64url(crypto.getRandomValues(new Uint8Array(32)));
        const now = new Date();
        // v0.22.0: expiresInHours, up to 30 days; the v0.17.0 `hours` still works.
        if (input.expiresInHours !== undefined && input.hours !== undefined)
          throw new BadRequest("invalid", "Send expiresInHours or hours, not both.");
        const hours = input.expiresInHours ?? input.hours ?? PREVIEW_LINK_DEFAULT_HOURS;
        const expiresAt = new Date(now.getTime() + hours * HOUR).toISOString();
        await store.putPreviewLink({
          tokenHash: await sha256Hex(token),
          contentId: input.id,
          createdAt: now.toISOString(),
          expiresAt,
          revokedAt: null,
          changeId: input.changeId,
        });
        const url = new URL(`${PREVIEW_LINK_PATH}${token}`, adapter.site.origin).href;
        return jsonResponse(
          checked(PreviewLink, { token, url, expiresAt }, "preview link"),
          201,
          BASE_HEADERS,
        );
      },
    },
    {
      method: "GET",
      query: true,
      pattern: /^\/preview-links$/,
      run: async (_m, url) => {
        const { id } = readQuery(url, PreviewLinkListQuery);
        const links = await store.activePreviewLinks(id, new Date().toISOString());
        const items = links.map((l) => ({
          id: l.tokenHash.slice(0, 12),
          createdAt: l.createdAt,
          expiresAt: l.expiresAt,
        }));
        return jsonResponse(
          checked(PreviewLinkList, { items }, "preview links"),
          200,
          BASE_HEADERS,
        );
      },
    },
    {
      method: "DELETE",
      query: true,
      pattern: /^\/preview-links\/([^/]+)$/,
      run: async (m, url) => {
        const linkId = m[1]!;
        if (!LINK_ID.test(linkId)) throw new BadRequest("invalid", "The link id is not valid.");
        const { changeId } = readQuery(url, PreviewLinkRevokeQuery);
        if (!(await store.revokePreviewLink(linkId, new Date().toISOString())))
          throw new NotFoundError("No such preview link.");
        return jsonResponse(
          checked(
            PreviewLinkRevokeResult,
            { id: linkId, revoked: true, changeId },
            "preview link revoke",
          ),
          200,
          BASE_HEADERS,
        );
      },
    },
  ];
}

/**
 * What a preview page may load (OWASP ASVS 5 v3.4.3): the draft's HTML is whatever the author wrote, so no script runs
 * (a pipeline that let one through would run it on the site's origin, with a link anyone holds), no plugin, no base
 * or form redirect, and no frame around it. Styles, images, fonts, media and embeds come over https only. The site's own
 * policy, if it sends one, also applies: a response is held to both.
 */
const PREVIEW_CSP =
  "default-src 'none'; script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; style-src https: 'unsafe-inline'; img-src https: data:; font-src https:; media-src https:; frame-src https:";

const PRIVATE = {
  "content-security-policy": PREVIEW_CSP,
  "x-robots-tag": "noindex, nofollow",
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

export function page(status: number, message: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><title>${message}</title></head><body><p>${message}</p></body></html>`;
  return new Response(html, {
    status,
    headers: { ...PRIVATE, "content-type": "text/html; charset=utf-8" },
  });
}

/** The page behind one link: the item's current source through the site's own preview, or a small page saying why not. */
export async function servePreviewLink(
  adapter: SiteAdapter,
  store: SiteApiStore | undefined,
  pathname: string,
): Promise<Response> {
  const token = pathname.slice(PREVIEW_LINK_PATH.length);
  const link = store && TOKEN.test(token) ? await store.previewLink(await sha256Hex(token)) : null;
  // v0.22.0: a revoked link is as if it never was (404), so its address tells nothing; one that ran out says so (410).
  if (!link || link.revokedAt) return page(404, "No such preview link.");
  if (Date.parse(link.expiresAt) <= Date.now()) return page(410, "This preview link has expired.");
  const doc = await adapter.content.get(link.contentId);
  if (!doc) return page(404, "No such preview link.");
  // A trashed item is off the site, so its links stop with it.
  if (doc.trashedAt) return page(410, "This preview link has expired.");
  const html = await adapter.preview.render({ id: doc.id, source: doc.source });
  if (typeof html !== "string") throw new ContractBreach("preview: not a string");
  return new Response(html, {
    status: 200,
    headers: { ...PRIVATE, "content-type": "text/html; charset=utf-8" },
  });
}
