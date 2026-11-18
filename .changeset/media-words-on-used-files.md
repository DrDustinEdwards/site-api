---
"@dustinedwards/site-api": minor
---

The media kit's `alt`, `caption` and `credit` intents now need `publish` on a file a page uses (the file's `usedBy` is not empty), because those words show on that page. Someone with only `edit` still changes them on a file nothing uses yet.
