---
"@dustinedwards/site-api": patch
---

A smaller Worker bundle: the webmention hook shares one log helper and one body-discard helper with the outbound guard and media import, and the IndexNow hook no longer passes a request address its own origin check made unreachable.
