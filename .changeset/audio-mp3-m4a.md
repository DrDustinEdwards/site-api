---
"@dustinedwards/site-api": patch
---

The audio signatures are `audio/mpeg` and `audio/mp4` only, the two formats podcast apps play and the only ones a site uploads. `audio/aac`, `audio/wav`, `audio/ogg` and `audio/flac` (added in 0.50.0, used by no site) are gone, so a site that sends one gets no signature check from the package.
