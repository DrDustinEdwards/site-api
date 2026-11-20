---
"@dustinedwards/site-api": patch
---

`runSchedulesOrThrow` keeps the database's message as the cause of its "schedule(s) failed" error when every failed schedule was the database being down (site-runtime's `isDatabaseDown`), so a cron job's `runJobs` records it for /health as a warning and not as a site error.
