// Shareable preview links (v0.15.0), on a site that gives the package a store. Carrel makes one for an item under the
// key; anyone holding its address sees the item's current source rendered, with no key, until it expires or is revoked.
// The site keeps only the SHA-256 of each token, so its store cannot open a link.

import { base64url } from "@dustinedwards/site-runtime/encoding";
import { NotFoundError, type SiteAdapter } from "../adapter.js";
import { PreviewLink, PreviewLinkInput, PreviewLinkList, PreviewLinkListQuery, PreviewLinkRevokeQuery, PreviewLinkRevokeResult } from "../contract.js";
import { sha256Hex } from "../media.js";
import type { SiteApiStore } from "../store.js";
import { BadRequest, ContractBreach, checked, json, readBody, readQuery, type Route } from "./http.js";

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
        const expiresAt = new Date(now.getTime() + input.hours * HOUR).toISOString();
        await store.putPreviewLink({ tokenHash: await sha256Hex(token), contentId: input.id, createdAt: now.toISOString(), expiresAt, revokedAt: null, changeId: input.changeId });
        const url = new URL(`${PREVIEW_LINK_PATH}${token}`, adapter.site.origin).href;
        return json(201, checked(PreviewLink, { token, url, expiresAt }, "preview link"));
      },
    },
    {
      method: "GET",
      pattern: /^\/preview-links$/,
      run: async (_m, url) => {
        const { id } = readQuery(url, PreviewLinkListQuery);
        const links = await store.activePreviewLinks(id, new Date().toISOString());
        const items = links.map((l) => ({ id: l.tokenHash.slice(0, 12), createdAt: l.createdAt, expiresAt: l.expiresAt }));
        return json(200, checked(PreviewLinkList, { items }, "preview links"));
      },
    },
    {
      method: "DELETE",
      pattern: /^\/preview-links\/([^/]+)$/,
      run: async (m, url) => {
        const linkId = m[1]!;
        if (!LINK_ID.test(linkId)) throw new BadRequest("invalid", "The link id is not valid.");
        const { changeId } = readQuery(url, PreviewLinkRevokeQuery);
        if (!(await store.revokePreviewLink(linkId, new Date().toISOString()))) throw new NotFoundError("No such preview link.");
        return json(200, checked(PreviewLinkRevokeResult, { id: linkId, revoked: true, changeId }, "preview link revoke"));
      },
    },
  ];
}

const PRIVATE = {
  "x-robots-tag": "noindex, nofollow",
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

export function page(status: number, message: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex, nofollow"><title>${message}</title></head><body><p>${message}</p></body></html>`;
  return new Response(html, { status, headers: { ...PRIVATE, "content-type": "text/html; charset=utf-8" } });
}

/** The page behind one link: the item's current source through the site's own preview, or a small page saying why not. */
export async function servePreviewLink(adapter: SiteAdapter, store: SiteApiStore | undefined, pathname: string): Promise<Response> {
  const token = pathname.slice(PREVIEW_LINK_PATH.length);
  const link = store && TOKEN.test(token) ? await store.previewLink(await sha256Hex(token)) : null;
  if (!link) return page(404, "No such preview link.");
  if (link.revokedAt || Date.parse(link.expiresAt) <= Date.now()) return page(410, "This preview link has expired.");
  const doc = await adapter.content.get(link.contentId);
  if (!doc) return page(404, "No such preview link.");
  const html = await adapter.preview.render({ id: doc.id, source: doc.source });
  if (typeof html !== "string") throw new ContractBreach("preview: not a string");
  return new Response(html, { status: 200, headers: { ...PRIVATE, "content-type": "text/html; charset=utf-8" } });
}
