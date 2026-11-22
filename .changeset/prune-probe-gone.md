---
"@dustinedwards/site-api": patch
---

The schedule run drops the 410 markers the conformance probe's deleted posts leave once they are an hour old (`store.pruneProbeGone`, a path ending in `carrel-conformance-…`), so an hourly probe no longer adds a `gone_paths` row each run. A real tombstone is kept.
