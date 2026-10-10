# site-api

The standard site API every Dustin Edwards site includes so Carrel can list, edit and publish its content. No keys or content live here.

Each site mounts one handler at `/api/carrel/v1` and implements an adapter over its own storage and render. Carrel talks to every site through the same contract, with one key per site.

## Install

Installed by git tag, never from a registry:

```sh
npm install github:DrDustinEdwards/site-api#v0.2.0
```

npm builds `dist/` on install through the `prepare` script.

## Mount it on a site

```ts
import { createSiteApi } from "@dustinedwards/site-api";

const api = createSiteApi({
  adapter: mySiteAdapter(env),     // the site's own storage and render
  key: env.CARREL_SITE_KEY,        // wrangler secret put CARREL_SITE_KEY
  limiter: env.CARREL_RATE_LIMIT,  // a Workers `ratelimit` binding
});

if (api.matches(request)) return api.handle(request);
```

The guard runs in this order: prefix, rate limit, key, route.

- **Prefix.** A request outside `/api/carrel/v1` is never served, whatever key it carries.
- **Rate limit.** The limit is per caller address. A limiter that throws fails closed.
- **Key.** A bearer key, compared in constant time by SHA-256 digest. A site key shorter than 32 characters refuses every request.
- **Route.** An unknown route is refused. A caller without the key cannot tell which routes exist.

The key reaches only this prefix. It cannot deploy, configure, manage users or touch code.

A `ratelimit` binding in `wrangler.jsonc`:

```jsonc
"ratelimits": [
  { "name": "CARREL_RATE_LIMIT", "namespace_id": "1001", "simple": { "limit": 120, "period": 60 } }
]
```

Each site must use its own `namespace_id`, never one another site uses. Sites in one account that share a namespace share its counters, so traffic to one site would spend another's limit.

## The contract

All paths sit under `/api/carrel/v1`. Bodies are JSON, checked on the way in and on the way out. An adapter that answers outside the contract is reported as a site failure, and its body is never passed on.

| Group | Route | Body in | Answer |
|---|---|---|---|
| meta | `GET /meta` | | `Meta`: package version, schema hash, site, capabilities |
| content | `GET /content?status&q&cursor&limit` | | `ContentList` |
| content | `GET /content/:id` | | `ContentDoc`: summary, markdown source, version |
| content | `PUT /content/:id/draft` | `SaveDraftInput` | `WriteResult` |
| content | `POST /content/:id/publish` | `PublishInput` | `WriteResult` |
| content | `POST /content/:id/schedule` | `ScheduleInput` | `WriteResult` |
| content | `POST /content/:id/unpublish` | `UnpublishInput` | `WriteResult` |
| content | `GET /content/:id/revisions` | | `RevisionList`, newest first |
| content | `GET /content/:id/diff?from&to` | | `Diff`: a unified patch; `to` defaults to current |
| content | `GET /content/:id/revisions/:version` | | `RevisionSource`: the source as it was at that version (v0.3.0) |
| content | `DELETE /content/:id?expectedVersion&changeId` | | `ContentDeleteResult` (v0.3.0, optional per site: `501` where the adapter has no `delete`) |
| preview | `POST /preview` | `PreviewInput` | the full page HTML from the site's own pipeline |
| media | `GET /media?q&tag&trashed&cursor&limit` | | `MediaList` (`tag` and `trashed=only` are v0.4.0) |
| media | `POST /media?filename&alt&changeId` | the file's own bytes, typed by `Content-Type` | `201 MediaItem` |
| media | `GET /media/:id` | | `MediaDetail`: the file and every place it is used |
| media | `DELETE /media/:id?changeId` | | `MediaDeleteResult`, or `422 refused` naming each use |
| media | `PUT /media/:id/alt` | `MediaAltInput` | `MediaWriteResult` (v0.4.0, optional) |
| media | `PUT /media/:id/tags` | `MediaTagsInput` | `MediaWriteResult` (v0.4.0, optional) |
| media | `POST /media/:id/trash` | `MediaTrashInput` | `MediaWriteResult` (v0.4.0, optional) |
| media | `POST /media/:id/restore` | `MediaTrashInput` | `MediaWriteResult` (v0.4.0, optional) |
| media | `POST /media/trash/empty` | `MediaTrashEmptyInput` | `MediaTrashEmptyResult` (v0.4.0, optional) |
| media | `POST /media/bulk` | `MediaBulkInput` | `MediaBulkResult` (v0.4.0, optional) |
| mentions | `GET /mentions?status&cursor&limit` | | `MentionList` with the whole queue's `counts` and what a sweep would remove (v0.5.0, optional per site) |
| mentions | `POST /mentions/:id/decide` | `MentionDecideInput` | `MentionWriteResult` (v0.5.0) |
| mentions | `DELETE /mentions/:id?expectedVersion&changeId` | | `MentionDeleteResult` (v0.5.0) |
| mentions | `POST /mentions/sweep` | `MentionSweepInput` | `MentionSweepResult` (v0.5.0) |
| inbox, insight, publications | `/*` | | `501` until their stage |

The media group arrived in v0.2.0. A site whose adapter has no `media` still answers it `501`, as in v0.1.0.

Every write carries an `expectedVersion` and a Carrel `changeId`.

- **`expectedVersion`** is opaque to Carrel, and each site decides what a version is. It should identify the item's own content, so that a write to one item never makes another look changed. dustinedwards.info uses the git blob sha of the item's own file, so only a change to that item moves it. On a save, `null` means create, and the id must be free.
- **Refusals.** A stale version is refused with `409 version-conflict` and the site's `currentVersion`. A version given for an id that does not exist is refused the same way, with a null `currentVersion`.
- **`changeId`** goes into the site's commit or row, so Carrel's authorship record and the site's history join.
- **First publish.** A first publish from Carrel's key is allowed (Carrel design decision 2). Carrel decides who may trigger it.
- **Deletes.** Unpublish returns an item to draft. A delete is the separate `DELETE /content/:id` of v0.3.0, below.

## Changes in v0.3.0

Additive: every v0.2.0 route and body is unchanged, and the schema hash and package version move on purpose.

- **The source at a revision.** `GET /content/:id/revisions/:version` returns `{ id, version, source }`, so each revision in the list opens. It reads the adapter's existing `revisionSource`; `404` for an item or version the site does not hold. The client's `revision(id, version)` calls it.
- **Content delete, optional per site.** `DELETE /content/:id?expectedVersion=...&changeId=...` (a query, since a DELETE carries no body) answers `ContentDeleteResult` `{ id, deleted: true, changeId }`. A stale `expectedVersion` is `409 version-conflict` with the site's `currentVersion`; an id the site does not hold is `404 not-found`; the site's own rules refusing it is `422 refused`. A site whose adapter has no `content.delete` answers `501 not-implemented` whatever the query says, and `meta.capabilities.contentDelete` is absent, so Carrel can hide the action with the reason before anyone asks. The adapter runs the delete and whatever must follow it (a cache purge, an index) as one unit.
- **Conformance** adds the revision-source checks and, with `probeWrites`, a delete without a key, a wrong key, and a delete of the probe id (`404` where the site offers delete, `501` where it does not). It never deletes anything real.

## Changes in v0.4.0

Additive: every v0.3.0 route and body is unchanged, and the schema hash and package version move on purpose. Every new route is optional per site.

- **Alt text, tags, trash.** `PUT /media/:id/alt` `{ alt, expectedVersion, changeId }`, `PUT /media/:id/tags` `{ tags, expectedVersion, changeId }`, `POST /media/:id/trash` and `POST /media/:id/restore` `{ expectedVersion, changeId }`. Each answers `MediaWriteResult` `{ id, version, changeId }`, the file's version after the write. A file's `version` (new, optional on `MediaItem`) identifies its editable metadata, so alt, tags and trash state each move it. A stale one is `409 version-conflict` with `currentVersion`, a missing id `404`, the site's own rules `422 refused`, a malformed body `400`.
- **Tags** are lower case words joined by single hyphens, at most 32 characters, at most 12 per file. A write sets the whole set; the package sorts it and drops duplicates before the adapter sees it. `GET /media?tag=` lists the files carrying one.
- **Trash is soft delete.** A trashed file leaves the default list (`trashedAt` is set; `GET /media?trashed=only` lists the trash) and nothing is removed. Whether the file keeps being served is the site's rule: dustinedwards.info keeps serving it, so trash is not a protection for readers.
- **Empty trash.** `POST /media/trash/empty` `{ changeId }` deletes for good the trashed files, through the same adapter `delete` and reference check as `DELETE /media/:id`, one at a time. File n is recorded under `<changeId>-<n>`. It answers `{ changeId, deleted, refused, more }`: a file still used stays in the trash and is listed in `refused` with its `usedBy`. At most 100 files go per request; `more: true` means send it again.
- **Bulk.** `POST /media/bulk` `{ op, tags?, items }`, with `op` one of `trash`, `restore`, `delete`, `add-tags`, `remove-tags` and 1 to 100 items, each `{ id, expectedVersion?, changeId }` with its own change id (`expectedVersion` is required for every op but `delete`). It answers `200 { op, results }` whenever the request was well formed, with one outcome per item in order: `{ ok: true, id, changeId, version? }` or `{ ok: false, id, changeId, error, message, currentVersion?, usedBy? }` with `error` one of `not-found`, `version-conflict`, `refused`, `invalid`, `internal`. One file's refusal never stops the others. The tag ops work from the file's current tags, refused as a version conflict if its version is not the one the caller saw. A malformed request is `400` and runs nothing.
- **Optional per site.** An adapter that lacks `setAlt`, `setTags`, or `trash` with `restore` answers that route `501 not-implemented` whatever the body says, and `meta.capabilities` carries `mediaAlt`, `mediaTags` and `mediaTrash` only where true. A bulk op needs the matching adapter methods (`delete` needs only the delete every media site has).
- **Folders are not in the contract.** dustinedwards.info's media table has no folder column and its keys are content-addressed, so there is nothing for a folder route to edit. Tags carry the organising.
- **Conformance** adds, under `probeWrites`: each write on the probe id (`404` where the capability is declared, `501` where not), a malformed alt body, a bulk trash whose one unknown file must come back as that file's own `not-found` inside a `200`, a bulk tag op with no tags, and an empty-trash body outside the contract. It never trashes, restores, tags or deletes a real file.
## Changes in v0.5.0

Additive: every v0.4.0 route and body is unchanged, and the schema hash and package version move on purpose. A test (`test/contract-v0.4.0.test.ts`, against `test/fixtures/contract-v0.4.0.json` written from the v0.4.0 build) holds every v0.4.0 route and schema identical, except `Capabilities` and `Meta`, which gain one optional property.

**The mentions group, optional per site.** A site that receives webmentions lets Carrel read and moderate its queue. A site whose adapter has no `mentions` answers every `/mentions` route `501 not-implemented` whatever the request says, and `meta.capabilities.mentions` is absent.

- **A mention** is `{ id, status, sourceUrl, targetId, authorName, authorUrl, excerpt, failureReason, receivedAt, verifiedAt, decidedAt, version }`. `id` is the site's id as text (a row id such as `41`). `targetId` is the content id it is about, such as a post slug. The text fields come from a stranger and are the site's to bound, so Carrel draws them as text and never as a link.
- **Statuses:** `unverified` (received, the sender's page not fetched yet), `pending` (the link is really there, waiting for a decision), `approved` (shown on the post), `rejected` (kept, so a re-sender does not reappear as new) and `failed` (verification found no link). Only a verified mention takes a decision: the adapter refuses `decide` on an `unverified` or `failed` one with `RefusedError` (`422 refused`).
- **List.** `GET /mentions?status&cursor&limit` is newest first, filtered by one status, with an opaque cursor. Its answer carries `counts` (how many in each status, across the whole queue and not the page, so a filter can show its count) and `expiring` (how many failed and rejected mentions a sweep would remove now).
- **Decide.** `POST /mentions/:id/decide` with `{ decision: "approve" | "reject", expectedVersion, changeId }`. A decision can be changed: an approved mention can be rejected and the other way round. The answer is `{ id, status, version, changeId, purged }`, where `purged` is whether the site cleared the post's cache (`false` when that failed, `null` when there was nothing to clear). The decision stands either way; the site writes and purges as one unit and reports the purge.
- **Delete.** `DELETE /mentions/:id?expectedVersion&changeId` removes the only copy of what a stranger sent. Answer `{ id, deleted: true, changeId, purged }`.
- **Sweep.** `POST /mentions/sweep` with `{ changeId }` removes the failed and rejected mentions past the site's own retention windows (dustinedwards.info: 30 days for failed, 90 for rejected; pending and approved ones never expire) and answers `{ changeId, removed: { failed, rejected } }`. It names no version because it is not about one mention, and the windows are the site's, not the package's.
- **Versions.** A mention's `version` is opaque, like a content version, and must move whenever its status, its verification or its decision does, and not when another mention changes. A write with a version the site no longer holds is `409 version-conflict` with `currentVersion`; a missing mention is `404`. dustinedwards.info's table has no `updated_at` and no version column, so its adapter derives one: a hash of `status`, `received_at`, `verified_at` and `decided_at` (a re-send resets all three timestamps and the status, an approve or reject sets the status and `decided_at`). It checks the version and then writes with the same values in the `WHERE`, so a change between the check and the write matches no row and is reported as a conflict.
- **Conformance** adds, for every site: the list in shape (or `501` where the site has no group), writes without the key or with a wrong one refused, a decide and a delete of an id no site holds refused (`404`, or `501` without the group), and, where the site has the group, a decide with a stale version refused on the first real mention, a sweep with no change id refused (`400`, before anything is removed), and an unknown status refused. It never decides, deletes or sweeps anything real.

## Changes in v0.6.0

Additive: every v0.5.0 route and body still works as it did.

- **Mention reset, optional per site.** `POST /mentions/:id/decide` takes a third decision, `reset`, which takes an approved or rejected mention back to `pending`, with `decidedAt` cleared and a new version. It is how a decision is undone. A mention with no decision to take back is refused with the site's own words (`422 refused`). The adapter's optional `mentions.reset` serves it; a site whose adapter lacks it answers a reset `501 not-implemented`, and `meta.capabilities.mentionReset` is absent. Conformance adds a reset of the probe id: `404` where the site offers reset, `501` where it does not.

## Media (v0.2.0)

Files stay in the site's own storage and are served by the site. Carrel only lists them, uploads to them and asks for deletes, so nothing about serving an image depends on Carrel.

- **Limits are the site's.** `meta.capabilities.mediaUpload` declares `maxBytes` (at most 25 MiB) and the accepted MIME `types`.
- **Checked before the site sees a byte.** The package refuses an upload in this order, and the adapter never runs for any of them:
  1. a type the site did not declare (`400 invalid`), without reading the body;
  2. a declared or actual size over `maxBytes` (`413 too-large`), reading no further than the limit;
  3. an empty file, or a file name carrying a path (`400 invalid`);
  4. bytes that are not the declared type (`400 invalid`), for the types with a signature: PNG, JPEG, GIF, WebP, AVIF, PDF and SVG (an `<svg` element near the start, no NUL bytes). For any other type the site checks the bytes itself.
- **Upload body.** The file's own bytes, not base64 and not multipart, so a file costs its own size and no more.
- **Media ids** are the site's storage keys, with `/` between segments. A segment may not be empty, `.` or `..`, so an id is never a path out of the store.
- **Deletes are the site's reference check.** The adapter's `delete` throws `MediaInUseError(usedBy)` when anything uses the file. The package answers `422 refused` with `usedBy`, naming each use (post, title, where), and the message names them too. A delete the site could not check must be refused (`RefusedError`), never made.

Errors are `{ "error": code, "message": text }`. A refused media delete adds `usedBy`, and a version conflict adds `currentVersion`.

| Status | Code |
|---|---|
| 400 | `invalid` |
| 401 | `unauthorized` |
| 404 | `not-found` |
| 405 | `method-not-allowed` |
| 409 | `version-conflict` |
| 413 | `too-large` |
| 422 | `refused` (the site's own rules) |
| 429 | `rate-limited` |
| 501 | `not-implemented` |
| 503 | `not-configured` / `unavailable` |
| 500 | `internal` |

The **schema hash** is the SHA-256 of every schema, as JSON Schema, plus the route table. A site and Carrel agree when their hashes match.

## The adapter

A site implements `SiteAdapter` from `src/adapter.ts`:

```ts
interface SiteAdapter {
  site: { id: string; name: string; origin: string };
  content: {
    list(query: ListQuery): Promise<ContentList>;
    get(id: string): Promise<ContentDoc | null>;
    saveDraft(id: string, input: SaveDraftInput): Promise<WriteResult>;
    publish(id: string, input: PublishInput): Promise<WriteResult>;
    schedule(id: string, input: ScheduleInput): Promise<WriteResult>;
    unpublish(id: string, input: UnpublishInput): Promise<WriteResult>;
    revisions(id: string): Promise<Revision[] | null>;
    revisionSource(id: string, version: string): Promise<string | null>;
    delete?(id: string, input: { expectedVersion: string; changeId: string }): Promise<void>; // v0.3.0; omit and the route answers 501
  };
  preview: { render(input: PreviewInput): Promise<string> };
  mentions?: {                                     // v0.5.0; omit for a site with no webmentions
    list(query: MentionListQuery): Promise<MentionList>; // items, nextCursor, counts, expiring
    decide(id: string, input: { decision: "approve" | "reject"; expectedVersion: string; changeId: string }): Promise<{ status: MentionStatus; version: string; purged: boolean | null }>;
    reset?(id: string, input: { expectedVersion: string; changeId: string }): Promise<{ status: MentionStatus; version: string; purged: boolean | null }>; // v0.6.0; omit and a reset answers 501
    delete(id: string, input: { expectedVersion: string; changeId: string }): Promise<{ purged: boolean | null }>;
    sweep(input: { changeId: string }): Promise<{ failed: number; rejected: number }>;
  };
  media?: {                                        // v0.2.0; omit for a site with no media manager
    limits: { maxBytes: number; types: string[] };
    list(query: MediaListQuery): Promise<MediaList>;
    get(id: string): Promise<MediaDetail | null>;  // with usedBy, from the site's reference check
    upload(input: MediaUpload): Promise<MediaItem>; // already checked against the limits and the bytes
    delete(id: string, input: { changeId: string }): Promise<void>;
    // v0.4.0, each optional (the route answers 501 when absent). Each throws VersionConflictError,
    // NotFoundError or RefusedError, and returns the file's version after the write.
    setAlt?(id: string, input: { alt: string; expectedVersion: string; changeId: string }): Promise<{ version: string }>;
    setTags?(id: string, input: { tags: string[]; expectedVersion: string; changeId: string }): Promise<{ version: string }>;
    trash?(id: string, input: { expectedVersion: string; changeId: string }): Promise<{ version: string }>;   // with restore, or neither
    restore?(id: string, input: { expectedVersion: string; changeId: string }): Promise<{ version: string }>;
  };
}
```

An adapter signals refusals by throwing these errors:

- **`VersionConflictError(currentVersion)`:** a stale `expectedVersion`.
- **`NotFoundError`:** a missing id.
- **`RefusedError(message)`:** the site's own rules said no, such as a failed render. The writer sees the message.
- **`MediaInUseError(usedBy)`:** the file is in use; the delete is refused with each use named.

The package computes diffs, and serves the source at a revision, from `revisionSource`, so a site only has to return old source. `content.delete` throws `VersionConflictError`, `NotFoundError` or `RefusedError` like the writes.

`@dustinedwards/site-api/testing` exports `memoryAdapter()`, a conforming reference adapter held in memory, media included (its reference check scans each post's source for `/media/<id>`, as dustinedwards.info's does). `memoryAdapter({ media: false })` is a site with no media manager, `memoryAdapter({ contentDelete: false })` one with no content delete, `memoryAdapter({ mediaWrites: false })` a v0.2.0 media manager with no alt, tag or trash writes, and `memoryAdapter({ mentions: false })` one with no webmentions, and `memoryAdapter({ mentionReset: false })` a v0.5.0 mentions group with no reset. Its files carry a `version` that every metadata write moves. Its mentions are seeded with `adapter.receiveMention({ sourceUrl, targetId, status?, ... })`, as the site's endpoint would write them. Carrel's tests run against it.

## Carrel's side

- **`@dustinedwards/site-api/client`:** `createSiteClient({ baseUrl, key })`, a typed client. Every answer is checked against the contract.
- **`@dustinedwards/site-api/conformance`:** `runConformance({ baseUrl, key })`, which Carrel's health check runs against each live site. It checks:
  - the schema hash matches;
  - no key and a wrong key are refused;
  - the key is not served off the prefix;
  - an unknown route is refused;
  - the list answers in shape;
  - a stale write is refused;
  - on a site that offers media (v0.2.0): the upload limits are declared, the media list answers in shape, a delete of an id no site holds is refused, and an upload of a type no site accepts is refused;
  - on a site that offers media (v0.4.0): each media write is refused on the probe id (or answers 501 where the site lacks it), as above under Changes in v0.4.0;
  - the mentions checks of v0.5.0, listed above under Changes in v0.5.0.

  Every write it sends must be refused, so it never changes a conforming site. `probeMediaUpload: true` adds one real round trip: it uploads a 1x1 PNG of its own, reads it back, and deletes that file and no other. It is off by default.

## A site's own admin, and the content kit

The shared posts, media and mentions screens (Capsomer's `PostsList`, `MediaLibrary` and `MentionsList`) run in Carrel and in each site's own admin. Their server half lives here, so it changes in step with the contract.

- **`localClient(adapter)`** (from `@dustinedwards/site-api/client`) answers every method `createSiteClient` does, with the same types and the same `SiteApiError`. It hands each request straight to `createSiteApi`'s handler in process: no network and no configured key. Every route rule, version check, upload check and zod parse is the one Carrel's requests meet. A site's admin passes the same `SiteAdapter` it already mounts; its own sign-in guards the door, so no rate limit applies.
- **`@dustinedwards/site-api/admin`** is the content kit, server only (it holds the client, so the key never reaches a browser):
  - `loadPosts`, `loadMedia` and `loadMentions` turn one site's client into the plain view data a component renders, one page of 50. `readPostQuery`, `readMediaQuery` and `readMentionsQuery` read that query from the address.
  - `runPostsIntent`, `runMediaIntent` and `runMentionsIntent` run one posted intent (a form's `intent`, `ids` and, where the page knew them, `versions` in the same order), each item its own write with the version the person saw and a fresh change id. One item failing never stops the rest. Each returns an `IntentResult`: `ok`, one sentence, an outcome per item, the item that hit a version conflict, and `undo`, the inverse intent with the versions its writes made.
  - `summary(source)` counts what waits on one site (mentions waiting, posts the host has something waiting on), for an inbox line.
- **The host supplies a `ContentSource`:** the site, its client (`createSiteClient` in Carrel, `localClient` in the site), what this person `can` do (`edit`, `publish`, `deleteContent`, `deleteMedia`, `decideMentions`), `editorHref`, and optional `postIndex`, `notes`, `waiting`, `hold`, `taken` and `record` hooks. The kit refuses an intent the person may not run whatever the form says, before the site is asked anything; a post that is not a draft needs `publish` for any write.
- **Undo.** Tag add and remove undo on the items that changed, and only those. Unpublish undoes by publishing again, and only a post that has been public before (`publishedAt` set): never a first publication, which is made from the editor. A post that was only scheduled has no Undo. Duplicate undoes by deleting the copy at the version the duplicate made, only where the site offers `contentDelete` and the person may delete; otherwise the message says how to remove the copy. Media trash and restore undo each other, a tag set puts back the set it held. Approve and reject undo each other between approved and rejected. A decision on a waiting mention undoes by `reset` where the site offers it (v0.6.0), and the Undo of a reset is the decision it took back; on a site without reset it has no Undo. When the chosen mentions would need different inverses, there is no single Undo and the message says so. An Undo is a new write with its own change id and the version the action made, so if someone changed the item since, it is refused as a conflict and never retried.
- **Until the contract carries them** the kit keeps Carrel's ways: post tags are rewritten in the frontmatter (a post without frontmatter is refused), and the kind filter and sort work on the page the site sent (`page.sortedOnPage`). A media delete on a site with a trash is only from the trash.

Tested once, where it lives: `test/admin.test.ts`, against `memoryAdapter()` through `localClient`, and once through `createSiteClient` as Carrel drives it.

## Development

```sh
npm install
npm run typecheck
npm test
```

Tests run locally, with no Actions minutes. The planted tests send a request each guard must refuse, and each also checks that the adapter never ran:

- `test/planted.test.ts`: the key off its prefix, a wrong key, a stale `expectedVersion`, an unknown route.
- `test/admin.test.ts`: the content kit refusing what the person may not run, a live post for someone who may not publish, a stale Undo, a first publication by Undo, an id that could not be a post, a host's hold, a media delete outside the trash, and an upload over the site's limits, each before the site is asked.
- `test/media.test.ts`: a file a post uses (refused with the post named), an oversized or undeclared upload, bytes that are not their type, an id that climbs out.
- `test/media-writes.test.ts`: alt, tags, trash, restore, empty trash and bulk, with stale versions, files in use, the 100-file limits and a site without the writes.
- `test/mentions.test.ts`: a stale version, a missing mention, a site with no mentions, the site's own refusal, a missing key or a bad body for every mentions write, and the sweep route not read as a mention id.
- `test/contract-v0.4.0.test.ts`: the v0.4.0 contract unchanged, against `test/fixtures/contract-v0.4.0.json`; only the four mentions routes and one optional capability are new.
- `test/contract-v0.1.0.test.ts`: the v0.1.0 contract unchanged, against `test/fixtures/contract-v0.1.0.json`, written from the v0.1.0 build. Every v0.1.0 route and schema is identical, except three schemas that gain optional properties only (`Meta`, `Capabilities`, `ErrorBody`).
