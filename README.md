# site-api

The standard site API every Dustin Edwards site includes so Carrel can list, edit and publish its content. No keys or content live here.

Each site mounts one handler at `/api/carrel/v1` and implements an adapter over its own storage and render. Carrel talks to every site through the same contract, with one key per site.

## Install

Installed by git tag, never from a registry:

```sh
npm install github:DrDustinEdwards/site-api#v0.1.0
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
| media, inbox, insight, publications | `/*` | | `501` until their stage |

Every write carries an `expectedVersion` and a Carrel `changeId`.

- **`expectedVersion`** is opaque to Carrel, and each site decides what a version is. dustinedwards.info uses its head commit. On a save, `null` means create, and the id must be free.
- **Refusals.** A stale version is refused with `409 version-conflict` and the site's `currentVersion`. A version given for an id that does not exist is refused the same way, with a null `currentVersion`.
- **`changeId`** goes into the site's commit or row, so Carrel's authorship record and the site's history join.
- **First publish.** A first publish from Carrel's key is allowed (Carrel design decision 2). Carrel decides who may trigger it.
- **Deletes.** Unpublish returns an item to draft. Deleting stays in the site's own history.

Errors are `{ "error": code, "message": text }`:

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
}
```

An adapter signals refusals by throwing these errors:

- **`VersionConflictError(currentVersion)`:** a stale `expectedVersion`.
- **`NotFoundError`:** a missing id.
- **`RefusedError(message)`:** the site's own rules said no, such as a failed render. The writer sees the message.

The package computes diffs from `revisionSource`, so a site only has to return old source.

`@dustinedwards/site-api/testing` exports `memoryAdapter()`, a conforming reference adapter held in memory. Carrel's tests run against it.

## Carrel's side

- **`@dustinedwards/site-api/client`:** `createSiteClient({ baseUrl, key })`, a typed client. Every answer is checked against the contract.
- **`@dustinedwards/site-api/conformance`:** `runConformance({ baseUrl, key })`, which Carrel's health check runs against each live site. It checks:
  - the schema hash matches;
  - no key and a wrong key are refused;
  - the key is not served off the prefix;
  - an unknown route is refused;
  - the list answers in shape;
  - a stale write is refused.

  The one write it sends must be refused, so it never changes a conforming site.

## Development

```sh
npm install
npm run typecheck
npm test
```

Tests run locally, with no Actions minutes. The planted tests in `test/planted.test.ts` send a request each guard must refuse: the key off its prefix, a wrong key, a stale `expectedVersion`, an unknown route. Each also checks that the adapter never ran.
