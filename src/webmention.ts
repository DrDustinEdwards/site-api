// Sending webmentions (v0.16.0): the hook that tells every page a post links to that it did, and tells them again when
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
// A hook runs in waitUntil, which a Worker gives about 30 seconds: every target is sent at once, and all of them stop
// at BUDGET_MS, so the targets are always stored. A post linking to more than MAX_TARGETS pages tells the first ones.
const BUDGET_MS = 20_000;
const MAX_TARGETS = 100;

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

function safeIPv4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a! >= 224) return false;
  if (a === 100 && b! >= 64 && b! <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b! >= 16 && b! <= 31) return false;
  if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) return false;
  // Benchmarking (198.18.0.0/15) and the documentation ranges.
  if ((a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113)) return false;
  return true;
}

/** The eight 16-bit groups of an IPv6 address as the URL parser writes it (hex, `::` for the longest zero run). */
function groups(host: string): number[] {
  const [head, tail] = host.split("::") as [string, string | undefined];
  const part = (text: string | undefined) => (text ? text.split(":").map((g) => parseInt(g, 16)) : []);
  const [first, last] = [part(head), part(tail)];
  return [...first, ...Array(8 - first.length - last.length).fill(0), ...last];
}

function safeIPv6(host: string): boolean {
  const g = groups(host);
  const v4 = (hi: number, lo: number) => safeIPv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  // An IPv4 address carried inside IPv6 is judged as that address: compatible (::a.b.c.d, which covers :: and ::1),
  // mapped (::ffff:a.b.c.d), translated (::ffff:0:a.b.c.d), NAT64 (64:ff9b::a.b.c.d) and 6to4 (2002:aabb:ccdd::).
  if (zero(0, 6) || (zero(0, 5) && g[5] === 0xffff) || (zero(0, 4) && g[4] === 0xffff && g[5] === 0)) return v4(g[6]!, g[7]!);
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return v4(g[6]!, g[7]!);
  if (g[0] === 0x2002) return v4(g[1]!, g[2]!);
  // NAT64 local use (64:ff9b:1::/48), discard (100::/64), Teredo (2001::/32, which hides its IPv4) and documentation (2001:db8::/32).
  if ((g[0] === 0x64 && g[1] === 0xff9b) || (g[0] === 0x100 && zero(1, 4)) || (g[0] === 0x2001 && (g[1] === 0 || g[1] === 0xdb8))) return false;
  // fc00::/7 unique local, fe80::/10 link-local, fec0::/10 site-local, ff00::/8 multicast.
  const first = g[0]!;
  return !((first & 0xfe00) === 0xfc00 || (first & 0xff80) === 0xfe80 || (first & 0xff00) === 0xff00);
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

/** A GET that checks every address on its way, follows at most MAX_REDIRECTS, and reads at most MAX_BYTES of HTML. */
async function getPage(doFetch: typeof fetch, address: string, userAgent: string, deadline: AbortSignal): Promise<{ url: string; link: string | null; html: string }> {
  let url = address;
  for (let hop = 0; ; hop++) {
    if (!safeTarget(url)) throw new Error(`refused address ${url}`);
    const response = await doFetch(url, { redirect: "manual", headers: { "user-agent": userAgent, accept: "text/html" }, signal: limit(deadline) });
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
export function webmentionHook(options: { store: TargetStore; fetch?: typeof fetch; userAgent?: string; log?: (entry: Record<string, unknown>) => void }): PublishHook {
  const doFetch = options.fetch ?? fetch;
  const userAgent = options.userAgent ?? "site-api webmention sender";
  const log = options.log ?? ((entry) => console.warn(JSON.stringify(entry)));

  async function send(source: string, target: string, deadline: AbortSignal): Promise<void> {
    try {
      const page = await getPage(doFetch, target, userAgent, deadline);
      const endpoint = endpointOf(page.link, page.html, page.url);
      if (!endpoint) return log({ siteApi: "webmention", source, target, result: "no endpoint" });
      if (!safeTarget(endpoint)) return log({ siteApi: "webmention", source, target, result: "refused endpoint" });
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

  async function update(source: string, gone: boolean, deadline: AbortSignal): Promise<void> {
    const links = gone ? [] : outboundLinks((await getPage(doFetch, source, userAgent, deadline)).html, source);
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
      const deadline = AbortSignal.timeout(BUDGET_MS);
      if (event.previousUrl) await update(event.previousUrl, true, deadline);
      // A page that is not live (after an unpublish, a delete, a trash, or a save to a draft) links to nothing now.
      await update(event.url, event.status !== "published", deadline);
    },
  };
}
