// Sending webmentions (v0.15.0): the hook that tells every page a post links to that it did, and tells them again when
// the post changes or leaves the site, so their copy of the mention follows. The receiving side is the mentions group.
//
// Every address it fetches comes from a stranger's page, so each one is checked before it is asked, and again at every
// redirect: http or https only, never a local, loopback, private or link-local host. Nothing here parses HTML with a DOM
// (a Worker has HTMLRewriter, Node has neither); a small tag scanner over the text finds what it needs.

import type { PublishHook } from "./hooks.js";
import type { SiteApiStore } from "./store.js";

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 5000;
const MAX_BYTES = 1024 * 1024;

/** True for an address the hook may fetch: http or https, and a host that is neither local nor private. */
export function safeTarget(address: string | URL): boolean {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "local" || host.endsWith(".local")) return false;
  if (host.includes(":")) return safeIPv6(host);
  // The URL parser already turned every IPv4 spelling (decimal, hex, short) into dotted quads.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return safeIPv4(host.split(".").map(Number));
  return host.includes(".");
}

function safeIPv4([a, b]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a! >= 224) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b! >= 16 && b! <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 100 && b! >= 64 && b! <= 127) return false;
  return true;
}

function safeIPv6(host: string): boolean {
  if (host === "::" || host === "::1") return false;
  // An IPv4 address inside IPv6 (::ffff:7f00:1, as the parser writes ::ffff:127.0.0.1) is judged as that address.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const [hi, lo] = [parseInt(mapped[1]!, 16), parseInt(mapped[2]!, 16)];
    return safeIPv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  }
  const first = parseInt(host.split(":")[0] || "0", 16);
  // fc00::/7 unique local, fe80::/10 link-local, ff00::/8 multicast.
  return !((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00);
}

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
  const text = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, "");
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
  for (const tag of tags(html.replace(/<!--[\s\S]*?-->/g, ""))) {
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

/** A GET that checks every address on its way, follows at most MAX_REDIRECTS, and reads at most MAX_BYTES of HTML. */
async function getPage(doFetch: typeof fetch, address: string, userAgent: string): Promise<{ url: string; link: string | null; html: string }> {
  let url = address;
  for (let hop = 0; ; hop++) {
    if (!safeTarget(url)) throw new Error(`refused address ${url}`);
    const response = await doFetch(url, { redirect: "manual", headers: { "user-agent": userAgent, accept: "text/html" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => {});
      if (hop >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects from ${address}`);
      url = new URL(location, url).href;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`${url} answered ${response.status}`);
    }
    const html = /html/i.test(response.headers.get("content-type") ?? "") ? await readText(response) : "";
    return { url, link: response.headers.get("link"), html };
  }
}

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
export function webmentionHook(options: { store: TargetStore; fetch?: typeof fetch; userAgent?: string; log?: (entry: Record<string, unknown>) => void }): PublishHook {
  const doFetch = options.fetch ?? fetch;
  const userAgent = options.userAgent ?? "site-api webmention sender";
  const log = options.log ?? ((entry) => console.warn(JSON.stringify(entry)));

  async function send(source: string, target: string): Promise<void> {
    try {
      const page = await getPage(doFetch, target, userAgent);
      const endpoint = endpointOf(page.link, page.html, page.url);
      if (!endpoint) return log({ siteApi: "webmention", source, target, result: "no endpoint" });
      if (!safeTarget(endpoint)) return log({ siteApi: "webmention", source, target, result: "refused endpoint" });
      const response = await doFetch(endpoint, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": userAgent },
        body: new URLSearchParams({ source, target }).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => {});
      log({ siteApi: "webmention", source, target, result: response.ok ? "sent" : `endpoint answered ${response.status}` });
    } catch (error) {
      log({ siteApi: "webmention", source, target, result: error instanceof Error ? error.message : String(error) });
    }
  }

  async function update(source: string, gone: boolean): Promise<void> {
    const links = gone ? [] : outboundLinks((await getPage(doFetch, source, userAgent)).html, source);
    const before = await options.store.webmentionTargets(source);
    for (const target of new Set([...links, ...before])) await send(source, target);
    await options.store.putWebmentionTargets(source, links, new Date().toISOString());
  }

  return {
    name: "webmention",
    on: ["publish", "update", "unpublish", "delete", "trash", "rename"],
    run: async (event) => {
      if (event.previousUrl) await update(event.previousUrl, true);
      // A page that is not live (after an unpublish, a delete, a trash, or a save to a draft) links to nothing now.
      await update(event.url, event.status !== "published");
    },
  };
}
