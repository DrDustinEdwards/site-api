# site-api baseline (job_d4d6135b5363)

Measured 2026-10-10 at commit 34d838e (main). Linux container, 4 cores, Node 22.22 (package.json asks
for >=24.14.1; the suite ran fine on 22). Method follows foxhound's `docs/research/baseline.md`.
Measure only: no test, source, `package.json` or lockfile was changed. Stryker was installed with
`--no-save`.

## Test suite

| What | Command | Result |
|------|---------|--------|
| Tests | `npx vitest run` | 14 files, 326 tests passed, about 3.4 s wall (2.45 s in tests) |
| Source | `wc -l src/*.ts` | 10 files, 3,983 lines (admin 1,179, server 710, contract 690, testing 483, conformance 424) |
| Tests | `wc -l test/*.ts` | 14 test files plus 2 helpers, 2,813 lines of test code, 3 contract fixtures |
| Dependencies | package.json | 2 runtime (diff, zod), 3 dev (typescript, vitest, @types/node) |

## Mutation testing (StrykerJS 9.6.1)

Run one chunk at a time (`stryker.config.mjs`), each chunk's mutation JSON and incremental file pushed to
`results/site-api-mutation-baseline` (`chunks/`) as it finished. Setup: vitest runner,
`coverageAnalysis: perTest`, `disableBail`, `ignoreStatic`, concurrency 4. Mutated: all of `src/**/*.ts`.
That is 4,624 mutants, of which 383 are static (ignored) and 4,241 count. Runtimes: contract 1 m 10 s,
server 7 m 24 s, admin 2 m 38 s, rest 9 m 57 s, about 21 minutes in all.

| Status | Mutants |
|--------|---------|
| Killed | 2,880 |
| Timeout (counted as killed) | 4 |
| Survived | 910 |
| No coverage | 447 |
| Ignored (static) | 383 |
| Valid (killed + survived + no coverage) | 4,241 |

- **Mutation score: 68.00%** (2,884 of 4,241).
- Score over covered code: 76.01% (2,884 of 3,794).
- 10.5% of mutants have no covering test.

### Per file

| File | Killed | Timeout | Survived | No coverage | Score |
|---|---|---|---|---|---|
| src/adapter.ts | 43 | 0 | 7 | 0 | 86.00% |
| src/admin.ts | 1124 | 0 | 375 | 279 | 63.22% |
| src/client.ts | 122 | 0 | 12 | 1 | 90.37% |
| src/conformance.ts | 353 | 0 | 172 | 48 | 61.61% |
| src/contract.ts | 21 | 0 | 43 | 0 | 32.81% |
| src/frontmatter.ts | 77 | 0 | 26 | 43 | 52.74% |
| src/local.ts | 11 | 0 | 2 | 0 | 84.62% |
| src/media.ts | 70 | 1 | 45 | 22 | 51.45% |
| src/server.ts | 536 | 1 | 152 | 36 | 74.07% |
| src/testing.ts | 523 | 2 | 76 | 18 | 84.81% |

`src/conformance.ts` and `src/testing.ts` are shipped test support (the conformance suite and the
in-memory site), so their scores measure how well the repo's own tests pin them, not production paths.
`src/contract.ts` is low because most of it is static data (routes and schemas built at import time),
which `ignoreStatic` skips, and the rest is the hash and schema builders whose survivors the tests do not
pin.

### Per-test kill matrix

326 tests, keyed by file and test name. Full matrix (per test: kills, unique kills, candidate kind,
protected flag): `docs/research/kill-matrix.json`. Raw chunk reports are on the results branch.

| Group | Tests | Of which protected |
|-------|-------|--------------------|
| Zero-kill (kills no mutant) | 143 | 2 |
| Covered by others (every kill is also made by another test) | 94 | 39 |
| Unprotected zero-kill candidates | 141 | |
| Unprotected covered-by-others candidates | 55 | |

Protected means the file or test name matches the keep rules in `scripts/report-mutation.mjs`: auth,
keys (`keys-match`), the conformance suite, `planted` (tests that pin a planted failure), tokens,
secrets, and tests written for a fixed bug or regression. The match is a name heuristic that errs toward
keeping.

### Removal candidates (nothing removed)

196 unprotected tests in 13 files (141 zero-kill, 55 covered by others), by file:

| Test file | Tests | Unprotected zero-kill | Unprotected covered |
|---|---|---|---|
| test/admin.test.ts | 33 | 0 | 3 |
| test/client.test.ts | 6 | 0 | 4 |
| test/conformance.test.ts | 32 | 0 | 0 |
| test/content-delete.test.ts | 12 | 0 | 7 |
| test/content-tags.test.ts | 7 | 0 | 3 |
| test/contract-v0.1.0.test.ts | 27 | 25 | 1 |
| test/contract-v0.4.0.test.ts | 54 | 52 | 1 |
| test/contract-v0.5.0.test.ts | 65 | 64 | 1 |
| test/keys-match.test.ts | 2 | 0 | 0 |
| test/lists.test.ts | 4 | 0 | 2 |
| test/media-writes.test.ts | 16 | 0 | 8 |
| test/media.test.ts | 17 | 0 | 9 |
| test/mentions.test.ts | 25 | 0 | 16 |
| test/planted.test.ts | 26 | 0 | 0 |

How to read this before any pruning job uses it:

- **The 141 zero-kill figure is mostly one artifact.** 141 of them are in the three
  `contract-v0.*.test.ts` files (25 + 52 + 64 = 141), which compare the live contract to frozen JSON
  fixtures. The data they check is built at import time, so its mutants are static and ignored, and the
  tests kill nothing. They are the compatibility guard for released contract versions and are not
  redundant. Treat them as keep, not as candidates. Every other file has zero unprotected zero-kill tests.
- The real pruning surface is the 55 covered-by-others tests, mainly `mentions` (16), `media` (9),
  `media-writes` (8), `content-delete` (7). Candidates are per test, not joint: two tests that only cover
  each other are both flagged, and removing both loses kills. Re-run Stryker after each batch.
- A covered-by-others test may still pin a different assertion on the same mutant, or a behavior in code
  Stryker ignores. Check what it protects before cutting.
- Survived mutants (910) and no-coverage mutants (447) show behavior no test pins. Biggest gaps:
  `src/admin.ts` (375 survived, 279 uncovered), `src/conformance.ts` (172 survived), `src/server.ts`
  (152 survived). Adding tests there is worth more than trimming.

Nothing was deleted or changed in the source or the tests.

## Reproduce

```
npm ci
npm i --no-save @stryker-mutator/core@9.6.1 @stryker-mutator/vitest-runner@9.6.1
for c in contract server admin rest; do STRYKER_CHUNK=$c npx stryker run; done
node scripts/report-mutation.mjs --json
```

Stryker 10.0.0 has a Babel 8 parser bug, so 9.6.1 is pinned here.
