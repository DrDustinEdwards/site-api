---
"@dustinedwards/site-api": patch
---

The gateway's check for a write that changes nothing public is a few bytes smaller, so a site close to its Worker size budget takes 0.46.3's purge fix without going over.
