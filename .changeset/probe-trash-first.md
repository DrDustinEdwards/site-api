---
"@dustinedwards/site-api": patch
---

The probe post's conformance run now trashes it before every delete on a site that has a content trash, so a site that deletes only from the trash (germomics) no longer keeps the probe post it was meant to remove.
