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
| preview | `POST /preview` | `PreviewInput` | the full page HTML from the site's own pipeline |
| media | `GET /media?q&cursor&limit` | | `MediaList` |
| media | `POST /media?filename&alt&changeId` | the file's own bytes, typed by `Content-Type` | `201 MediaItem` |
| media | `GET /media/:id` | | `MediaDetail`: the file and every place it is used |
| media | `DELETE /media/:id?changeId` | | `MediaDeleteResult`, or `422 refused` naming each use |
| inbox, insight, publications | `/*` | | `501` until their stage |

The media group arrived in v0.2.0. A site whose adapter has no `media` still answers it `501`, as in v0.1.0.

Every write carries an `expectedVersion` and a Carrel `changeId`.

- **`expectedVersion`** is opaque to Carrel, and each site decides what a version is. dustinedwards.info uses its head commit. On a save, `null` means create, and the id must be free.
- **Refusals.** A stale version is refused with `409 version-conflict` and the site's `currentVersion`. A version given for an id that does not exist is refused the same way, with a null `currentVersion`.
- **`changeId`** goes into the site's commit or row, so Carrel's authorship record and the site's history join.
- **First publish.** A first publish from Carrel's key is allowed (Carrel design decision 2). Carrel decides who may trigger it.
- **Deletes.** Unpublish returns an item to draft. Deleting stays in the site's own history.

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
  };
  preview: { render(input: PreviewInput): Promise<string> };
  media?: {                                        // v0.2.0; omit for a site with no media manager
    limits: { maxBytes: number; types: string[] };
    list(query: MediaListQuery): Promise<MediaList>;
    get(id: string): Promise<MediaDetail | null>;  // with usedBy, from the site's reference check
    upload(input: MediaUpload): Promise<MediaItem>; // already checked against the limits and the bytes
    delete(id: string, input: { changeId: string }): Promise<void>;
  };
}
```

An adapter signals refusals by throwing these errors:

- **`VersionConflictError(currentVersion)`:** a stale `expectedVersion`.
- **`NotFoundError`:** a missing id.
- **`RefusedError(message)`:** the site's own rules said no, such as a failed render. The writer sees the message.
- **`MediaInUseError(usedBy)`:** the file is in use; the delete is refused with each use named.

The package computes diffs from `revisionSource`, so a site only has to return old source.

`@dustinedwards/site-api/testing` exports `memoryAdapter()`, a conforming reference adapter held in memory, media included (its reference check scans each post's source for `/media/<id>`, as dustinedwards.info's does). `memoryAdapter({ media: false })` is a site with no media manager. Carrel's tests run against it.

## Carrel's side

- **`@dustinedwards/site-api/client`:** `createSiteClient({ baseUrl, key })`, a typed client. Every answer is checked against the contract.
- **`@dustinedwards/site-api/conformance`:** `runConformance({ baseUrl, key })`, which Carrel's health check runs against each live site. It checks:
  - the schema hash matches;
  - no key and a wrong key are refused;
  - the key is not served off the prefix;
  - an unknown route is refused;
  - the list answers in shape;
  - a stale write is refused;
  - on a site that offers media (v0.2.0): the upload limits are declared, the media list answers in shape, a delete of an id no site holds is refused, and an upload of a type no site accepts is refused.

  Every write it sends must be refused, so it never changes a conforming site. `probeMediaUpload: true` adds one real round trip: it uploads a 1x1 PNG of its own, reads it back, and deletes that file and no other. It is off by default.

## Development

```sh
npm install
npm run typecheck
npm test
```

Tests run locally, with no Actions minutes. The planted tests send a request each guard must refuse, and each also checks that the adapter never ran:

- `test/planted.test.ts`: the key off its prefix, a wrong key, a stale `expectedVersion`, an unknown route.
- `test/media.test.ts`: a file a post uses (refused with the post named), an oversized or undeclared upload, bytes that are not their type, an id that climbs out.
- `test/contract-v0.1.0.test.ts`: the v0.1.0 contract unchanged, against `test/fixtures/contract-v0.1.0.json`, written from the v0.1.0 build. Every v0.1.0 route and schema is identical, except three schemas that gain optional properties only (`Meta`, `Capabilities`, `ErrorBody`).
