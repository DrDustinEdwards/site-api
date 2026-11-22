---
"@dustinedwards/site-api": patch
---

The webmention hook no longer fails when the changed page answers 404 or 410 because it was trashed, deleted or unpublished after the event; it tells the page's earlier targets and stops.
