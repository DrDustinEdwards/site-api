# @dustinedwards/site-api

## 0.51.1

### Patch Changes

- A refused write no longer leaves its change row behind. 0.51.0 dropped the row only when the route answered a refusal, not when it threw one (a version conflict, an invalid body), so the cron could later finish the refused write as if it had happened once another write moved the item, and send its hooks a second, wrong time. Any answer under 500 now drops the row.

## 0.51.0

### Minor Changes

- A content write's tombstone and publish hooks survive a Worker that stops partway. With a store, the package keeps the change in `hook_retries` before the write runs, then keeps the tombstone and queues a row for each hook that hears it before dropping the change. Each hook's row is dropped once it works. A Worker that stops after the write leaves those rows, and `runSchedules` finishes them: it reads the item again, and when its version moved (the write happened) keeps the tombstone and sends the hooks, and when it did not, drops the row. A tombstone the store could not keep is no longer only logged: it is tried again on `HOOK_BACKOFF_MINUTES`, and one given up is logged as `site_api_change-gave-up` at error level, which site-runtime's error reporting sends on. An applied schedule is kept the same way. No migration, route or body change; a site gets it by repinning.

## 0.50.1

### Patch Changes

- The audio signatures are `audio/mpeg` and `audio/mp4` only, the two formats podcast apps play and the only ones a site uploads. `audio/aac`, `audio/wav`, `audio/ogg` and `audio/flac` (added in 0.50.0, used by no site) are gone, so a site that sends one gets no signature check from the package.

## 0.50.0

### Minor Changes

- `checkUpload` is exported, and it knows the signatures of audio: `audio/mpeg` (an ID3 tag or an MPEG frame), `audio/aac` (ADTS), `audio/mp4`, `audio/wav`, `audio/ogg` and `audio/flac`. Each reads only the file's first bytes, so a site that streams a large episode to storage can check its head and store the type it checked instead of the one the browser sent.

## 0.49.2

### Patch Changes

- `Stored` and `StoredMedia` are exported from `./testing`. `memoryAdapter` returns them, and a project with a composite tsconfig failed to typecheck (TS2883) when it kept the result.
- `utc` is exported from `./schedules` again. 0.49.1 made it private by mistake, and sites import it.

## 0.49.1

### Patch Changes

- A rendered preview and a model's media suggestions no longer purge the site's stored pages. A caller without the key is rate limited by its IPv6 /64 (site-runtime's `clientIp`), as everywhere else. A retry that took over a stale write claim can no longer be overwritten by the first write finishing late: `finishWrite` and `releaseWrite` take the `at` of the claim they made. The preview-link error page has a heading. The install example names no old tag.
  A file's detail looks up its twins by hash in SQL instead of reading the whole library; `MediaLibraryStore` gains `twins`.

## 0.49.0

### Minor Changes

- A site's pass (runSchedules) now runs two prunes about once a day: preview links that expired or were revoked more than 30 days ago are deleted (the store's new `prunePreviewLinks`), and the media change log drops each entry a newer one for the same file replaced (the store's new `compactMediaChanges`; a site without the standard media tables is skipped). A poll of the change log answers the same and the newest entry stays, so cursors keep working. No schema change.

### Patch Changes

- Revoking a preview link by its id prefix reads a range of the primary key instead of scanning the table with LIKE.

## 0.48.7

### Patch Changes

- Mark the package side-effect free so a Worker bundles only the modules it imports.

## 0.48.6

### Patch Changes

- Refuse an SVG that carries an XSLT stylesheet instruction or the XSLT namespace.

## 0.48.5

### Patch Changes

- Refuse an SVG that declares an encoding other than UTF-8 or holds an ESC byte, which a browser can use to hide a script keyword from the check.

## 0.48.4

### Patch Changes

- Refuse an SVG whose script element has a non-ASCII namespace prefix, or whose DTD declares an attribute or element.

## 0.48.3

### Patch Changes

- Refuse an SVG whose event handler follows a tab or line break, and one that hides markup in an `<!ENTITY>`.

## 0.48.2

### Patch Changes

- Refuse an SVG link whose `javascript:` scheme is split by a tab or line break.

## 0.48.1

### Patch Changes

- Refuse an SVG whose script hides behind a namespace prefix or an entity in a link, purge after a write whose id starts with `preview-links`, time out a site that does not answer, check the limits before a suggestion reads a file, and log the webmention and gone-check lines through the scrubbing logger.

## 0.48.0

### Minor Changes

- `waitingUpdates(db)` replaces `d1ScheduledUpdates().waiting()`. A Worker that never lists waiting updates no longer bundles it.

## 0.47.0

### Minor Changes

- The admin entry no longer re-exports `localClient` (it stays in `./client`), `askFirst` or the types nothing imports (`Fields`, `IntentInput`, `Outcome`, `ConfirmRequest`, `PostRow`, `PostIntent`, `PostSort`, `MediaRow`, `MediaIntent`, `MediaSuggestionView`, `MentionFilter`, `MentionIntent`); `./client` no longer exports `LocalClientOptions`, `./conformance` `ConformanceCheck` and `ConformanceProbe`, `./schedules` `D1ScheduledUpdates`.
- `orderAndPage` sorts and cuts a content list a site holds in memory, and `d1ScheduledUpdates().waiting()` lists every waiting update, so a site's adapter stops carrying its own copy of each.

## 0.46.16

### Patch Changes

- `schemaHash()` returns a hash recorded in `src/schema-hash.ts` instead of building every schema as JSON Schema in each site's Worker, which takes about 12 KiB raw (2.6 KiB gzip) out of every Worker. `test/schema-hash.test.ts` recomputes it and fails when the record is stale (`UPDATE_SCHEMA_HASH=1 npx vitest run test/schema-hash.test.ts` rewrites it). The hash value is unchanged.

## 0.46.15

### Patch Changes

- The schedule run drops the 410 markers the conformance probe's deleted posts leave once they are an hour old (`store.pruneProbeGone`, a path ending in `carrel-conformance-…`), so an hourly probe no longer adds a `gone_paths` row each run. A real tombstone is kept.

## 0.46.14

### Patch Changes

- A smaller Worker bundle: the webmention hook shares one log helper and one body-discard helper with the outbound guard and media import, and the IndexNow hook no longer passes a request address its own origin check made unreachable.

## 0.46.13

### Patch Changes

- The webmention hook no longer fails when the changed page answers 404 or 410 because it was trashed, deleted or unpublished after the event; it tells the page's earlier targets and stops.

## 0.46.12

### Patch Changes

- The conformance probe credits the author the config names (`author`), for a site that credits only names it knows: foxing.app refused "Conformance Probe".

## 0.46.11

### Patch Changes

- A conformance step that a site refuses now reports the refusal's own message beside its code, so the report says which field the site refused.

## 0.46.10

### Patch Changes

- The conformance probe sends the share image as a site-absolute path again, and as a whole address only when the config sets `imageAsUrl` (foxing.app), because dustinedwards.info refuses a full URL.

## 0.46.9

### Patch Changes

- One `notImplemented` helper for the refusals the server routes repeat, which shortens a site's bundle.

## 0.46.8

### Patch Changes

- Build without comments, so a site's unminified Worker bundle no longer carries them.

## 0.46.7

### Patch Changes

- The gateway's check for a write that changes nothing public is a few bytes smaller, so a site close to its Worker size budget takes 0.46.3's purge fix without going over.

## 0.46.6

### Patch Changes

- The conformance probe post's cleanup also looks under its renamed id, so a rename that moved the post and then answered an error no longer leaves the probe post on the site (dustinedwards.info kept one and its deploy failed).

## 0.46.5

### Patch Changes

- The conformance probe post writes its share image as a whole address, since a site may check the field as a URL (foxing.app refused a bare path). The reference adapter now declares the search fields.

## 0.46.4

### Patch Changes

- The conformance probe post asks again, for up to `hookWaitMs`, for the public page it expects to have changed (a 200 after a publish, a 301 after a rename, a 410 after a delete): a stored page is purged after the write answers, so the old answer can outlive it for a moment.

## 0.46.3

### Patch Changes

- The gateway step no longer purges the stored pages after a preview link write or a draft saved on an item that is not live. Every Carrel autosave and every conformance probe wiped all of a site's cached pages.
- The conformance probe post can start from the site's own new-post source (`newSource`), so a site that requires a slug, a date or JSON fields beyond a title is probed with a post it accepts.

## 0.46.2

### Patch Changes

- The probe post's conformance run now trashes it before every delete on a site that has a content trash, so a site that deletes only from the trash (germomics) no longer keeps the probe post it was meant to remove.

## 0.46.1

### Patch Changes

- `runSchedulesOrThrow` keeps the database's message as the cause of its "schedule(s) failed" error when every failed schedule was the database being down (site-runtime's `isDatabaseDown`), so a cron job's `runJobs` records it for /health as a warning and not as a site error.

## 0.46.0

### Minor Changes

- `mediaSuggester` takes `outcomeKv: (env) => env.APP_KV` and keeps each call's outcome there for site-runtime's `aiOutcomeCheck("alt-text", kv)`, so a suggester that fails every call shows on a site's /health. Left out, nothing is kept.

## 0.45.0

### Minor Changes

- The media kit's `alt`, `caption` and `credit` intents now need `publish` on a file a page uses (the file's `usedBy` is not empty), because those words show on that page. Someone with only `edit` still changes them on a file nothing uses yet.

## 0.44.0

### Minor Changes

- The posts list's `preview-link` now needs the `publish` permission, not `edit`, because a preview link shows a draft to anyone who has the address. A made link is recorded through the source's `record` hook as `post-preview-link`, under the change id sent with it. Hosts that map `record` kinds to their own history add that kind.

## 0.43.0

### Minor Changes

- The rate limit follows the caller, not its address. The key is checked first: a request with the site key is counted
  under the key holder (`site-key`), and one without it under its address (`ip:<address>`), refused after the limit as
  before. A Worker's subrequest from another Cloudflare zone carries `CF-Connecting-IP: 2a06:98c0:3600::103` for every
  Worker ([Cloudflare HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip-in-worker-subrequests)),
  so the address key let any Worker on Cloudflare spend Carrel's 120 a minute; the
  [Rate Limiting binding docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/#best-practices)
  advise an API key over an IP. Shareable preview links are still counted by address, now as `ip:<address>`. Nothing
  changes in a site: the same binding and limit serve both counters.

## 0.42.1

### Patch Changes

- site-runtime and Prelum (`@drdustinedwards/site-helpers`) are no longer peer dependencies. Neither is on the npm
  registry, so npm cannot resolve a peer range for them: whenever a site's lockfile update moved site-api together with
  site-runtime or Prelum (Renovate's "network packages" update), `npm install` failed with ERESOLVE and every such update
  stayed red. A site still installs both beside site-api (site-runtime 0.143.0 or later, Prelum 0.49.0 or later), which
  every site already does, so there is still one copy of each; devkit-shared's pin check keeps them current. The exact
  tags stay as devDependencies for site-api's own tests.
