---
"@dustinedwards/site-api": minor
---

The rate limit follows the caller, not its address. The key is checked first: a request with the site key is counted
under the key holder (`site-key`), and one without it under its address (`ip:<address>`), refused after the limit as
before. A Worker's subrequest from another Cloudflare zone carries `CF-Connecting-IP: 2a06:98c0:3600::103` for every
Worker ([Cloudflare HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip-in-worker-subrequests)),
so the address key let any Worker on Cloudflare spend Carrel's 120 a minute; the
[Rate Limiting binding docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/#best-practices)
advise an API key over an IP. Shareable preview links are still counted by address, now as `ip:<address>`. Nothing
changes in a site: the same binding and limit serve both counters.
