---
"@dustinedwards/site-api": minor
---

A content write's tombstone and publish hooks survive a Worker that stops partway. With a store, the package keeps the change in `hook_retries` before the write runs, then keeps the tombstone and queues a row for each hook that hears it before dropping the change. Each hook's row is dropped once it works. A Worker that stops after the write leaves those rows, and `runSchedules` finishes them: it reads the item again, and when its version moved (the write happened) keeps the tombstone and sends the hooks, and when it did not, drops the row. A tombstone the store could not keep is no longer only logged: it is tried again on `HOOK_BACKOFF_MINUTES`, and one given up is logged as `site_api_change-gave-up` at error level, which site-runtime's error reporting sends on. An applied schedule is kept the same way. No migration, route or body change; a site gets it by repinning.
