---
"@dustinedwards/site-api": minor
---

A site's pass (runSchedules) now runs two prunes about once a day: preview links that expired or were revoked more than 30 days ago are deleted (the store's new `prunePreviewLinks`), and the media change log drops each entry a newer one for the same file replaced (the store's new `compactMediaChanges`; a site without the standard media tables is skipped). A poll of the change log answers the same and the newest entry stays, so cursors keep working. No schema change.
