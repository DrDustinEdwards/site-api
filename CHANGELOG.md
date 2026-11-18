# @dustinedwards/site-api

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
