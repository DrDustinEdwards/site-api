---
"@dustinedwards/site-api": minor
---

`mediaSuggester` takes `outcomeKv: (env) => env.APP_KV` and keeps each call's outcome there for site-runtime's `aiOutcomeCheck("alt-text", kv)`, so a suggester that fails every call shows on a site's /health. Left out, nothing is kept.
