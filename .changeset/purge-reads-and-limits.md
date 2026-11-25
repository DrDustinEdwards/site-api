---
"@dustinedwards/site-api": patch
---

A rendered preview and a model's media suggestions no longer purge the site's stored pages. A caller without the key is rate limited by its IPv6 /64 (site-runtime's `clientIp`), as everywhere else. A retry that took over a stale write claim can no longer be overwritten by the first write finishing late: `finishWrite` and `releaseWrite` take the `at` of the claim they made. The preview-link error page has a heading. The install example names no old tag.

A file's detail looks up its twins by hash in SQL instead of reading the whole library; `MediaLibraryStore` gains `twins`.
