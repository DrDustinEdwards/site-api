---
"@dustinedwards/site-api": patch
---

Drop the side-effect-free mark: it changed how a Worker's chunks split and made two sites' bundles about 1 KiB larger, with no change to the code in them.
