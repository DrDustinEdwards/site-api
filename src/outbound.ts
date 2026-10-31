// The one outbound-address guard (v0.19.0), for every fetch the package makes to an address a stranger chose: the
// webmention sender (targets and their endpoints) and the media import. Before v0.19.0 each had its own copy, and both
// judged the host name alone, so a name that resolves to a private address (127.0.0.1.nip.io) got through.
//
// An address passes when it is https (or http, where the caller allows it), on the scheme's default port, with no user
// name or password, and its host is neither a local name nor an address in a private, loopback, link-local, CGNAT,
// unique-local, multicast, documentation or metadata range. A host name is resolved through DNS over HTTPS (Cloudflare's
// JSON API, A and AAAA) and refused if any answer is such an address, or if it has none. Redirects are followed by hand,
// each hop checked the same way, at most `maxRedirects`.
//
// A Worker's fetch cannot be pinned to the address the check resolved, so a name whose DNS answers change between the
// check and the connect (DNS rebinding) is narrowed to that window, not closed. Cloudflare's own egress also refuses
// private addresses from a Worker, which covers that window there.

const DOH = "https://cloudflare-dns.com/dns-query";
const DOH_TIMEOUT_MS = 5000;

/** A refusal with words for the person or the log. */
export class OutboundRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutboundRefusal";
  }
}

export interface OutboundOptions {
  /** True where plain http is allowed too (the webmention sender); otherwise https only (the media import). */
  allowHttp?: boolean;
  /** The fetch for DNS over HTTPS. Defaults to the fetch the caller passes `guardedFetch`, so a test injects one fetch. */
  dnsFetch?: typeof fetch;
}

/** True for an IPv4 address (four numbers) that a public fetch may reach. */
function publicIPv4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a! >= 224) return false;
  // CGNAT, 100.64.0.0/10.
  if (a === 100 && b! >= 64 && b! <= 127) return false;
  // Link-local, which holds the cloud metadata address 169.254.169.254.
  if (a === 169 && b === 254) return false;
  if (a === 172 && b! >= 16 && b! <= 31) return false;
  if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) return false;
  // Benchmarking (198.18.0.0/15) and the documentation ranges.
  if ((a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113)) return false;
  return true;
}

/** The eight 16-bit groups of an IPv6 address (hex, `::` for the longest zero run, a dotted IPv4 tail allowed). */
function groups(host: string): number[] | null {
  let text = host;
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (tail) {
    const [p, q, r, s] = tail.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, tail.index)}${((p << 8) | q).toString(16)}:${((r << 8) | s).toString(16)}`;
  }
  const [head, rest] = text.split("::") as [string, string | undefined];
  const part = (t: string | undefined) => (t ? t.split(":").map((g) => parseInt(g, 16)) : []);
  const [first, last] = [part(head), part(rest)];
  const all = [...first, ...Array(Math.max(0, 8 - first.length - last.length)).fill(0), ...last];
  return all.length === 8 && all.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? all : null;
}

function publicIPv6(host: string): boolean {
  const g = groups(host);
  if (!g) return false;
  const v4 = (hi: number, lo: number) => publicIPv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
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
  return !((first & 0xfe00) === 0xfc00 || (first & 0xff80) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00);
}

/** True for an IP address, either family, that a public fetch may reach; false for every forbidden range or a non-address. */
export function publicAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "");
  if (bare.includes(":")) return publicIPv6(bare.toLowerCase());
  const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare);
  if (!quad) return false;
  const parts = quad.slice(1).map(Number);
  return parts.every((n) => n <= 255) && publicIPv4(parts);
}

const LOCAL_NAME = /(^|\.)(localhost|local|internal|lan|home|arpa|localdomain)$/;

/**
 * Why this address may not be fetched, judged on the address alone (no DNS), or null when it may. An IP literal is judged
 * by its range here; a host name still needs `resolveRefusal`.
 */
export function addressRefusal(raw: string | URL, options: Pick<OutboundOptions, "allowHttp"> = {}): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "That is not a web address.";
  }
  if (url.protocol !== "https:" && !(options.allowHttp && url.protocol === "http:")) return options.allowHttp ? "Only http and https addresses are fetched." : "Only https addresses are fetched.";
  if (url.username || url.password) return "An address carrying a user name or password is not fetched.";
  // The URL parser drops a default port, so any port left is another one.
  if (url.port !== "") return "Only the default port is fetched.";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  // The URL parser has already turned every IPv4 spelling (decimal, hex, short) into a dotted quad.
  if (host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return publicAddress(host) ? null : "That address is in a private or local network.";
  if (!host.includes(".") || LOCAL_NAME.test(host)) return "A local address is not fetched.";
  return null;
}

/** True when the host is an IP literal, which needs no DNS. */
const isLiteral = (host: string) => host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host);

/**
 * Why the host name may not be fetched, from what DNS over HTTPS answers for it, or null when every A and AAAA answer is
 * public. No answer at all, or a resolver that cannot be asked, refuses: the guard fails closed.
 */
export async function resolveRefusal(host: string, dnsFetch: typeof fetch): Promise<string | null> {
  const name = host.toLowerCase().replace(/\.$/, "");
  const found: string[] = [];
  for (const type of ["A", "AAAA"] as const) {
    let answer: { Status?: number; Answer?: Array<{ type: number; data: string }> };
    try {
      const response = await dnsFetch(`${DOH}?name=${encodeURIComponent(name)}&type=${type}`, {
        headers: { accept: "application/dns-json" },
        signal: AbortSignal.timeout(DOH_TIMEOUT_MS),
      });
      if (!response.ok) return `The name ${name} could not be checked (the resolver answered ${response.status}).`;
      answer = (await response.json()) as typeof answer;
    } catch {
      return `The name ${name} could not be checked.`;
    }
    // 1 is A, 28 is AAAA; a CNAME (5) on the way is followed by the resolver, which answers its addresses too.
    for (const record of answer.Answer ?? []) if (record.type === 1 || record.type === 28) found.push(record.data);
  }
  if (found.length === 0) return `The name ${name} does not resolve.`;
  const inside = found.find((ip) => !publicAddress(ip));
  return inside ? `The name ${name} resolves to an address in a private or local network (${inside}).` : null;
}

/** Why the address may not be fetched, after the address and its DNS answers are both checked, or null when it may. */
export async function outboundRefusal(raw: string | URL, options: OutboundOptions & { dnsFetch: typeof fetch }): Promise<string | null> {
  const refusal = addressRefusal(raw, options);
  if (refusal) return refusal;
  const host = new URL(raw).hostname;
  return isLiteral(host) ? null : resolveRefusal(host, options.dnsFetch);
}

/**
 * A fetch of an address a stranger chose: the address checked first and again at every redirect, followed by hand at
 * most `maxRedirects` times (5 by default). Answers the final response, unread, and its address. Throws OutboundRefusal
 * for an address it would not fetch, or too many redirects; a network failure is thrown as the fetch threw it.
 */
export async function guardedFetch(
  doFetch: typeof fetch,
  address: string,
  init: RequestInit = {},
  options: OutboundOptions & { maxRedirects?: number } = {},
): Promise<{ response: Response; url: string }> {
  const dnsFetch = options.dnsFetch ?? doFetch;
  const maxRedirects = options.maxRedirects ?? 5;
  let url = address;
  for (let hop = 0; ; hop++) {
    const refusal = await outboundRefusal(url, { ...options, dnsFetch });
    if (refusal) throw new OutboundRefusal(refusal);
    const response = await doFetch(url, { ...init, redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => {});
      if (hop >= maxRedirects) throw new OutboundRefusal(`The address redirects more than ${maxRedirects} times.`);
      url = new URL(location, url).href;
      continue;
    }
    return { response, url };
  }
}
