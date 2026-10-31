// Sending webmentions (v0.17.0): the hook that tells every page a post links to that it did, and tells them again when
// the post changes or leaves the site, so their copy of the mention follows. The receiving side is the mentions group.
//
// Every address it fetches comes from a stranger's page, so each one goes through the package's one outbound guard
// (./outbound.ts, v0.19.0): http or https on the default port, never a local name or a private address, the host's DNS
// answers checked too, and every redirect checked again. Nothing here parses HTML with a DOM
// (a Worker has HTMLRewriter, Node has neither); a small tag scanner over the text finds what it needs.

import type { PublishHook } from "./hooks.js";
import { guardedFetch, outboundRefusal } from "./outbound.js";
import type { SiteApiStore } from "./store.js";

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 5000;
const MAX_BYTES = 1024 * 1024;
// A hook runs in waitUntil, which a Worker gives about 30 seconds: every target is sent at once, and all of them stop
// at BUDGET_MS, so the targets are always stored. A post linking to more than MAX_TARGETS pages tells the first ones.
const BUDGET_MS = 20_000;
const MAX_TARGETS = 100;

type Tag = { name: string; attrs: string; start: number; end: number; closing: boolean };

function* tags(html: string): Generator<Tag> {
  const pattern = /<(\/?)([a-zA-Z][\w-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  for (let m = pattern.exec(html); m; m = pattern.exec(html)) {
    yield { name: m[2]!.toLowerCase(), attrs: m[3]!, start: m.index, end: m.index + m[0].length, closing: m[1] === "/" };
  }
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attrs);
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3]!).replace(/&(amp|quot|#39|lt|gt);/g, (_, e: string) => ({ amp: "&", quot: '"', "#39": "'", lt: "<", gt: ">" })[e]!);
}

const words = (value: string | null) => (value ?? "").toLowerCase().split(/\s+/).filter(Boolean);

/** The page without what is never read for links: comments, scripts, styles and templates. */
const unread = (html: string) => html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, "");

/** The inner HTML of the first element `found` picks, from its start tag to its matching close; null when none. */
function region(html: string, found: (tag: Tag) => boolean, from = 0, to = html.length): { start: number; end: number } | null {
  let open: Tag | null = null;
  let depth = 0;
  for (const tag of tags(html.slice(0, to))) {
    if (tag.start < from) continue;
    if (!open) {
      if (!tag.closing && found(tag)) [open, depth] = [tag, 1];
      continue;
    }
    if (tag.name !== open.name) continue;
    depth += tag.closing ? -1 : 1;
    if (depth === 0) return { start: open.end, end: tag.start };
  }
  return open ? { start: open.end, end: to } : null;
}

/**
 * The post's outbound links: every http(s) `<a href>` inside the first `.h-entry .e-content`, or else the first
 * `<article>`, or else `<main>`, resolved against the page, without fragments, in order, each once. Links on the page's
 * own origin are left out: they are the site's own. Comments, scripts and styles are never read.
 */
export function outboundLinks(html: string, pageUrl: string): string[] {
  const text = unread(html);
  const entry = region(text, (t) => words(attr(t.attrs, "class")).includes("h-entry"));
  const area =
    (entry && region(text, (t) => words(attr(t.attrs, "class")).includes("e-content"), entry.start, entry.end)) ??
    region(text, (t) => t.name === "article") ??
    region(text, (t) => t.name === "main");
  if (!area) return [];
  const origin = new URL(pageUrl).origin;
  const links = new Set<string>();
  for (const tag of tags(text.slice(area.start, area.end))) {
    if (tag.closing || tag.name !== "a") continue;
    const href = attr(tag.attrs, "href");
    if (!href) continue;
    let url: URL;
    try {
      url = new URL(href, pageUrl);
    } catch {
      continue;
    }
    url.hash = "";
    if ((url.protocol === "https:" || url.protocol === "http:") && url.origin !== origin) links.add(url.href);
  }
  return [...links];
}

/** The webmention endpoint a page names: its HTTP Link header first, then the first `<link>` or `<a>` with rel webmention. */
export function endpointOf(linkHeader: string | null, html: string, pageUrl: string): string | null {
  for (const part of (linkHeader ?? "").split(/,(?=\s*<)/)) {
    const m = /<([^>]*)>(.*)/.exec(part);
    const rel = m && /;\s*rel\s*=\s*(?:"([^"]*)"|([^\s;,]+))/i.exec(m[2]!);
    if (m && rel && words(rel[1] ?? rel[2]!).includes("webmention")) return resolve(m[1]!, pageUrl);
  }
  for (const tag of tags(unread(html))) {
    if (tag.closing || (tag.name !== "link" && tag.name !== "a")) continue;
    const href = attr(tag.attrs, "href");
    if (href !== null && words(attr(tag.attrs, "rel")).includes("webmention")) return resolve(href, pageUrl);
  }
  return null;
}

function resolve(href: string, base: string): string | null {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

/** A GET through the outbound guard, following at most MAX_REDIRECTS, reading at most MAX_BYTES of HTML. */
async function getPage(doFetch: typeof fetch, dnsFetch: typeof fetch, address: string, userAgent: string, deadline: AbortSignal): Promise<{ url: string; link: string | null; html: string }> {
  const { response, url } = await guardedFetch(doFetch, address, { headers: { "user-agent": userAgent, accept: "text/html" }, signal: limit(deadline) }, { allowHttp: true, dnsFetch, maxRedirects: MAX_REDIRECTS });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`${url} answered ${response.status}`);
  }
  const html = /html/i.test(response.headers.get("content-type") ?? "") ? await readText(response) : "";
  return { url, link: response.headers.get("link"), html };
}

/** Each fetch's own timeout, cut short by the whole run's deadline. */
const limit = (deadline: AbortSignal) => AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), deadline]);

async function readText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const kept = value.subarray(0, MAX_BYTES - total);
    total += kept.byteLength;
    text += decoder.decode(kept, { stream: true });
    if (total >= MAX_BYTES) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return text + decoder.decode();
}

/** The store the hook keeps each page's sent targets in: any SiteApiStore. */
type TargetStore = Pick<SiteApiStore, "webmentionTargets" | "putWebmentionTargets">;

/**
 * The webmention hook. While the page is live (a publish, an update) it reads the page and sends a webmention to each
 * page it links to, and to each it linked to the last time (so a removed link is heard); once it is not (an unpublish,
 * a delete, a trash), to each it last linked to, since the page is gone; on a rename, the old address too, as gone. One target failing is logged and
 * never stops the rest; a page that cannot be read fails the hook, so the store's retries run it again.
 */
export function webmentionHook(options: {
  store: TargetStore;
  fetch?: typeof fetch;
  /** v0.19.0: the fetch the outbound guard asks DNS over HTTPS with. Defaults to `fetch`. */
  dnsFetch?: typeof fetch;
  userAgent?: string;
  log?: (entry: Record<string, unknown>) => void;
}): PublishHook {
  const doFetch = options.fetch ?? fetch;
  const dnsFetch = options.dnsFetch ?? doFetch;
  const userAgent = options.userAgent ?? "site-api webmention sender";
  const log = options.log ?? ((entry) => console.warn(JSON.stringify(entry)));

  async function send(source: string, target: string, deadline: AbortSignal): Promise<void> {
    try {
      const page = await getPage(doFetch, dnsFetch, target, userAgent, deadline);
      const endpoint = endpointOf(page.link, page.html, page.url);
      if (!endpoint) return log({ siteApi: "webmention", source, target, result: "no endpoint" });
      // The endpoint is posted to once, never followed: checked like every address, DNS included.
      if (await outboundRefusal(endpoint, { allowHttp: true, dnsFetch })) {
        return log({ siteApi: "webmention", source, target, result: "refused endpoint" });
      }
      const response = await doFetch(endpoint, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": userAgent },
        body: new URLSearchParams({ source, target }).toString(),
        signal: limit(deadline),
      });
      await response.body?.cancel().catch(() => {});
      log({ siteApi: "webmention", source, target, result: response.ok ? "sent" : `endpoint answered ${response.status}` });
    } catch (error) {
      log({ siteApi: "webmention", source, target, result: error instanceof Error ? error.message : String(error) });
    }
  }

  async function update(source: string, gone: boolean, deadline: AbortSignal, change: string): Promise<void> {
    // Read past the edge cache: a page stored there before this write's purge lands still has the old links, and the
    // cache keys on the query, so a query of this change's own is always a fresh render.
    const fresh = new URL(source);
    fresh.searchParams.set("webmention", change);
    const links = gone ? [] : outboundLinks((await getPage(doFetch, dnsFetch, fresh.href, userAgent, deadline)).html, source);
    const before = await options.store.webmentionTargets(source);
    const targets = [...new Set([...links, ...before])];
    if (targets.length > MAX_TARGETS) log({ siteApi: "webmention", source, result: `${targets.length} targets, the first ${MAX_TARGETS} told` });
    await Promise.all(targets.slice(0, MAX_TARGETS).map((target) => send(source, target, deadline)));
    await options.store.putWebmentionTargets(source, links, new Date().toISOString());
  }

  return {
    name: "webmention",
    on: ["publish", "update", "unpublish", "delete", "trash", "rename"],
    run: async (event) => {
      // Never a page that was not live: an event with no page (v0.19.0) announces nothing.
      if (!event.url) return;
      const deadline = AbortSignal.timeout(BUDGET_MS);
      const change = event.changeId ?? String(Date.now());
      if (event.previousUrl) await update(event.previousUrl, true, deadline, change);
      // A page that is not live (after an unpublish, a delete, a trash, or a save to a draft) links to nothing now.
      await update(event.url, event.status !== "published", deadline, change);
    },
  };
}
