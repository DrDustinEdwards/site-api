---
"@dustinedwards/site-api": minor
---

The posts list's `preview-link` now needs the `publish` permission, not `edit`, because a preview link shows a draft to anyone who has the address. A made link is recorded through the source's `record` hook as `post-preview-link`, under the change id sent with it. Hosts that map `record` kinds to their own history add that kind.
