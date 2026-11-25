---
"@dustinedwards/site-api": patch
---

`Stored` and `StoredMedia` are exported from `./testing`. `memoryAdapter` returns them, and a project with a composite tsconfig failed to typecheck (TS2883) when it kept the result.
