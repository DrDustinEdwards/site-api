# site-api

The standard site API every Dustin Edwards site includes so Carrel can list, edit and publish its content. No keys or content live here.

Each site mounts one handler at `/api/carrel/v1` and implements an adapter over its own storage and render. Carrel talks to every site through the same contract, with one key per site.

## Install

Installed by git tag, never from a registry:

```sh
npm install github:DrDustinEdwards/site-api#v0.18.0
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

if (api.matches(request)) return api.handle(request, ctx);
```

Every Carrel site tells search engines when a page changes, through the IndexNow publish hook over Prelum's `submitIndexNow` (the site serves its key file with Prelum's `keyFileResponse`), and applies its schedules from a cron:

```ts
import { createSiteApi, indexNowHook } from "@dustinedwards/site-api";
import { submitIndexNow } from "@drdustinedwards/site-helpers/indexnow";

const api = createSiteApi({
  // ...as above
  hooks: [indexNowHook({ submit: submitIndexNow, origin: SITE_ORIGIN, key: INDEXNOW_KEY })],
});

export default {
  fetch(request, env, ctx) { /* ...as above */ },
  // wrangler.jsonc: "triggers": { "crons": ["* * * * *"] }
  scheduled(controller, env, ctx) {
    ctx.waitUntil(api.runSchedules({ now: new Date(controller.scheduledTime) }));
  },
};
```

From v0.17.0 a site with D1 also passes the package a store, for safe retries, preview links, hook retries and the webmentions it sends (Changes in v0.17.0):

```ts
import { webmentionHook } from "@dustinedwards/site-api";
import { d1SiteApiStore } from "@dustinedwards/site-api/store";

const store = d1SiteApiStore(env.DB);              // migration: SITE_API_STORE_SQL
const api = createSiteApi({
  // ...as above
  store,
  hooks: [indexNowHook({ /* ... */ }), webmentionHook({ store })],
});

// in fetch, before the handler:
if (api.matchesPreviewLink(request)) return api.servePreviewLink(request);
```

**`onPageChange` is deprecated** in favor of `hooks: [indexNowHook(...)]`. A v0.9.0 site's `onPageChange: (paths, request) => submitIndexNow(...)` still works, and from v0.10.0 it also hears the pages a schedule changes, but it will be removed in a later breaking release; move to the hook.

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
| content | `GET /content?status&q&sort&dir&kind&tag&author&publishedAfter&publishedBefore&trashed&cursor&limit` | | `ContentList`, with `total` and `sorted` where the site gives them (`sort` and `dir` are v0.6.0; the filters and `trashed` v0.17.0) |
| content | `GET /content/:id` | | `ContentDoc`: summary, markdown source, version |
| content | `PUT /content/:id/draft` | `SaveDraftInput` | `WriteResult` |
| content | `POST /content/:id/publish` | `PublishInput` | `WriteResult` |
| content | `POST /content/:id/schedule` | `ScheduleInput` | `WriteResult`; on a live item, a scheduled update (v0.10.0) |
| content | `GET /content/:id/schedule` | | `ScheduledUpdate`: the update waiting on a live item, with its source (v0.10.0, optional per site) |
| content | `DELETE /content/:id/schedule?expectedVersion&changeId` | | `WriteResult` (v0.10.0, optional per site) |
| content | `POST /content/:id/unpublish` | `UnpublishInput` | `WriteResult` |
| content | `GET /content/:id/revisions` | | `RevisionList`, newest first |
| content | `GET /content/:id/diff?from&to` | | `Diff`: a unified patch; `to` defaults to current |
| content | `GET /content/:id/revisions/:version` | | `RevisionSource`: the source as it was at that version (v0.3.0) |
| content | `DELETE /content/:id?expectedVersion&changeId` | | `ContentDeleteResult` (v0.3.0, optional per site: `501` where the adapter has no `delete`) |
| content | `PUT /content/:id/tags` | `ContentTagsInput` | `WriteResult` (v0.6.0, optional per site: `501` where the adapter has no `setTags`) |
| content | `POST /content/:id/rename` | `RenameInput` | `RenameResult` (v0.17.0, optional per site) |
| content | `POST /content/:id/trash` | `ContentTrashInput` | `WriteResult` (v0.17.0, optional per site) |
| content | `POST /content/:id/restore` | `ContentTrashInput` | `WriteResult`, always a draft (v0.17.0, optional per site) |
| preview | `POST /preview` | `PreviewInput` | the full page HTML from the site's own pipeline |
| preview | `POST /preview-links` | `PreviewLinkInput` | `201 PreviewLink` (v0.17.0, with a store) |
| preview | `GET /preview-links?id` | | `PreviewLinkList` (v0.17.0, with a store) |
| preview | `DELETE /preview-links/:linkId?changeId` | | `PreviewLinkRevokeResult` (v0.17.0, with a store) |
| media | `GET /media?q&tag&trashed&lens&sort&dir&orientation&kind&cursor&limit` | | `MediaList` (`tag` and `trashed=only` are v0.4.0; `lens`, `sort`, `dir`, `total` and `sorted` v0.6.0; `orientation`, `kind` and `changeCursor` v0.13.0) |
| media | `GET /media?changedSince&limit` | | `MediaList` of the files changed since, with `removed` and `moreChanges` (v0.13.0, optional) |
| media | `POST /media?filename&alt&resize&changeId` | the file's own bytes, typed by `Content-Type` | `201 MediaUploadResult`, or `200` with `duplicateOf` (`resize` and the answer's extras are v0.13.0) |
| media | `POST /media/import` | `MediaImportInput` | `201 MediaUploadResult`, or `200` with `duplicateOf` (v0.13.0, optional) |
| media | `GET /media/:id` | | `MediaDetail`: the file and every place it is used |
| media | `DELETE /media/:id?changeId` | | `MediaDeleteResult`, or `422 refused` naming each use |
| media | `PUT /media/:id/alt` | `MediaAltInput` | `MediaWriteResult` (v0.4.0, optional) |
| media | `PUT /media/:id/tags` | `MediaTagsInput` | `MediaWriteResult` (v0.4.0, optional) |
| media | `PUT /media/:id/focus` | `MediaFocusInput` | `MediaWriteResult` (v0.10.1, optional) |
| media | `PUT /media/:id/caption` | `MediaCaptionInput` | `MediaWriteResult` (v0.10.1, optional) |
| media | `PUT /media/:id/file?filename&expectedVersion&changeId` | the new bytes, typed by `Content-Type` | `MediaReplaceResult` (v0.10.1, optional) |
| media | `PUT /media/:id/credit` | `MediaCreditInput` | `MediaWriteResult` (v0.13.0, optional) |
| media | `POST /media/:id/transform` | `MediaTransformInput` | `MediaTransformResult` (v0.13.0, optional) |
| media | `GET /media/:id/history` | | `MediaHistory`: the file's bytes, newest first (v0.13.0, optional) |
| media | `POST /media/:id/revert` | `MediaRevertInput` | `MediaTransformResult` (v0.13.0, optional) |
| media | `GET /media/:id/suggestions` | | `MediaSuggestions`: the site's model's tags and alt text, never applied (v0.13.0, optional) |
| media | `POST /media/:id/trash` | `MediaTrashInput` | `MediaWriteResult` (v0.4.0, optional) |
| media | `POST /media/:id/restore` | `MediaTrashInput` | `MediaWriteResult` (v0.4.0, optional) |
| media | `POST /media/trash/empty` | `MediaTrashEmptyInput` | `MediaTrashEmptyResult` (v0.4.0, optional) |
| media | `POST /media/bulk` | `MediaBulkInput` | `MediaBulkResult` (v0.4.0, optional) |
| media | `POST /media/resize-pass` | `MediaResizePassInput` | `MediaResizePassResult`, one outcome per file (v0.13.0, optional) |
| mentions | `GET /mentions?status&q&targetId&cursor&limit` | | `MentionList` with the whole queue's `counts` and what a sweep would remove (v0.5.0, optional per site) |
| mentions | `POST /mentions/:id/decide` | `MentionDecideInput` | `MentionWriteResult` (v0.5.0) |
| mentions | `DELETE /mentions/:id?expectedVersion&changeId` | | `MentionDeleteResult` (v0.5.0) |
| mentions | `POST /mentions/sweep` | `MentionSweepInput` | `MentionSweepResult` (v0.5.0) |
| insight | `GET /insight/not-found?days&limit&includeProbes` | | `NotFoundReport`: the site's most-hit missing paths and who linked to them (v0.16.0, optional per site) |
| inbox, insight, publications | `/*` | | `501` until their stage |

The media group arrived in v0.2.0. A site whose adapter has no `media` still answers it `501`, as in v0.1.0.

Every write carries an `expectedVersion` and a Carrel `changeId`.

- **`expectedVersion`** is opaque to Carrel, and each site decides what a version is. It should identify the item's own content, so that a write to one item never makes another look changed. dustinedwards.info uses the git blob sha of the item's own file, so only a change to that item moves it. On a save, `null` means create, and the id must be free.
- **Refusals.** A stale version is refused with `409 version-conflict` and the site's `currentVersion`. A version given for an id that does not exist is refused the same way, with a null `currentVersion`.
- **`changeId`** goes into the site's commit or row, so Carrel's authorship record and the site's history join.
- **First publish.** A first publish from Carrel's key is allowed (Carrel design decision 2). Carrel decides who may trigger it.
- **Deletes.** Unpublish returns an item to draft. A delete is the separate `DELETE /content/:id` of v0.3.0, below.

**Revisions.** A site keeps every revision of every item and never prunes them, least of all the live one: `revisions` lists them all and `revisionSource` opens each, so any publish can be undone and every diff can be made. A rename moves the history with the item; only a delete, or the trash emptying itself, removes it.

## Errors

Every error answer is `application/problem+json` (RFC 9457, v0.17.0): `{ error, message, type, title, status, detail }`. `error` and `message` are what every earlier reader reads; `type` is this table's anchor for the code, `title` the code's fixed title, `status` the HTTP status and `detail` the message again. A version conflict adds `currentVersion`, and a refused media delete `usedBy`.

| Code | Status | Title | When |
|---|---|---|---|
| <a id="error-unauthorized"></a>`unauthorized` | 401 | Unauthorized | No key, or not the site's key. Every route, known or not, answers this to a caller without the key. |
| <a id="error-rate-limited"></a>`rate-limited` | 429 | Too many requests | The caller's address spent the site's limit. |
| <a id="error-not-configured"></a>`not-configured` | 503 | Not configured | The site's key is unset or shorter than 32 characters. |
| <a id="error-unavailable"></a>`unavailable` | 503 | Unavailable | The rate limiter failed, so the request was refused. |
| <a id="error-not-found"></a>`not-found` | 404 | Not found | No such route, id or version. |
| <a id="error-method-not-allowed"></a>`method-not-allowed` | 405 | Method not allowed | The route exists, but not with this method. |
| <a id="error-invalid"></a>`invalid` | 400 | Invalid request | The body or query is outside the contract. |
| <a id="error-too-large"></a>`too-large` | 413 | Too large | The body or file is over the limit. |
| <a id="error-version-conflict"></a>`version-conflict` | 409 | Version conflict | `expectedVersion` is not what the site holds; `currentVersion` says what it does (null: no such id). |
| <a id="error-in-progress"></a>`in-progress` | 409 | In progress | A write under this change id is still running (v0.17.0, on a site with `replay`). Send it again once it has answered. |
| <a id="error-refused"></a>`refused` | 422 | Refused | The site's own rules said no; the message says why. |
| <a id="error-not-implemented"></a>`not-implemented` | 501 | Not implemented | The site does not offer this route, query or option; `meta.capabilities` says so beforehand. |
| <a id="error-internal"></a>`internal` | 500 | Internal error | The site failed, or answered outside the contract. Logged on the site; nothing of it is passed on. |

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
- **Folders are not in the contract.** dustinedwards.info's media table has no folder column and its keys are content-addressed, so there is nothing for a folder route to edit. Tags carry the organizing.
- **Conformance** adds, under `probeWrites`: each write on the probe id (`404` where the capability is declared, `501` where not), a malformed alt body, a bulk trash whose one unknown file must come back as that file's own `not-found` inside a `200`, a bulk tag op with no tags, and an empty-trash body outside the contract. It never trashes, restores, tags or deletes a real file.

## Changes in v0.5.0

Additive: every v0.4.0 route and body is unchanged, and the schema hash and package version move on purpose. Every v0.4.0 route and schema is identical in v0.5.0, except `Capabilities` and `Meta`, which gain one optional property; `test/contract-v0.5.0.test.ts` holds the v0.5.0 contract, and with it v0.4.0's.

**The mentions group, optional per site.** A site that receives webmentions lets Carrel read and moderate its queue. A site whose adapter has no `mentions` answers every `/mentions` route `501 not-implemented` whatever the request says, and `meta.capabilities.mentions` is absent.

- **A mention** is `{ id, status, sourceUrl, targetId, authorName, authorUrl, excerpt, failureReason, receivedAt, verifiedAt, decidedAt, version }`. `id` is the site's id as text (a row id such as `41`). `targetId` is the content id it is about, such as a post slug. The text fields come from a stranger and are the site's to bound, so Carrel draws them as text and never as a link.
- **Statuses:** `unverified` (received, the sender's page not fetched yet), `pending` (the link is really there, waiting for a decision), `approved` (shown on the post), `rejected` (kept, so a re-sender does not reappear as new) and `failed` (verification found no link). Only a verified mention takes a decision: the adapter refuses `decide` on an `unverified` or `failed` one with `RefusedError` (`422 refused`).
- **List.** `GET /mentions?status&cursor&limit` is newest first, filtered by one status, with an opaque cursor. Its answer carries `counts` (how many in each status, across the whole queue and not the page, so a filter can show its count) and `expiring` (how many failed and rejected mentions a sweep would remove now).
- **Decide.** `POST /mentions/:id/decide` with `{ decision: "approve" | "reject", expectedVersion, changeId }`. A decision can be changed: an approved mention can be rejected and the other way round. The answer is `{ id, status, version, changeId, purged }`, where `purged` is whether the site cleared the post's cache (`false` when that failed, `null` when there was nothing to clear). The decision stands either way; the site writes and purges as one unit and reports the purge.
- **Delete.** `DELETE /mentions/:id?expectedVersion&changeId` removes the only copy of what a stranger sent. Answer `{ id, deleted: true, changeId, purged }`.
- **Sweep.** `POST /mentions/sweep` with `{ changeId }` removes the failed and rejected mentions past the site's own retention windows (dustinedwards.info: 30 days for failed, 90 for rejected; pending and approved ones never expire) and answers `{ changeId, removed: { failed, rejected } }`. It names no version because it is not about one mention, and the windows are the site's, not the package's.
- **Versions.** A mention's `version` is opaque, like a content version, and must move whenever its status, its verification or its decision does, and not when another mention changes. A write with a version the site no longer holds is `409 version-conflict` with `currentVersion`; a missing mention is `404`. dustinedwards.info's table has no `updated_at` and no version column, so its adapter derives one: a hash of `status`, `received_at`, `verified_at` and `decided_at` (a re-send resets all three timestamps and the status, an approve or reject sets the status and `decided_at`). It checks the version and then writes with the same values in the `WHERE`, so a change between the check and the write matches no row and is reported as a conflict.
- **Conformance** adds, for every site: the list in shape (or `501` where the site has no group), writes without the key or with a wrong one refused, a decide and a delete of an id no site holds refused (`404`, or `501` without the group), and, where the site has the group, a decide with a stale version refused on the first real mention, a sweep with no change id refused (`400`, before anything is removed), and an unknown status refused. It never decides, deletes or sweeps anything real.

## Changes in v0.18.0

Additive: no route, body or schema changes. The media suggester (`mediaSuggester`) hardened, and site-runtime moves to v0.46.0.

- **The gateway id** comes from site-runtime's `anthropicRoute`: read from a standard `AI_GATEWAY_BASE_URL`, else from the new `SuggestEnv.AI_GATEWAY_ID` (for a gateway on a custom domain). A gateway it cannot use (no id, or a malformed URL) is warned about and skipped: the call goes to Workers AI without it, and never fails the suggestion.
- **JSON mode and a timeout.** The model is asked for `response_format` `json_schema` (the tags and alt text), and the call stops after 30 seconds (`AbortSignal.timeout`). `readSuggestion` still reads an object or a JSON string.
- **The prose check.** Alt text with a high or critical finding from site-runtime's `checkProse` (a leftover "As an AI language model") comes back as `alt: null`; the tags are kept.

## Changes in v0.17.0

Additive: every v0.16.0 route and body still works as it did, and the schema hash moves on purpose. Every new route, capability and option is optional per site: a site whose adapter or config lacks it answers its route or option `501 not-implemented`, and `meta.capabilities` says which it has, so a v0.16.0 adapter compiles and runs unchanged. `test/v0.17.0.ts` names every addition, which each `test/contract-v*.test.ts` checks against its fixture: optional properties, the `in-progress` code at the end of `ErrorCode`, ten schemas and six routes. Two types gain a member a site only reads: `ScheduleRun` (`emptied`, `retried`) and `PublishAction`.

- **Errors** are problem details (`application/problem+json`, RFC 9457), keeping `error` and `message`; see Errors above. One new code, `in-progress`.
- **Safe retries by change id** (`capabilities.replay`). A site that passes `createSiteApi` a `store` makes every write under content, media and mentions safe to send again. Before a write runs, the package claims its `changeId` with the route and a hash of the query and body (an upload's bytes included). The same request again answers exactly what the first answered, with `Idempotent-Replayed: true`, and the adapter does not run; while the first is still running it answers `409 in-progress`; the same change id on a different request is `422 refused`. Successes, `409` and `422` answers are kept for 7 days (`runSchedules` prunes older ones); any other failure frees the change id, so a retry runs again. A claim still running after two minutes was left by a request that died, and a retry of the same request takes it over. On D1:

  ```ts
  import { d1SiteApiStore } from "@dustinedwards/site-api/store";
  const api = createSiteApi({ /* ...as above */ store: d1SiteApiStore(env.DB) });
  ```

  `SITE_API_STORE_SQL` from the same module is the migration, the site's next `migrations/` file. Another store implements `SiteApiStore`. Without a store, a write is handled exactly as in v0.16.0.

- **Post fields** (`capabilities.postFields`), beside the search fields and kept the same way, in the frontmatter as JSON literals: `excerpt`, `authors` (display names in credit order, the first the primary author, written as a JSON array so a name may hold a comma), `series` and `seriesPart` (a positive whole number). `@dustinedwards/site-api/frontmatter` exports `POST_FIELDS`, `postFieldsOf(front)` and `setPostFields(front, values)`; a blank value removes the key. A site names the ones it renders in `ContentAdapter.postFields`, and the search fields it renders in `ContentAdapter.searchFields`. List rows may carry `authors` and `excerpt`, filled from the frontmatter, and a revision may carry `authors`, everyone credited for that version (`author` stays).
- **The render version** (`capabilities.render`): `SiteAdapter.renderVersion` is the Prelum `RENDER_VERSION` the site's stored HTML was rendered with, so Carrel sees a site that is behind. A site passes `RENDER_VERSION` from `@drdustinedwards/site-helpers/render/nomath`.
- **Rename with a redirect** (`capabilities.contentRename`). `POST /content/:id/rename` `{ newId, expectedVersion, changeId }` moves the item, its history with it, and answers `RenameResult`: the write under the new id with `previousPath`, the old public path, which now answers a permanent (301) redirect to the new one, or `null` for an item never published. A taken `newId` is `422 refused`. The adapter's `rename` makes the move and the redirect one unit; the publish hooks hear `rename` with the old path and address (below).
- **A content trash** (`capabilities.contentTrash`, only where the adapter has `trash`, `restore` and `delete`). `POST /content/:id/trash` and `POST /content/:id/restore` `{ expectedVersion, changeId }` answer `WriteResult`. Trashing a live post takes it off the site first, in the same unit; a restore always answers a draft and never republishes. Rows carry `trashedAt` (null when not trashed). The list never shows trashed items unless asked, `GET /content?trashed=true`, which lists only them (`501` without the trash). `runSchedules` deletes, through the adapter's `delete` with the listed version and the change id `trash-expired-<id>`, items trashed more than `TRASH_DAYS` (30) days ago, at most its limit per pass, and counts them in `emptied`.
- **List filters on the site** (`capabilities.contentFilters`, any of `kind`, `tag`, `author`, `published` and `trashed`). `GET /content` takes `kind`, `tag`, `author` (one of the item's authors), `publishedAfter` and `publishedBefore` (either or both, the `published` filter) and `trashed`, and answers `ContentList` with the filters it applied in `filtered`. An older site drops a filter it does not know and lists everything, so the client refuses an answer without one it asked for as `501` (a trash view never shows live posts). The adapter names what it applies in `ContentAdapter.filters`; the package answers any other `501` before the adapter runs (`trashed` comes with the trash). `q` matches the title and the body, and without `sort` answers the newest updated first; every site's list does the same.
- **Events and hooks.** The publish hooks' `action` gains `trash`, `restore`, `rename`, `schedule` and `unschedule`, and the event carries `previousStatus` and `status` and, on a rename, `previousPath` and `previousUrl`. A hook may name the actions it hears, `on: ["trash", "restore"]`; one with no `on` hears what it heard before, the actions that change a public page (`PAGE_ACTIONS`: a publish, an update of a live post, an unpublish, and a delete, trash or rename of a live post). A plain `{ name, run }` hook works unchanged. `indexNowHook` sends both addresses of a rename. With a `store`, a hook that fails is kept (`hook_retries`) and `runSchedules` runs it again after 1, 5, 30, 120 and 720 minutes (`HOOK_BACKOFF_MINUTES`), then logs `hook-gave-up` and drops it; the pass counts them in `retried`. A retried event has no `request`.
- **A first publish by time.** A site whose scheduled post goes live by the clock alone, with no write (dustinedwards.info), must still list it in `SchedulesAdapter.due` as kind `publish`, with `apply` answering its `WriteResult` without writing, so the hooks hear it go live. Once applied it leaves `due`.
- **Shareable preview links** (`capabilities.previewLinks`, with a store). `POST /preview-links` `{ id, hours?, changeId }` (1 to 168 hours, 48 by default) answers `201 { token, url, expiresAt }`: the token is 32 random bytes, base64url, answered this once, and the site keeps only its SHA-256 (`preview_links`). `GET /preview-links?id=` lists an item's working links as `{ id, createdAt, expiresAt }`, `id` being the first 12 hex characters of the hash, which revokes the link and cannot open it: `DELETE /preview-links/:linkId?changeId=`. Anyone with the `url`, `GET {origin}/preview/<token>` outside the prefix and with no key, sees the item's current source through the site's own `preview.render`, with `x-robots-tag: noindex, nofollow`, `cache-control: private, no-store` and `referrer-policy: no-referrer`; an expired or revoked link, or one whose item is in the trash, answers a small `410` page, any other `404`. Preview-link writes are not replayed, since their answer holds the token and the store never keeps one: a retried create makes a second link. It is rate limited like the API. The site mounts it beside the handler:

  ```ts
  if (api.matchesPreviewLink(request)) return api.servePreviewLink(request);
  if (api.matches(request)) return api.handle(request, ctx);
  ```

- **Sending webmentions.** `webmentionHook({ store, fetch?, userAgent?, log? })` is a publish hook (`hooks: [webmentionHook({ store })]`, the same `store` the site passes `createSiteApi`) that hears a publish, an update, an unpublish, a delete, a trash and a rename. While the page is live it reads it and takes the outbound http(s) links inside its first `.h-entry .e-content`, or else its `<article>`, or else its `<main>` (links on the site's own origin left out); it sends a webmention, `source` and `target` form-encoded, to each of them and to each it sent last time (`webmention_targets`), so a removed link is heard too, and keeps the new set. Once the page is not live, it sends to the last set, and a rename sends for the old address as gone. Each target's endpoint is found from its HTTP `Link` header, then the first `<link>` or `<a>` with `rel="webmention"`, resolved against the page. Every address is checked first and at each of at most 5 redirects: http or https only, never localhost, loopback, private, link-local or `.local` hosts; each fetch has 5 seconds and reads at most 1 MB. One target failing is logged (`webmention`, with its result) and never stops the rest; a page that cannot be read fails the hook, and the store retries it. A deleted post's address should answer `410 Gone`, which the site's own routes do, so a receiver that checks the source drops the mention.
- **Conformance** adds, for every site: error answers are problem details with `type`, `title` and `status`; a preview of a tiny source answers `text/html` that says `noindex` (the package now sends `x-robots-tag: noindex, nofollow` on every preview); a list filter the site does not offer answers `501`; and with `probeWrites`, a publish of the probe id is refused, a publish with a future `publishedAt` is `400` (`501` without `contentPublishedAt`), a rename, trash and restore of the probe id and a preview link for it are `404` (`501` without the capability), and, where the site has `replay`, a stale write sent twice under one change id answers the same `409` twice, the second replayed. Every probe write now carries its own change id, so a site's replay store never sees one id on two requests.
- **The live check.** `site-api-live --origin https://example.com [--from <host>]` (the package's `bin`, plain Node with no build) is devkit's keyless probe of a deployed site: `/api/carrel/v1/meta` answers `401` problem details with `cache-control: no-store` (K4, K2), an unknown route under the prefix answers exactly the same (K4, no route leak), and an unknown `/preview/<token>` answers `404` with `noindex` (E2; a `404` without it is a warning, the site has not mounted preview links yet). Each finding is a GitHub annotation, `::error title=<item>::<url> <detail>` or `::warning ...`; it exits 0 when clean, 1 on any error, 2 when it could not run. `--from` names the run in the probes' user agent.
- **The posts kit** (Capsomer 0.52.0's PostsList). `readPostQuery` reads `author`, `from` and `to` (whole days, both included) and `trashed=1`; `loadPosts` sends each to the site where `contentFilters` names it (kind and tag still filter the page on a site that does not), counts the Trash in `counts.trash`, gives rows `authors`, `excerpt` and `trashedAt`, and offers `trash`, `rename`, `previewLinks`, `filters` and the page's `authors`. A filtered list comes from the site, never a host's `postIndex`. `runPostsIntent` adds `trash` and `restore` (each the other's Undo; a live post needs `publish`), `rename` with `newId` (one post; a live one needs `publish`; Undo renames it back) and `preview-link` (one post; `IntentResult.previewLink` is `{ url, expiresAt }`, shown once). Where the site has a trash, `delete` deletes for good only a post already in it, and a duplicate's Undo trashes the copy.
- **A settable publish date** (`capabilities.contentPublishedAt`). `POST /content/:id/publish` takes an optional `publishedAt`: a first publish backdated, or a live post re-dated. A date in the future is `400 invalid`, since that is a schedule. A site whose adapter does not set `publishedAtSettable: true` answers a publish carrying it `501`; one without it publishes as before.

## Changes in v0.16.0

Additive: every v0.15.0 route and body is unchanged, and the schema hash and package version move on purpose. `Capabilities` gains `insightNotFound`, and `insight` is now true for a site that offers the group. `test/contract-v0.5.0.test.ts` and `test/contract-v0.12.0.test.ts` hold the rest identical.

**The 404 report, the insight group's first route, optional per site.** `GET /insight/not-found?days&limit&includeProbes` answers `NotFoundReport` `{ rows }`, each row `{ path, kind, hits, referrers: [{ host, hits }] }`: the site's most-hit missing paths of the last `days` UTC days, today included, most hits first, at most `limit`, with the hosts that linked to each ("" for no referrer). `kind` is `probe` for a path an exploit scanner guesses and `page` otherwise; probes are left out unless `includeProbes=true`. `days` is 1 to 90 (default 30, and 90 is what site-runtime's `pruneNotFound` keeps), `limit` 1 to 200 (default 50); anything else is `400` before the adapter runs. The rows are site-runtime's `notFoundReport` (`./not-found`, v0.42.0), so a site that counts its 404s with `countNotFound` wires it in one line:

```ts
import { notFoundReport } from "@dustinedwards/site-runtime/not-found";
const adapter = { ...rest, insight: { notFound: (options) => notFoundReport(env.DB, options) } };
```

A site whose adapter has no `insight` answers `501 not-implemented`, and `meta.capabilities.insightNotFound` is absent. The client's `insight.notFound({ days?, limit?, includeProbes? })` calls it. Conformance adds, for every site, the report in shape and within its limit (or `501` where the site has none) and, where it has one, `days=91` refused. The reference adapter takes `notFound: NotFoundRow[]`.

## Changes in v0.15.0

Additive: no route, body or schema changes. The upload step every site's media adapter wrote for itself, exported from the package root, so each site's `upload` shrinks to one call and its own copies of the EXIF reader, `bufferOf`, the shrink and the placeholder go. site-runtime moves to v0.34.0, and the package's hex and hashes are its `./encoding` (`toHex`, `sha256Hex`).

- **`prepareUpload(images, input, { resize?, limits? })`**, for an adapter's `upload(input)`, with the site's Images binding. In order: the site's `limits` where given (a site's own upload path, which the package's route did not check: type, size, signature, as `RefusedError`); the embedded metadata, read first because every re-encode by the binding drops it; a HEIC or HEIF converted to JPEG through the binding (which applies the EXIF orientation and keeps only the copyright), its name ending `.jpg`; the location taken out of what is not re-encoded (`stripLocation`); the shrink to `resize.maxEdge` at `resize.quality` where the upload has `resize: true` (so `resize=no` keeps its size), through site-runtime's `editImage` in the picture's own type (JPEG, PNG, WebP and AVIF; a GIF may be animated and is left alone); the size; the placeholder and main color; and the hashes. It answers `PreparedUpload`: `bytes`, `contentType`, `filename`, `width`, `height`, `sha256` (of the stored bytes), `uploadSha256` (of the bytes as sent, which the route asked `findByHash` about), `embedded`, `converted`, `located`, `placeholder`, `color`, and, where it shrank, `resizedFrom` and `original` (the bytes before the shrink, without a location, for the site's backup and history). `UploadImages` is the binding's shape: site-runtime's `ImagesLike` and `info`.
- **Placeholder and main color**, the contract's `placeholder` and `color` for every site, which only dustinedwards.info made (its placeholder alone, 20 pixels wide). `placeholder` is the stored picture as a blurred WebP inside 16 by 16 pixels, a base64 `data:` URI within `MAX_PLACEHOLDER_CHARS`; `color` is that placeholder squeezed to one pixel as a PNG, read in the Worker (`DecompressionStream`), as `#rrggbb`. Two binding transforms, each billed, the second from the placeholder's few bytes; `info` is free. Both are `null` for a file the binding cannot measure (an SVG, so no transform is spent), where a transform fails or for a fully transparent pixel, and `color` is `null` without a placeholder. A site stores them on the file's row and answers them on its `MediaItem`. `placeholderAndColor(images, bytes)` is the same step alone, for a rebuild that fills files stored before.
- **`stripLocation(bytes, contentType)`**: a photo without where it was taken, lossless. The GPS IFD of a JPEG's EXIF, a PNG's eXIf and a WebP's EXIF is unlinked and zeroed where it lies, so no other offset moves; GPS properties (`exif:GPSLatitude` and the rest, attributes or elements) leave a JPEG's XMP segment, a PNG's uncompressed XMP iTXt and a WebP's XMP chunk, with the segment length, chunk CRC and RIFF size rewritten. Orientation, the color profile, copyright and the pixels stay. Bytes with no location, of another type or too malformed to walk come back as the same array, and the input is never written to. Not covered: compressed XMP in a PNG, a JPEG's extended XMP and a thumbnail's own metadata.
- **`readEmbedded(bytes, contentType)`**: the four fields (`credit` from the artist or Author, `license` from the copyright, `caption` from the description, `takenAt` with its offset where the file has one) as `EmbeddedFields`, from a JPEG's or a WebP's EXIF, a PNG's eXIf and text chunks, and a HEIC's or a HEIF's Exif item. dustinedwards.info's reader, which five sites had copied, with the PNG eXIf and HEIF reading added.
- **HEIC and HEIF uploads.** `image/heic` and `image/heif` have signatures (an ISO `ftyp` box naming a HEIC brand, or for HEIF also `mif1` or `msf1`), so a site that lists them in `limits.types` takes iPhone photos and stores them as JPEG through `prepareUpload`.

## Changes in v0.14.0

Additive: no route, body or schema changes. The pieces every site's media adapter and preview wrote for itself, exported from the package root, and site-runtime moves to v0.29.0 (its `editImage`).

- **Versions.** `mediaVersion(rev)` is a file's version, `r` and its index row's rev; `mediaRev(version)` reads it back, or -1 (which no row holds) for anything else; `MEDIA_VERSION_PATTERN` is the pattern.
- **Writes.** `MediaWrite` is one versioned write's outcome: `{ ok: true, rev, changed? }`, `{ ok: false, reason: "missing" }`, `{ ok: false, reason: "stale", rev }` or `{ ok: false, reason: "refused", message }`. `answerWrite(write)` answers `{ version }` or throws `NotFoundError`, `VersionConflictError` (with the row's version) or `RefusedError`, which the handler answers 404, 409 and 422.
- **`toArrayBuffer(bytes)`**: a fresh ArrayBuffer of a view's bytes, for R2 and the Images binding, never `bytes.buffer`, which may be larger.
- **AI suggestions.** `mediaSuggester({ app, describe, rules?, beforeCall?, afterCall? })` returns `suggest(env, picture, id?)`, the suggester behind an adapter's `suggest`: a 768px JPEG through site-runtime's `editImage`, shown to Workers AI (`SUGGEST_MODEL`, Llama 4 Scout, in JSON mode, at most 300 tokens and 30 seconds) through the site's AI Gateway when `AI_GATEWAY_BASE_URL` names one (site-runtime's `anthropicRoute` reads the id from it, or from `AI_GATEWAY_ID` for a custom domain; bodies are not logged and `app` names the site on each entry). A gateway it cannot use is warned about and skipped, never a failed suggestion. Alt text with a high finding from site-runtime's `checkProse` comes back as `alt: null`. `describe` finishes "one picture ..." ("on a scientist's personal website"), `rules` adds the site's own sentences, `beforeCall(env, id)` may throw to stop the call before the model runs (a daily cost cap), and `afterCall(env, { model, promptTokens, completionTokens }, id)` meters it. `env` is `SuggestEnv`: `AI`, `IMAGES`, `AI_GATEWAY_BASE_URL` and `AI_GATEWAY_ID`. `readSuggestion(answer)` is the reader of the model's JSON.
- **`previewDocument({ title, body, lang?, stylesheets?, origin?, attributes?, style? })`**: the plain page a preview renders into, `noindex`, with the title, language, attributes and stylesheet addresses escaped (relative stylesheets resolved against `origin`, since Carrel shows the preview on its own origin). The body is the site's own rendered HTML, written as it is.
- **`SiteApiSecrets`**: `{ CARREL_SITE_KEY: string }`, for a site's Env.
- **`sha256Hex`** is site-runtime's (`./encoding`), re-exported: the same digest for the same bytes, and it also takes an ArrayBuffer or a string.
- **`onPageChange`** is deprecated in favor of `hooks: [indexNowHook(...)]`; it still runs.

## Changes in v0.13.1

The content kit's media rows, the inspected file and the rows `loadMediaChanges` answers carry `orientation` (`landscape`, `portrait` or `square`, by `orientationOf`; absent for a file with no size), so a screen filters and warns by the package's rule rather than a copy of it. No route changes.

## Changes in v0.13.0

Additive: every v0.12.0 route and body still works as it did, and the schema hash and package version move on purpose. `test/contract-v0.12.0.test.ts`, against `test/fixtures/contract-v0.12.0.json` written from the v0.12.0 build, holds every v0.12.0 route and schema identical except these: `Capabilities`, `MediaItem` (and so `MediaDetail` and `MediaReplaceResult`), `MediaListQuery`, `MediaList` and `MediaUploadQuery` gain only optional properties; `MediaLens` gains three values and the sort gains `used`, each at the end; and the upload's answer is named `MediaUploadResult`, which is `MediaItem` with three optional properties more, so a v0.12.0 reader still parses it. Seven routes are new.

The media library's ideas, for Capsomer's `MediaLibrary` in Carrel and in each site's own admin. Every one is optional per site: the site's adapter offers it, `meta.capabilities` says so, and a site without it answers its route or query `501 not-implemented` before the adapter runs. Each write takes the version the caller saw and a change id, answers `409` with `currentVersion` for a stale one, `404` for a missing id and `422 refused` for the site's own rules, and moves the file's version.

1. **Duplicates** (`mediaDuplicates`). The package hashes every upload's bytes (SHA-256, `sha256Hex`) and hands the hash to the adapter as `MediaUpload.sha256`, so every site keys duplicates the same way: exact bytes, never a picture's likeness. Before storing, it asks the adapter's `findByHash`; bytes the site already holds (trashed or not) answer `200` with that file and `duplicateOf`, and `upload` never runs. The `duplicates` lens lists files whose bytes match another's, and a detail carries `twins: [{ id, filename }]`. In the content kit, an upload or import that matched answers its outcome with `duplicate: true` and the stored file's `id`.
2. **Usage count** (`mediaUsage`). Items carry `usedCount`, how many places use the file by the site's own reference check, and the list sorts by `used`, most used first. `sort=used` on a site without it is `501`.
3. **Placeholder and main color.** Items may carry `placeholder`, a base64 `data:` URI of a png, jpeg, gif, webp or avif of at most 2,048 characters (`MAX_PLACEHOLDER_CHARS`; no SVG, so it never carries markup), and `color`, `#rrggbb` in lower case, both made at upload; `null` where the site made none. An answer outside these bounds is a site failure, never passed on.
4. **Import from the web** (`mediaImport`). `POST /media/import` `{ url, filename?, alt?, resize?, changeId }`. The package fetches it, with the fetch the adapter supplies (`importFetch`), so every site guards it the same way: https on the default port only, no user name or password, no IP address and no local name (`localhost`, `.local`, `.internal` and the like), each of up to three redirects checked as the first was, 15 seconds at most. A refused address is `400` and nothing is fetched; a refused redirect or an answer that is not `200` is `422`. Then the upload's own checks, in the upload's order: a type the site does not accept is refused unread, then the size, the signature and active content. The bytes go to the adapter's `upload` with `sourceUrl`, so the site stores its own copy; an item served from the source address (a hotlink) is a site failure. The name is the last segment of the final address unless `filename` gives one. It answers as an upload does, duplicates included.
5. **Filters** (`mediaFilters`). The list takes `orientation` (`landscape`, `portrait`, `square`) and `kind` (`image`, `document`, `video`, `audio`). `orientationOf(width, height)` and `kindOf(contentType)` are the package's rules, for a site to apply: a picture is square when its edges differ by at most 1% of the longer, a file with no size has no orientation, and every type that is not image, video or audio is a document.
6. **Credit and license** (`mediaCredit`). Items carry `credit` and `license` (free text, up to 300 characters, `""` for none) and `sourceUrl` (http or https, or `null`). `PUT /media/:id/credit` `{ credit, license, sourceUrl, licenseExpires, expectedVersion, changeId }` writes all four as one, each the whole value after it, and answers `MediaWriteResult`.
7. **Rotate and flip, keeping versions** (`mediaTransform`, `mediaHistory`). `POST /media/:id/transform` `{ op, expectedVersion, changeId }`, `op` one of `rotate-90` (a quarter turn clockwise), `rotate-180`, `rotate-270`, `flip-h` (left to right) and `flip-v`. The package checks the file, its version, that it is `deletable` and that it is an image (`422` otherwise) before the adapter runs. In place, the id and address stay, the site keeps the old bytes, and the focal point moves with the picture (`transformFocus(focus, op)` is the package's rule for it). `GET /media/:id/history` answers `{ id, revisions }`, newest first, each `{ rev, at, bytes, width, height, reason, current }` with exactly one current; `POST /media/:id/revert` `{ to, expectedVersion, changeId }` puts revision `to` back as a new revision, so a revert is itself undone by another. Alt, caption, tags and credit stay; a revert clears the focal point, as a replace does. Both answer `MediaTransformResult`: the item with `changeId`, `sizesNeedPurge` and `asNewFile`. **`replaceKeepsSize`:** a quarter turn swaps the width and height, which on such a site would break every address and page sized by the old one. The package does not refuse it: it sends the adapter `asNewFile: true` for a quarter turn of a picture that is not exactly square, the site stores the turned picture as a new file (alt, caption, tags and credit copied) and leaves the old one exactly as it was, and the answer says `asNewFile: true` with the new id. A screen then offers to put the new file where the old one was used. A half turn, a mirror and a quarter turn of a square picture keep the size and turn in place. A revert to bytes of another size is refused (`422`) on such a site; its own writes never make one, so this guards a site's mistake.
8. **Download the original.** Items carry `downloadUrl` where the site offers one; it may equal `url`.
9. (A site build check, outside this package.)
10. **Live updates** (`mediaChanges`). Every list answer carries `changeCursor`. `GET /media?changedSince=<cursor>&limit=` answers every file changed since (a write that moved its version or bytes, or an upload), each once and as it is now, trashed ones included, and `removed`, the ids deleted for good; oldest changes first, at most `limit` together, with the next `changeCursor` and `moreChanges` when others wait. It takes no other filter (`400`), so a poll never misses a file a filter would hide; a cursor the site can no longer answer from is `422`, and the screen reloads its page. Plain polling: one cheap request, no websocket.
11. **Shrink large pictures** (`mediaResize`, `mediaResizePass`). `mediaResize: { maxEdge, quality }` says what the site shrinks uploads to: the adapter's `upload` gets `resize: true`, shrinks a picture whose longer edge is over `maxEdge`, and answers `resizedFrom: { width, height, bytes }`. `resize=no` on the upload's query (or the import's body) keeps one file's size. For files already stored, the `oversized` lens lists pictures over `maxEdge`, and `POST /media/resize-pass` `{ items: [{ id, expectedVersion, changeId }] }`, 1 to 20 (`MAX_RESIZE_PASS`) per request, shrinks each in place (the site keeps the old bytes in its history) and answers one outcome per file, in order, `{ ok: true, id, changeId, resized, version, width, height, bytes }` (`resized: false` for a picture already within the size) or `{ ok: false, id, changeId, error, message, currentVersion? }`; one file's refusal never stops the others. A site whose `replaceKeepsSize` is never offered the pass, since a stored picture would change size under its address.
12. **Embedded metadata** (`mediaEmbedded`). At upload the site may read the file's IPTC and EXIF (creator, copyright, caption, date taken) and fill `credit`, `license`, `caption` and `takenAt` where they are empty. Items carry `takenAt`, with an offset where the file names one and as local time where it does not. The upload's answer names what was filled in `embedded`.
13. **License expiry.** Items carry `licenseExpires` (`YYYY-MM-DD`, or `null` for none), written with the credit. The `license-expired` lens lists files whose date is before today in UTC, and the kit's `summary()` counts them in `mediaLicenseExpired`.
14. **AI suggestions** (`mediaSuggestions`). `GET /media/:id/suggestions` answers `{ id, tags, alt, model }` from the site's own model (on Dustin's sites, Workers AI through Cloudflare AI Gateway); the contract carries only the answer. The package keeps the tags that are tags in the contract's spelling (lower case, spaces made hyphens, at most 12) and trims the alt text (`null` for none). Nothing is applied: a person accepts each with the usual alt and tags writes, or dismisses it. A site answers an id it does not hold `404` before it asks its model.

- **The adapter.** `MediaAdapter` gains the flags `usage`, `filters`, `resize`, `readsEmbedded` and `importFetch`, and the optional methods `findByHash(sha256)`, `setCredit(id, input)`, `transform(id, { op, asNewFile, expectedVersion, changeId })`, `history(id)`, `revert(id, { to, expectedVersion, changeId })`, `changes({ since, limit })`, `shrink(id, { expectedVersion, changeId })` and `suggest(id)`. `upload` gets `sha256`, `resize` and, on an import, `sourceUrl`, and may answer `embedded` and `resizedFrom` (`MediaUploaded`). The package exports `sha256Hex`, `kindOf`, `orientationOf`, `turnsSize` and `transformFocus` for sites.
- **The reference adapter.** `memoryAdapter()` offers all of it but duplicates and import: `memoryAdapter({ mediaDuplicates: true })` finds duplicates, `memoryAdapter({ mediaImportFetch })` imports through the fetch a test passes (so no test reaches the network), `memoryAdapter({ mediaResize: false })` keeps every size, and `memoryAdapter({ mediaExtras: false })` is a v0.12.0 media manager. It measures PNGs and reads their `tEXt` chunks (`Author`, `Copyright`, `Description`, `Creation Time`) as its embedded metadata.
- **Conformance** adds a credit, transform and revert write and a history and suggestions read of the probe id (`404` where offered, `501` where not), and an import of an http address (`400` where offered, before anything is fetched).
- **The media kit** (`./admin`):
  - Offers `duplicates`, `usage`, `filters`, `import`, `credit`, `transform`, `history`, `live`, `resize` (the site's `{ maxEdge, quality }` or `null`), `resizePass`, `embedded` and `suggestions`. `readMediaQuery` reads `orientation`, `kind` and `suggest=1`; a filter goes only to a site that filters, and the used sort only to one that counts (the kit sorts the page by `usedCount` otherwise).
  - The inspector's `detail` carries `history` where the site keeps it, and `suggestions` (the tags the file lacks, an alt text unlike its own, and the model) only when the query asks and the person may edit, since a model costs the site money.
  - Five intents. `import` (`url`, `filename`, `alt`, `resize`) needs `edit`, like an upload. `credit` (`credit`, `license`, `sourceUrl`, `licenseExpires`) needs `edit`. `transform` (`op`), `revert` (`to`) and `resize` change every live page that uses the file, so they are the Owner's (`deleteMedia`), like a replace. A transform's Undo is a revert to the bytes it had where the site keeps history, else the inverse turn; one saved as a new file has none, and says so. A revert's Undo reverts to the bytes it replaced. `resize` asks first (`confirm`, every file listed) and sends the files in requests of 20. An upload or import of bytes the site holds says which file it already was, and records nothing.
  - `upload` posts `resize=no` through, and its message says what the site shrank and what it filled in from the file.
  - `loadMediaChanges(source, cursor)`, from `page.changeCursor`, answers `{ rows, removed, changeCursor, more }`, or `{ reload: true }` when the site can no longer answer from the cursor.

## Changes in v0.12.0

Changed behavior (a host that posted these straight through must now post `confirm`):

- **The kit asks before a step nothing can undo.** `runMediaIntent`'s `delete` and `empty-trash` and `runPostsIntent`'s `delete` answer with `confirm` (new `IntentResult.confirm`, type `ConfirmRequest`: a title, a lead, the button, every item it would change, the fields to post again, and `typeToConfirm`, the number of items) and change nothing, until the form posts `confirm` equal to that number. Capsomer's content components show it as their confirm dialog with script and their confirm page without, so a site admin and Carrel ask the same way. A media delete asks only about the files that would really go, after the trash-first check. A duplicate's Undo (a delete of the copy it just made) carries its own `confirm`, so Undo stays one step. `askFirst(input, ask)` is exported for a host's own one-way intents.

## Changes in v0.11.0

Additive:

- **`mediaReplaceKeepsSize`**, a new optional capability beside `mediaReplace`: true when the site refuses a replace whose picture is not the size of the one it replaces, because its addresses or pages are sized by the file's own width and height (dustinedwards.info's keys carry `-<w>x<h>`). An adapter says so with `MediaAdapter.replaceKeepsSize: true`; `memoryAdapter({ mediaReplaceKeepsSize: true })` does the same. The content kit's `offers.replaceKeepsSize` carries it, so a screen asks for a file of the same size and saves a crop as a new file instead of in place.
- **A version per box, for a form with no script.** `runPostsIntent`, `runMediaIntent` and `runMentionsIntent` read each id's version from a `version:<id>` field where `versions` does not give one, so a bulk form with no script (which cannot line a list of versions up with the boxes ticked) posts each box's version under its id. `versions` still wins.
- **An outcome carries the version its write made** (`Outcome.version`), for the media kit's `alt`, `tags`, `caption`, `focus` and `replace`, so a screen that saves one field after another (Capsomer's autosaving inspector) sends each write on the version the last one made.
- **The kit's `focus` intent takes `x` and `y`**, each a percent from the top left, as a focal point form with no script posts them, and `clear=yes` to clear it, besides `focus` as `"XxY"`.

## Changes in v0.10.1

Additive. v0.10.0 was tagged before these two merged:

- `liveSaveWarning(doc, label?)` takes the admin's own time formatter, so a page says one time one way.
- Media focal point, caption and replace: `PUT /media/:id/focus`, `/caption` and `/file`, the `mediaFocus`, `mediaCaption` and `mediaReplace` capabilities, the adapter's optional `setFocus`, `setCaption` and `replace`, and `@dustinedwards/site-api/r2` (`writeFocus`, `replaceObject`) for sites that keep files in R2.

## Changes in v0.10.0

Additive: every v0.9.0 route and body is unchanged, and the schema hash and package version move on purpose. Five new routes, four new optional capabilities, optional `scheduledUpdate` on `ContentSummary`, `ContentDoc` and `WriteResult`, and optional `focus` and `caption` on `MediaItem`. One behavior change: a schedule on a live post is refused on a site without scheduled updates, where before the site's own schedule took the post off the site until the time.

**Scheduled updates to a live post, optional per site** (`meta.capabilities.scheduledUpdates`). Modeled on EmDash's scheduled publishing: a published post can carry one pending revision with its own publish time. The live version stays served until then, and at that time the revision replaces it.

| The item | `status` | `scheduledUpdate` | What readers see |
|---|---|---|---|
| A draft | `draft` | `null` | nothing |
| Scheduled, never live | `scheduled` (`publishAt` set) | `null` | nothing until `publishAt` |
| Live | `published` | `null` | the live version |
| Live, with an update waiting | `published` | `{ publishAt, changeId }` | the live version until `publishAt`, then the update |

- **Schedule.** `POST /content/:id/schedule` takes the same `ScheduleInput` as before: `{ expectedVersion, changeId, publishAt, source? }`. On a draft or a scheduled item it works as it always has. On a live item it stores an update: `source` (the live source when left out) goes live at `publishAt`, and the item stays `published` and unchanged until then. The answer is `WriteResult` with `status: "published"` and `scheduledUpdate: { publishAt, changeId }`. The item's `version` moves, since the update is part of the item, so the next write sends the new one. A site without the capability refuses a schedule on a live item, `422 refused`, and the post stays live.
- **Reschedule.** Send the schedule again with the current version: the new `source` and `publishAt` replace the update that was waiting. There is only ever one.
- **Read.** `GET /content/:id` and the list rows are the live version, with `scheduledUpdate` saying what waits. `GET /content/:id/schedule` answers `ScheduledUpdate` `{ id, source, publishAt, changeId, scheduledAt }`, the waiting revision's own source, for the editor and a preview (`POST /preview` with that source). `404 not-found` when nothing waits, `501` without the capability.
- **Cancel.** `DELETE /content/:id/schedule?expectedVersion&changeId` answers `WriteResult`. A live item drops its update and stays live (`scheduledUpdate: null`); a scheduled item that was never live returns to `draft`. Nothing scheduled is `422 refused`, a stale version `409`, a missing id `404`, and `501` without the capability.
- **Other writes.** A publish now drops a waiting update (what goes live is that publish), and so do an unpublish and a delete, so the cron never brings a post back. A save or a tag change to the live post changes the live version and leaves the update waiting; the update's own source replaces the live one when it runs, so Carrel should warn before such a save.
- **The cron.** `api.runSchedules({ now, limit })` applies every schedule due at `now`, scheduled items and live items' updates alike, oldest first, at most `limit` (50, `SCHEDULE_BATCH_LIMIT`) per pass, and runs the publish hooks for each. The site calls it from `scheduled()` on a one-minute cron (above), so a schedule lands within a minute of its time. Each schedule is its own unit: the adapter applies it only when what it holds still matches what was listed (kind, time and change id), so a cancel, a reschedule or an unpublish in between is skipped, never undone. One that throws is logged (`schedule-failed`) and listed again on the next pass. It answers `{ applied, skipped, failed, more }`; `more: true` means the limit was reached. A scheduled item's first publication records the time it was scheduled for as `publishedAt`, and the publish is recorded under the change id that scheduled it.
- **The adapter.** `SiteAdapter.schedules` (`SchedulesAdapter` in `src/adapter.ts`): `get`, `update`, `cancel`, `due` and `apply`. Its writes throw the usual errors and move the item's version. A site whose version is a hash of its own fields adds the update's time and change id to them, as `contentVersion` takes any parts.
- **Storage.** A D1 site keeps updates in one table beside its content, with `@dustinedwards/site-api/schedules`: `SCHEDULED_UPDATES_SQL` is the migration (the site's next `migrations/` file), and `d1ScheduledUpdates(db)` gives `get`, `due`, and `put` and `remove` as statements the site runs in one `db.batch` with its own row's version move. Times are kept in UTC. A site that keeps content elsewhere (dustinedwards.info, in git) stores the update its own way.
- **Conformance** adds a schedule read and cancel of the probe id: `404` where the site offers scheduled updates, `501` where it does not.
- **The posts kit** (`./admin`):
  - Each row of a post with an update waiting carries `scheduledUpdate: { publishAt, href }`. `href` is the host's optional `scheduleHref(id)`, or the editor. `offers.scheduledUpdates` says the site keeps updates.
  - `loadScheduledUpdate(source, id)` is the view data for that page: the update's source, the live source, a unified `patch` from one to the other, and `when` ("2030-01-01 15:00 UTC").
  - Two new intents, both needing `publish`:
    - `reschedule` with `publishAt`: moves a live post's update, or a scheduled post, to the new time, keeping the update's source. Its Undo moves each back, through `publishAts`, one time per post.
    - `cancel-schedule`: drops the update and keeps the post live, or returns a scheduled post to draft. It has no Undo.
  - `liveSaveWarning(doc, label?)` is the sentence an editor shows before a save to a live post with an update waiting (null otherwise). A tag change on such a post adds it to its outcome. `label` formats the time (default `scheduleLabel`, "2030-01-01 15:00 UTC"), so an admin that writes times its own way says this one the same way.

**A file's focal point, caption and replace, each optional per site** (`meta.capabilities.mediaFocus`, `mediaCaption`, `mediaReplace`), for Carrel's focal point picker, captions and replace-file. A site whose adapter lacks the method answers that route `501` whatever the body says. Each write takes the version the caller saw and a change id, answers `409` with `currentVersion` for a stale one, `404` for a missing id and `422 refused` for the site's own rules, and moves the file's version, like alt and tags.

- **Focal point.** `PUT /media/:id/focus` `{ focus, expectedVersion, changeId }` answers `MediaWriteResult`. `focus` is `"XxY"`, each from 0 to 1 from the top left with up to three decimals, or `null` to clear it and leave the crop to the site's guess. It is what site-runtime's `./image` takes: the package checks it with that module's `focusOf` (`400 invalid` otherwise) and hands the adapter `focusOf`'s spelling (`"0.250x0.4"` arrives as `"0.25x0.4"`), the spelling `./image` writes into a crop's `fp=`. A site on R2 keeps it as the object's customMetadata `focus` (`FOCUS_METADATA`), where `./image` reads it. Items carry `focus` (`null` for none) on a site that keeps it.
- **Caption.** `PUT /media/:id/caption` `{ caption, expectedVersion, changeId }`, up to 2,000 characters, `""` for none, answers `MediaWriteResult`. Items carry `caption` on a site that keeps it. It is longer than R2's 2 KB of custom metadata allows, so it lives in the site's own index.
- **Replace.** `PUT /media/:id/file?filename&expectedVersion&changeId` with the new bytes as the body and their type as `Content-Type`, like an upload. The package refuses, before the adapter runs: a type the site does not accept (unread, `400`), a missing id (`404`), a stale version (`409`), a file that is not `deletable`, the site's own (`422`), a type other than the file's own (`400`: the address names the type, so a new type is a new upload), and then the upload checks (size, signature, active content). The id and the address stay, so every page that uses the file shows the new one; alt, caption and tags stay; the focal point is cleared, since it named a place in the old picture. It answers `MediaReplaceResult`: the item with `changeId` and `sizesNeedPurge`. `sizesNeedPurge: true` means the site's cache may still serve resized copies made from the old bytes, and they need purging (or must wait out their lifetime); `false` means none can be stale, because the site's image route keys its cache by the object's etag (site-runtime `./image` 0.27.0 and later) or the site purged them in the write. A browser that already holds the old file or a size under a long `immutable` lifetime keeps it until that runs out, whatever the site does.
- **The adapter.** `MediaAdapter.setFocus`, `setCaption` and `replace`, each optional. `replace(id, { bytes, contentType, filename, expectedVersion, changeId })` answers `{ item, sizesNeedPurge }`; an item whose id or address moved is a site failure (`500`).
- **Storage.** `@dustinedwards/site-api/r2` is the R2 half: `writeFocus(bucket, key, focus)` puts the object again with its own bytes and `focus` set (or removed for `null`), since R2 has no metadata-only update, and `replaceObject(bucket, key, { bytes, contentType })` puts the new bytes keeping the object's HTTP and custom metadata but the focal point, refusing another type. Each put is conditional on the etag it read, so a write that raced another is refused (`RefusedError`), never lost. The site's own index (version, size, caption) is the adapter's.
- **Conformance** adds a focus and a caption write and a replace of the probe id (`404` where offered, `501` where not), and a focus outside 0 to 1 (`400` where offered).
- **The media kit** (`./admin`): `offers.focus`, `offers.caption` and `offers.replace`, and three intents on one file: `focus` (`focus` is `"XxY"`, `""` clears it), `caption`, and `replace` (the new `file`, checked against the site's limits first, as an upload is). A replace is the Owner's, like a delete (`deleteMedia`): it changes every live page that uses the file. Its message says when the site's cache may still serve the old sizes.

**Publish hooks.** `createSiteApi({ hooks })` takes `PublishHook`s, `{ name, run(event) }`, run when a public page changes: on a publish, an unpublish, a delete of a live item, a save or tag change to a live item, and each schedule `runSchedules` applies. The event is `{ action, id, path, url, trigger, changeId, request? }`: `action` is `publish`, `update`, `unpublish` or `delete`; `trigger` is `request` or `schedule`; `url` is the site's origin and the path. The hooks run together, after the write, under the request's `waitUntil`, so Carrel's answer never waits. A hook that throws or resolves `false` is logged (`hook-failed`, with the hook's name and the event) and the write stands. The first hook is `indexNowHook({ submit, origin, key })`: it sends the changed URL through the `submitIndexNow` the site passes in, Prelum's, so this package holds no copy of it; a request on another origin (a preview) sends nothing.

## Changes in v0.9.0

Additive, no route or schema changes. `createSiteApi` takes `onPageChange(paths, request)`, called after a publish, an unpublish, a delete, or a save or tag change to a published item, with that item's public path, so a site tells search engines through Prelum's `submitIndexNow` (below). `handle(request, ctx)` runs it under `ctx.waitUntil`, so Carrel's answer never waits; a failure is logged, never answered. `contentVersion(parts)` returns the first 32 hex characters of the SHA-256 of `JSON.stringify(parts)`, the version germomics, txasm and julieedwards.info each computed with their own copy. A site that switches to it keeps the same versions.

## Changes in v0.8.0

Additive, no route or schema changes, so the schema hash is the same. `@dustinedwards/site-api/frontmatter` adds `jsonSource` and `JsonSourceError`, the JSON front matter a site writes for Carrel when its fields live in columns (foxhound, germomics, foxing), so each site keeps a field list instead of its own reader and writer.

## Changes in v0.7.2

Fixes, no route or schema changes, so the schema hash is the same. Media uploads refuse an SVG or PDF that carries script, frontmatter tags that YAML would misread are quoted, frontmatter with CRLF line endings parses, and the key check uses site-runtime's constant-time compare.

## Changes in v0.7.1

A fix, no route or schema changes, so the schema hash is the same. `GET /meta` said `packageVersion: "0.6.0"` on v0.7.0; it now says the package's own version, and a test holds the two equal.

## Changes in v0.7.0

Additive, no route or schema changes. `@dustinedwards/site-api/frontmatter` exports `splitSource`, `joinSource`, `readKey`, `readList`, `tagsOf`, `setBlock`, `setRawKey` and `setTags`, so a caller (Carrel's editor) builds on them instead of keeping its own block reader.

## Changes in v0.6.0

Additive: every v0.5.0 route and body still works as it did, and the schema hash and package version move on purpose. A test (`test/contract-v0.5.0.test.ts`, against `test/fixtures/contract-v0.5.0.json` written from the v0.5.0 build) holds every v0.5.0 route and schema identical, except the ones named below, each of which gains exactly the optional properties named here; the mention decision gains `reset` and nothing else. The one new route is `PUT /content/:id/tags`.

- **Mention reset, optional per site.** `POST /mentions/:id/decide` takes a third decision, `reset`, which takes an approved or rejected mention back to `pending`, with `decidedAt` cleared and a new version. It is how a decision is undone. A mention with no decision to take back is refused with the site's own words (`422 refused`). The adapter's optional `mentions.reset` serves it; a site whose adapter lacks it answers a reset `501 not-implemented`, and `meta.capabilities.mentionReset` is absent. Conformance adds a reset of the probe id: `404` where the site offers reset, `501` where it does not.
- **Each list row carries its `version` and `tags`** (both optional on `ContentSummary`, so a v0.5.0 site's rows still parse). A row's action then needs no read first. `ContentDoc` carries `tags` too.
- **Sort and count.** `GET /content` takes `sort` (`updated`, `published` or `title`) and `dir` (`asc` or `desc`; the dates run newest first and titles A to Z unless `dir` says otherwise). A site that sorted says so in the answer's `sorted: { sort, dir }`; one that did not leaves it out, and the caller sorts the page itself. `total` is how many items match across every page, where the site can count them.
- **Post tags, optional per site.** `PUT /content/:id/tags` `{ tags, expectedVersion, changeId }` sets a post's whole tag set and answers `WriteResult`, the post keeping its status. A tag is 1 to 40 characters, trimmed, with no commas, brackets, quotes, `#`, `:`, backslashes or line breaks, so it fits a frontmatter list; at most 50 per post. The package keeps one spelling per tag (the first given) before the adapter sees it. A stale version is `409`, a missing post `404`, the site's own rules `422`. A site whose adapter has no `content.setTags` answers `501`, and `meta.capabilities.contentTags` is absent. Conformance adds a tags write on the probe id: `404` where the site keeps tags, `501` where it does not.
- **Mention search and the one-post filter.** `GET /mentions` takes `q` (words in the source address, the author or the excerpt) and `targetId` (only the mentions of one post). `counts` still cover the whole queue. A site that applied them echoes them in `filtered`; a v0.5.0 site ignores them, leaves `filtered` out, and the caller filters the page itself.
- **Media lenses and sort, optional per site.** `GET /media` takes `lens`: `unattached` (nothing uses the file, by the site's own reference check), `no-alt` (no alt text) or `large` (over 1 MiB, `LARGE_MEDIA_BYTES`). It also takes `sort` (`added`, newest first; `name`, A to Z; `size`, largest first) with `dir`, and answers `total` and, where the site sorted, `sorted`. The adapter's optional `media.lenses` names the lenses it answers and appears as `meta.capabilities.mediaLenses`; a site that names any also sorts. A lens a site does not name is `501` before the adapter runs. Every site can offer every lens: the package has no per-site list. Conformance asks for each lens: `200` in shape for one the site names, `501` for one it does not.
- **Object arguments in the client.** `client.media.delete(id, { changeId })` and `client.mentions.sweep({ changeId })` take an object, like every other write. The change id alone, as in v0.5.0, still works.

## Media (v0.2.0)

Files stay in the site's own storage and are served by the site. Carrel only lists them, uploads to them and asks for deletes, so nothing about serving an image depends on Carrel.

- **Limits are the site's.** `meta.capabilities.mediaUpload` declares `maxBytes` (at most 25 MiB) and the accepted MIME `types`.
- **Checked before the site sees a byte.** The package refuses an upload in this order, and the adapter never runs for any of them:
  1. a type the site did not declare (`400 invalid`), without reading the body;
  2. a declared or actual size over `maxBytes` (`413 too-large`), reading no further than the limit;
  3. an empty file, or a file name carrying a path (`400 invalid`);
  4. bytes that are not the declared type (`400 invalid`), for the types with a signature: PNG, JPEG, GIF, WebP, AVIF, HEIC and HEIF (v0.15.0), PDF and SVG (an `<svg` element near the start, no NUL bytes). An SVG holding script, an event handler, an embedded page or a `javascript:` link, and a PDF holding a JavaScript action, are refused too (`400 invalid`): they would run on the site that serves them. For any other type the site checks the bytes itself.
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
    setTags?(id: string, input: { tags: string[]; expectedVersion: string; changeId: string }): Promise<WriteResult>; // v0.6.0; omit and the route answers 501
    // v0.17.0, each optional (the route or option answers 501 when absent).
    publishedAtSettable?: boolean;                 // publish takes publishedAt
    searchFields?: SearchField[];                  // the search fields the site renders
    postFields?: PostField[];                      // the post fields the site renders
    filters?: ("kind" | "tag" | "author" | "published")[]; // the list filters list applies
    rename?(id: string, input: RenameInput): Promise<RenameResult>;          // the old path redirects (301)
    trash?(id: string, input: { expectedVersion: string; changeId: string }): Promise<WriteResult>;   // with restore and delete, or neither
    restore?(id: string, input: { expectedVersion: string; changeId: string }): Promise<WriteResult>; // always a draft
  };
  renderVersion?: string;                          // v0.17.0: Prelum's RENDER_VERSION
  preview: { render(input: PreviewInput): Promise<string> };
  schedules?: {                                    // v0.10.0; omit for a site with no scheduled updates to live posts
    get(id: string): Promise<ScheduledUpdate | null>;
    update(id: string, input: { source: string; publishAt: string; expectedVersion: string; changeId: string }): Promise<WriteResult>;
    cancel(id: string, input: { expectedVersion: string; changeId: string }): Promise<WriteResult>;
    due(input: { now: Date; limit: number }): Promise<DueSchedule[]>;          // { id, kind: "publish" | "update", publishAt, changeId }
    apply(id: string, input: DueSchedule & { now: Date }): Promise<WriteResult | null>; // null: no longer matches, nothing changed
  };
  insight?: {                                      // v0.16.0; omit for a site that does not count its 404s
    notFound(options: { days: number; limit: number; includeProbes: boolean }): Promise<NotFoundRow[]>; // site-runtime's notFoundReport
  };
  mentions?: {                                     // v0.5.0; omit for a site with no webmentions
    list(query: MentionListQuery): Promise<MentionList>; // items, nextCursor, counts, expiring
    decide(id: string, input: { decision: "approve" | "reject"; expectedVersion: string; changeId: string }): Promise<{ status: MentionStatus; version: string; purged: boolean | null }>;
    reset?(id: string, input: { expectedVersion: string; changeId: string }): Promise<{ status: MentionStatus; version: string; purged: boolean | null }>; // v0.6.0; omit and a reset answers 501
    delete(id: string, input: { expectedVersion: string; changeId: string }): Promise<{ purged: boolean | null }>;
    sweep(input: { changeId: string }): Promise<{ failed: number; rejected: number }>;
  };
  media?: {                                        // v0.2.0; omit for a site with no media manager
    limits: { maxBytes: number; types: string[] };
    lenses?: ("unattached" | "no-alt" | "large")[];  // v0.6.0; the lenses list answers, and with any of them it sorts
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
    // v0.10.0, each optional, throwing and moving the version like the writes above.
    setFocus?(id: string, input: { focus: string | null; expectedVersion: string; changeId: string }): Promise<{ version: string }>;
    setCaption?(id: string, input: { caption: string; expectedVersion: string; changeId: string }): Promise<{ version: string }>;
    replace?(id: string, input: MediaReplace): Promise<{ item: MediaItem; sizesNeedPurge: boolean }>; // same id and address
    // v0.13.0: flags, and methods each optional (the route or query answers 501 when absent).
    usage?: boolean;                               // items carry usedCount; the list sorts by used
    filters?: boolean;                             // the list takes orientation and kind
    resize?: { maxEdge: number; quality: number }; // what uploads shrink to
    readsEmbedded?: boolean;                       // upload fills empty fields from IPTC and EXIF
    importFetch?: typeof fetch;                    // the fetch POST /media/import uses
    findByHash?(sha256: string): Promise<MediaItem | null>;
    setCredit?(id: string, input: { credit: string; license: string; sourceUrl: string | null; licenseExpires: string | null; expectedVersion: string; changeId: string }): Promise<{ version: string }>;
    transform?(id: string, input: { op: MediaTransformOp; asNewFile: boolean; expectedVersion: string; changeId: string }): Promise<{ item: MediaItem; sizesNeedPurge: boolean }>;
    history?(id: string): Promise<MediaRevision[] | null>;  // with revert, or neither
    revert?(id: string, input: { to: string; expectedVersion: string; changeId: string }): Promise<{ item: MediaItem; sizesNeedPurge: boolean }>;
    changes?(input: { since: string; limit: number }): Promise<{ items: MediaItem[]; removed: string[]; cursor: string; more: boolean }>;
    shrink?(id: string, input: { expectedVersion: string; changeId: string }): Promise<{ resized: boolean; item: MediaItem }>;
    suggest?(id: string): Promise<{ tags: string[]; alt: string | null; model: string } | null>;
  };
}
```

An adapter signals refusals by throwing these errors:

- **`VersionConflictError(currentVersion)`:** a stale `expectedVersion`.
- **`NotFoundError`:** a missing id.
- **`RefusedError(message)`:** the site's own rules said no, such as a failed render. The writer sees the message.
- **`MediaInUseError(usedBy)`:** the file is in use; the delete is refused with each use named.

The package computes diffs, and serves the source at a revision, from `revisionSource`, so a site only has to return old source. `content.delete` throws `VersionConflictError`, `NotFoundError` or `RefusedError` like the writes.

`@dustinedwards/site-api/testing` exports `memoryAdapter()`, a conforming reference adapter held in memory, media included (its reference check scans each post's source for `/media/<id>`, as dustinedwards.info's does). `memoryAdapter({ media: false })` is a site with no media manager, `memoryAdapter({ contentDelete: false })` one with no content delete, `memoryAdapter({ contentTags: false })` one that keeps no post tags through the API, `memoryAdapter({ mediaWrites: false })` a v0.2.0 media manager with no alt, tag, trash, focal point, caption or replace writes, `memoryAdapter({ mediaLenses: false })` one with no lenses and no sort, `memoryAdapter({ mentionFilters: false })` a mentions group that ignores `q` and `targetId`, `memoryAdapter({ mentions: false })` one with no webmentions, `memoryAdapter({ mentionReset: false })` a v0.5.0 mentions group with no reset, `memoryAdapter({ schedules: false })` a v0.9.0 site with no scheduled updates, and `memoryAdapter({ mediaExtras: false })` a v0.12.0 media manager (v0.13.0's other options are under Changes in v0.13.0). Its files carry a `version` that every metadata write moves. Its mentions are seeded with `adapter.receiveMention({ sourceUrl, targetId, status?, ... })`, as the site's endpoint would write them. Carrel's tests run against it.

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
  - the mentions checks of v0.5.0, listed above under Changes in v0.5.0;
  - the schedule read and cancel and the media focal point, caption and replace probes of v0.10.0, listed above under Changes in v0.10.0;
  - the media credit, transform, revert, history, suggestions and import probes of v0.13.0, listed above under Changes in v0.13.0.
  - the v0.17.0 checks, listed above under Changes in v0.17.0.

  Every write it sends must be refused, so it never changes a conforming site. `probeMediaUpload: true` adds one real round trip: it uploads a 1x1 PNG of its own, reads it back, and deletes that file and no other. It is off by default.

## A site's own admin, and the content kit

The shared posts, media and mentions screens (Capsomer's `PostsList`, `MediaLibrary` and `MentionsList`) run in Carrel and in each site's own admin. Their server half lives here, so it changes in step with the contract.

- **`localClient(adapter)`** (from `@dustinedwards/site-api/client`) answers every method `createSiteClient` does, with the same types and the same `SiteApiError`. It hands each request straight to `createSiteApi`'s handler in process: no network and no configured key. Every route rule, version check, upload check and zod parse is the one Carrel's requests meet. A site's admin passes the same `SiteAdapter` it already mounts; its own sign-in guards the door, so no rate limit applies.
- **`@dustinedwards/site-api/admin`** is the content kit, server only (it holds the client, so the key never reaches a browser):
  - `loadPosts`, `loadMedia` and `loadMentions` turn one site's client into the plain view data a component renders, one page of 50. `readPostQuery`, `readMediaQuery` and `readMentionsQuery` read that query from the address.
  - `runPostsIntent`, `runMediaIntent` and `runMentionsIntent` run one posted intent (a form's `intent`, `ids` and, where the page knew them, `versions` in the same order), each item its own write with the version the person saw and a fresh change id. One item failing never stops the rest. Each returns an `IntentResult`: `ok`, one sentence, an outcome per item, the item that hit a version conflict, and `undo`, the inverse intent with the versions its writes made.
  - `summary(source)` counts what waits on one site (mentions waiting, posts the host has something waiting on, files with no alt text where the site answers the `no-alt` lens with a `total`, and files whose license has run out where it answers `license-expired`), for an inbox line.
  - `loadMediaChanges(source, cursor)` (v0.13.0) is what a library screen polls for files another person changed.
- **The host supplies a `ContentSource`:** the site, its client (`createSiteClient` in Carrel, `localClient` in the site), what this person `can` do (`edit`, `publish`, `deleteContent`, `deleteMedia`, `decideMentions`), `editorHref`, and optional `postIndex`, `notes`, `waiting`, `hold`, `taken` and `record` hooks. The kit refuses an intent the person may not run whatever the form says, before the site is asked anything; a post that is not a draft needs `publish` for any write.
- **Undo.** Tag add and remove undo on the items that changed, and only those. Unpublish undoes by publishing again, and only a post that has been public before (`publishedAt` set): never a first publication, which is made from the editor. A post that was only scheduled has no Undo. Duplicate undoes by deleting the copy at the version the duplicate made, only where the site offers `contentDelete` and the person may delete; otherwise the message says how to remove the copy. Media trash and restore undo each other, a tag set puts back the set it held. Approve and reject undo each other between approved and rejected. A decision on a waiting mention undoes by `reset` where the site offers it (v0.6.0), and the Undo of a reset is the decision it took back; on a site without reset it has no Undo. When the chosen mentions would need different inverses, there is no single Undo and the message says so. An Undo is a new write with its own change id and the version the action made, so if someone changed the item since, it is refused as a conflict and never retried.
- **Where the site cannot** the kit keeps Carrel's ways. Post tags go through `PUT /content/:id/tags` where the site offers `contentTags` (v0.6.0), and are rewritten in the frontmatter where it does not (a post without frontmatter is then refused). The sort goes to the site, posts and media alike, and where the answer has no `sorted` the kit sorts the page it has and says so (`page.sortedOnPage`). A media lens goes only to a site that names it. A mention search goes to the site, and where the answer has no `filtered` the kit filters the page and says so (`page.filteredOnPage`). Where the site gives a `total`, each status tab gets its count for the same search. The kind and tag filters work on the page the site sent. A media delete on a site with a trash is only from the trash.

Tested once, where it lives: `test/admin.test.ts`, against `memoryAdapter()` through `localClient`, and once through `createSiteClient` as Carrel drives it.

## Frontmatter

`@dustinedwards/site-api/frontmatter` reads and writes a post's YAML frontmatter one top-level block at a time, with no YAML parser, so it runs in a Worker and a browser alike. `splitSource` and `joinSource` cut a source into `open + front + close + body` and back, byte for byte. `readKey`, `readList` and `tagsOf` read a key, a list (flow or block form) and the tags. `setBlock`, `setRawKey` and `setTags` replace one key's block (added at the end when absent; `setBlock` with no lines removes it) and return every other block, comment and unknown key as it was. The content kit's tag and duplicate writes use it.

`jsonSource(fields, { required, blankLine })` is the other format: a site that keeps a post's fields in columns hands Carrel one `key: <JSON>` line per field. `fields` names each key's kind (`text`, `list` or `flag`) in the order they are written. `write(values, body)` leaves out a value that is `undefined` and writes `null` as `null`. `read(source)` returns the keys the source has and the body, and throws `JsonSourceError` with every problem at once (`problems`): an unknown or repeated key, a line that is not `key: value`, a value of the wrong kind, a required field missing or blank. A text value may be written unquoted by hand; a list is trimmed and empty items dropped. With no front matter the whole source is the body, unless a field is required. Tested in `test/frontmatter.test.ts`.

## Development

```sh
npm install
npm run typecheck
npm test
```

CI runs the same on every push. Each `PLANT` test sends a request a guard must refuse and also checks that the adapter never ran; each `test/contract-v*.test.ts` holds an earlier contract unchanged against its fixture in `test/fixtures/`, except for the optional properties later versions add.
