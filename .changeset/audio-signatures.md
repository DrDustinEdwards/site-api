---
"@dustinedwards/site-api": minor
---

`checkUpload` is exported, and it knows the signatures of audio: `audio/mpeg` (an ID3 tag or an MPEG frame), `audio/aac` (ADTS), `audio/mp4`, `audio/wav`, `audio/ogg` and `audio/flac`. Each reads only the file's first bytes, so a site that streams a large episode to storage can check its head and store the type it checked instead of the one the browser sent.
