---
"@dustinedwards/site-api": patch
---

`schemaHash()` returns a hash recorded in `src/schema-hash.ts` instead of building every schema as JSON Schema in each site's Worker, which takes about 12 KiB raw (2.6 KiB gzip) out of every Worker. `test/schema-hash.test.ts` recomputes it and fails when the record is stale (`UPDATE_SCHEMA_HASH=1 npx vitest run test/schema-hash.test.ts` rewrites it). The hash value is unchanged.
