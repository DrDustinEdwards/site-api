# @dustinedwards/site-api

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
