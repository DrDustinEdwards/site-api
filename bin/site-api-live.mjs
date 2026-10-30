#!/usr/bin/env node
// The live check devkit runs against each deployed site (v0.15.0): keyless probes only, so it needs no secret and
// changes nothing. site-api-live --origin https://example.com [--from <host>]
//
// Prints one GitHub Actions annotation per finding, `::error title=<item>::<url> <detail>` or `::warning ...`, the
// item being the checklist's id. Exits 0 when clean (warnings allowed), 1 on any error, 2 when it could not run.
// Plain ESM with nothing outside Node's built-ins, so it runs from the package without a build.

import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";

const PREFIX = "/api/carrel/v1";

function usage(message) {
  console.error(`site-api-live: ${message}\nUsage: site-api-live --origin <https://site> [--from <host>]`);
  process.exit(2);
}

let args;
try {
  args = parseArgs({ options: { origin: { type: "string" }, from: { type: "string" } } }).values;
} catch (error) {
  usage(error.message);
}
let origin;
try {
  origin = new URL(args.origin ?? "").origin;
} catch {
  usage("--origin must be an address such as https://example.com");
}
// --from names where the run comes from, so a site's logs can tell the probes from a stranger's.
const headers = { "user-agent": `site-api-live${args.from ? ` (from ${args.from})` : ""}` };

let errors = 0;
const report = (level, item, url, detail) => {
  if (level === "error") errors++;
  console.log(`::${level} title=${item}::${url} ${detail}`);
};

async function get(path) {
  const url = `${origin}${path}`;
  try {
    const response = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(10_000) });
    return { url, response, body: await response.text() };
  } catch (error) {
    console.error(`site-api-live: could not reach ${url}: ${error.message}`);
    process.exit(2);
  }
}

/** A keyless answer must be 401, problem details, and never stored by a cache. */
function keyless({ url, response, body }, what) {
  if (response.status !== 401) return report("error", "K4", url, `${what} answered ${response.status} without the key, expected 401`);
  if (response.headers.get("cache-control") !== "no-store") report("error", "K4", url, `${what} has cache-control ${response.headers.get("cache-control") ?? "missing"}, expected no-store`);
  if (!(response.headers.get("content-type") ?? "").startsWith("application/problem+json")) {
    report("error", "K2", url, `${what} is ${response.headers.get("content-type") ?? "untyped"}, expected application/problem+json`);
  } else {
    try {
      const problem = JSON.parse(body);
      if (problem.error !== "unauthorized" || !problem.type || !problem.title || problem.status !== 401) report("error", "K2", url, `${what} is not the unauthorized problem: ${body.slice(0, 200)}`);
    } catch {
      report("error", "K2", url, `${what} is not JSON`);
    }
  }
}

const meta = await get(`${PREFIX}/meta`);
keyless(meta, "meta");

// Without the key an unknown route must look exactly like a known one, or the answer tells which routes exist.
const unknown = await get(`${PREFIX}/site-api-live-${randomBytes(6).toString("hex")}`);
keyless(unknown, "an unknown route");
if (unknown.response.status !== meta.response.status || unknown.body !== meta.body) report("error", "K4", unknown.url, "answers differently from a known route without the key, so it tells which routes exist");

const preview = await get(`/preview/${randomBytes(32).toString("base64url")}`);
const noindex = /noindex/i.test(preview.response.headers.get("x-robots-tag") ?? "") || /<meta[^>]+noindex/i.test(preview.body);
if (preview.response.status !== 404) report("error", "E2", preview.url, `an unknown preview link answered ${preview.response.status}, expected 404`);
else if (!noindex) report("warning", "E2", preview.url, "answers the site's own 404, not a preview link's: the site does not mount preview links yet");

process.exitCode = errors > 0 ? 1 : 0;
