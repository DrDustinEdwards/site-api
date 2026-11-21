---
"@dustinedwards/site-api": patch
---

The conformance probe post asks again, for up to `hookWaitMs`, for the public page it expects to have changed (a 200 after a publish, a 301 after a rename, a 410 after a delete): a stored page is purged after the write answers, so the old answer can outlive it for a moment.
