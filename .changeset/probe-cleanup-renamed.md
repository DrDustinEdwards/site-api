---
"@dustinedwards/site-api": patch
---

The conformance probe post's cleanup also looks under its renamed id, so a rename that moved the post and then answered an error no longer leaves the probe post on the site (dustinedwards.info kept one and its deploy failed).
