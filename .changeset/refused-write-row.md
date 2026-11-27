---
"@dustinedwards/site-api": patch
---

A refused write no longer leaves its change row behind. 0.51.0 dropped the row only when the route answered a refusal, not when it threw one (a version conflict, an invalid body), so the cron could later finish the refused write as if it had happened once another write moved the item, and send its hooks a second, wrong time. Any answer under 500 now drops the row.
