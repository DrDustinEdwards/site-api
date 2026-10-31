// v0.17.0: sending webmentions. The link reader, the host check and the endpoint discovery read strangers' pages, so
// each is tested on the cases that would send to the wrong place; the hook once, end to end, against fake pages.

import { describe, expect, it } from "vitest";
import { d1SiteApiStore, SITE_API_STORE_SQL } from "../src/store.js";
import { endpointOf, outboundLinks, safeTarget, webmentionHook } from "../src/webmention.js";
import { d1 } from "./d1.js";

const PAGE = "https://site.example/blog/a";

describe("outboundLinks", () => {
  it("reads only the post's own content: the first h-entry's e-content, nested elements included, never comments or scripts", () => {
    const html = `<nav><a href="https://nav.example/">nav</a></nav>
      <div class="h-entry"><div class="p-name">T</div><div class="e-content x">
        <div><a href="https://a.example/one#frag">one</a></div>
        <!-- <a href="https://hidden.example/"> -->
        <script>"<a href='https://script.example/'>"</script>
        <a href='/own'>own</a> <a href="mailto:x@example.com">mail</a> <a href=https://b.example/two?x=1&amp;y=2>two</a>
        <a href="https://a.example/one">again</a>
      </div><a href="https://after.example/">after</a></div>`;
    expect(outboundLinks(html, PAGE)).toEqual(["https://a.example/one", "https://b.example/two?x=1&y=2"]);
  });

  it("falls back to the article, then main, and to nothing", () => {
    expect(outboundLinks(`<a href="https://x.example/">x</a><article><a href="https://a.example/">a</a></article>`, PAGE)).toEqual(["https://a.example/"]);
    expect(outboundLinks(`<main><a href="https://m.example/">m</a></main>`, PAGE)).toEqual(["https://m.example/"]);
    expect(outboundLinks(`<p><a href="https://x.example/">x</a></p>`, PAGE)).toEqual([]);
  });
});

describe("safeTarget", () => {
  it("refuses local, loopback, private and link-local hosts in every spelling, and anything but http(s)", () => {
    for (const bad of [
      "http://localhost/", "http://a.localhost/", "https://printer.local/", "http://127.0.0.1/", "http://2130706433/", "http://0x7f.1/",
      "http://10.1.2.3/", "http://172.20.0.1/", "http://192.168.1.1/", "http://169.254.169.254/", "http://100.64.0.1/", "http://0.0.0.0/",
      "http://[::1]/", "http://[fe80::1]/", "http://[fd00::1]/", "http://[::ffff:127.0.0.1]/", "ftp://example.com/", "file:///etc/passwd", "http://intranet/",
      // IPv4 hidden in IPv6: compatible, translated, NAT64 of the metadata address, 6to4, Teredo; site-local; benchmarking.
      "http://[::7f00:1]/", "http://[::ffff:0:7f00:1]/", "http://[64:ff9b::a9fe:a9fe]/", "http://[2002:7f00:1::]/", "http://[2001::1]/",
      "http://[fec0::1]/", "http://198.18.0.1/", "http://192.0.0.1/",
    ]) expect(safeTarget(bad), bad).toBe(false);
    for (const good of ["https://example.com/", "http://8.8.8.8/x", "https://[2606:4700::1]/", "http://172.32.0.1/", "http://[64:ff9b::808:808]/", "http://[2002:808:808::]/"]) expect(safeTarget(good), good).toBe(true);
  });
});

describe("endpointOf", () => {
  it("takes the Link header first, then the first link or a with rel webmention in document order, resolved", () => {
    expect(endpointOf('<https://e.example/other>; rel="other", </wm>; rel="webmention me"', "", "https://t.example/p")).toBe("https://t.example/wm");
    const html = `<!-- <link rel="webmention" href="/commented"> --><script>"<link rel='webmention' href='/script'>"</script><a rel="nofollow webmention" href="/first">x</a><link rel="webmention" href="/second">`;
    expect(endpointOf(null, html, "https://t.example/p")).toBe("https://t.example/first");
    expect(endpointOf(null, `<link rel="webmention" href="">`, "https://t.example/p?q=1")).toBe("https://t.example/p?q=1");
    expect(endpointOf(null, "<p>none</p>", "https://t.example/p")).toBeNull();
  });
});

describe("webmentionHook", () => {
  it("sends to each link and to each removed one, follows a checked redirect, refuses a private endpoint, and on delete sends to the last set", async () => {
    let post = `<article><a href="https://a.example/1">a</a><a href="https://b.example/2">b</a></article>`;
    const sent: string[] = [];
    const pages: Record<string, () => Response> = {
      [PAGE]: () => new Response(post, { headers: { "content-type": "text/html" } }),
      "https://a.example/1": () => new Response("", { status: 301, headers: { location: "https://a.example/moved" } }),
      "https://a.example/moved": () => new Response('<link rel="webmention" href="/wm">', { headers: { "content-type": "text/html" } }),
      "https://b.example/2": () => new Response("", { headers: { link: '<http://10.0.0.1/wm>; rel="webmention"' } }),
      "https://c.example/3": () => new Response("", { headers: { link: '<https://c.example/wm>; rel="webmention"' } }),
    };
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        sent.push(`${url} ${new URLSearchParams(String(init.body)).get("target")}`);
        return new Response(null, { status: 202 });
      }
      return pages[url]?.() ?? new Response("", { status: 404 });
    }) as typeof globalThis.fetch;
    const logs: Array<Record<string, unknown>> = [];
    const hook = webmentionHook({ store: d1SiteApiStore(d1(SITE_API_STORE_SQL)), fetch, log: (e) => logs.push(e) });
    const event = (action: "publish" | "update" | "delete", status?: "published") => ({ action, id: "a", path: "/blog/a", url: PAGE, trigger: "request" as const, changeId: "c1", ...(status ? { status } : {}) });

    await hook.run(event("publish", "published"));
    expect(sent).toEqual(["https://a.example/wm https://a.example/1"]);
    expect(logs).toContainEqual(expect.objectContaining({ target: "https://b.example/2", result: "refused endpoint" }));

    post = `<article><a href="https://c.example/3">c</a></article>`;
    await hook.run(event("update", "published"));
    expect(sent.slice(1)).toEqual(["https://c.example/wm https://c.example/3", "https://a.example/wm https://a.example/1"]);

    await hook.run(event("delete"));
    expect(sent.slice(3)).toEqual(["https://c.example/wm https://c.example/3"]);
    await hook.run(event("delete"));
    expect(sent).toHaveLength(4);
  });
});
