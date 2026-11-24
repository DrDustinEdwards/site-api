---
"@dustinedwards/site-api": patch
---

Revoking a preview link by its id prefix reads a range of the primary key instead of scanning the table with LIKE.
