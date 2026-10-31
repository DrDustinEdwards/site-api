// Safe retries by change id (v0.16.0), on a site that gives the package a store. A write claims its change id before it
// runs; a retry of the same request is answered with the stored answer and never runs twice, and the same id on another
// request is refused. Without a store nothing here runs, and a write is handled as in v0.14.0.

import { ChangeId } from "../contract.js";
import { readUpload, sha256Hex } from "../media.js";
import type { SiteApiStore } from "../store.js";
import { BASE_HEADERS, fail, type Log } from "./http.js";

/** The writes that claim their change id: every one under content, media and mentions. */
export const REPLAYED = /^\/(content|media|mentions)(\/|$)/;

/** A claim still running after this long was left by a request that died before it answered: a retry takes it over. */
const STALE_CLAIM_MS = 2 * 60 * 1000;

/** How long an answer is kept for retries; `runSchedules` prunes older ones. */
export const REPLAY_DAYS = 7;

/**
 * Reads the write's body once (at most `cap` bytes, the route's own limit) and claims its change id. Answers either the
 * response to send now (a replay, a refusal) or the request to run, rebuilt from the bytes read, with `finish` to keep
 * what it answered. A write that carries no change id runs unclaimed; its route refuses it.
 */
export async function claim(
  store: SiteApiStore,
  request: Request,
  path: string,
  cap: number,
  log: Log,
): Promise<{ answer: Response } | { request: Request; finish?: (response: Response) => Promise<void> }> {
  const read = await readUpload(request, { maxBytes: cap, types: [] });
  if (!read.ok && read.refusal.code === "too-large") return { answer: fail("too-large", "The body is too large.") };
  const bytes = read.ok ? read.bytes : new Uint8Array();
  const rebuilt = new Request(request.url, { method: request.method, headers: request.headers, ...(bytes.byteLength > 0 ? { body: bytes as Uint8Array<ArrayBuffer> } : {}) });

  const url = new URL(request.url);
  const changeId = url.searchParams.get("changeId") ?? changeIdIn(bytes);
  if (changeId === null || !ChangeId.safeParse(changeId).success) return { request: rebuilt };

  const route = `${request.method} ${path}`;
  // The query and the body together: an upload's bytes, a delete's query, a JSON write's body.
  const search = new TextEncoder().encode(`${url.search}\n`);
  const whole = new Uint8Array(search.byteLength + bytes.byteLength);
  whole.set(search);
  whole.set(bytes, search.byteLength);
  const requestHash = await sha256Hex(whole);
  const now = Date.now();
  let held;
  try {
    held = await store.claimWrite(changeId, { route, requestHash, at: new Date(now).toISOString(), staleBefore: new Date(now - STALE_CLAIM_MS).toISOString() });
  } catch (error) {
    // A write whose claim could not be made could run twice, so it does not run at all.
    log({ siteApi: "replay-store-failed", error: String(error) });
    return { answer: fail("unavailable", "The site API is unavailable.") };
  }
  if (held) {
    if (held.route !== route || held.requestHash !== requestHash) return { answer: fail("refused", "This change id was already used for a different request.") };
    if (held.state === "running") return { answer: fail("in-progress", "A write under this change id is still running. Send it again once it has answered.") };
    const ok = held.status! >= 200 && held.status! < 300;
    return {
      answer: new Response(held.response, {
        status: held.status!,
        headers: { ...BASE_HEADERS, "content-type": ok ? "application/json; charset=utf-8" : "application/problem+json; charset=utf-8", "idempotent-replayed": "true" },
      }),
    };
  }

  return {
    request: rebuilt,
    finish: async (response) => {
      // A success and a refusal the caller acts on are kept; anything else (a site failure, a 404 that a create may
      // turn into a success) frees the id, so a retry runs again.
      const kept = response.ok || response.status === 409 || response.status === 422;
      try {
        if (kept) await store.finishWrite(changeId, { status: response.status, response: await response.clone().text() });
        else await store.releaseWrite(changeId);
      } catch (error) {
        log({ siteApi: "replay-store-failed", changeId, error: String(error) });
      }
    },
  };
}

function changeIdIn(bytes: Uint8Array): string | null {
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes)) as { changeId?: unknown };
    return typeof body?.changeId === "string" ? body.changeId : null;
  } catch {
    return null;
  }
}
