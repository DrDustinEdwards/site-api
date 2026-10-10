#!/usr/bin/env node
// Summarise a StrykerJS run (job_d4d6135b5363). Measurement only: it reads every
// reports/mutation/*.json (one per chunk, see stryker.config.mjs), merges them, and prints the
// mutation score, a per-file table and the pruning CANDIDATES. It deletes nothing and decides
// nothing.
//
// Candidates:
//   - zero-kill: a test that kills no mutant.
//   - covered: every mutant the test kills is also killed by some other test. This is per test, not
//     joint: two tests that only cover each other both show up, and removing both loses kills.
// Protected (never candidates): auth, keys, the conformance suite, and tests written to pin a
// planted or fixed bug. Matched by file and test name; a heuristic that errs toward keeping.
//
// Pass --json to write docs/research/kill-matrix.json (per test: file, name, kills, unique kills,
// candidate kind, protected).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const DIR = resolve(ROOT, "reports/mutation");
const reports = readdirSync(DIR)
  .filter((name) => name.endsWith(".json"))
  .map((name) => JSON.parse(readFileSync(resolve(DIR, name), "utf8")));
if (reports.length === 0) {
  console.error("report-mutation: no reports/mutation/*.json. Run Stryker first (stryker.config.mjs).");
  process.exit(1);
}

const PROTECTED = /auth|key|conformance|planted|token|secret|fix|bug|regression|seen red/i;

// Test ids are per run, so across chunks a test is keyed by file and name.
const tests = new Map();
const counts = {};
const perFile = {};
const killers = new Map();
for (const report of reports) {
  const keyOf = new Map();
  for (const [file, entry] of Object.entries(report.testFiles ?? {})) {
    for (const test of entry.tests ?? []) {
      const key = `${file}::${test.name}`;
      keyOf.set(test.id, key);
      if (!tests.has(key)) tests.set(key, { file, name: test.name, kills: new Set() });
    }
  }
  for (const [file, entry] of Object.entries(report.files ?? {})) {
    const row = (perFile[file] ??= {});
    for (const mutant of entry.mutants ?? []) {
      counts[mutant.status] = (counts[mutant.status] ?? 0) + 1;
      row[mutant.status] = (row[mutant.status] ?? 0) + 1;
      const key = `${file}#${mutant.id}`;
      const by = mutant.killedBy ?? [];
      killers.set(key, by.length);
      for (const id of by) tests.get(keyOf.get(id))?.kills.add(key);
    }
  }
}

const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(2)}%` : "n/a");
const tally = (c) => {
  const killed = (c.Killed ?? 0) + (c.Timeout ?? 0);
  const survived = c.Survived ?? 0;
  const noCov = c.NoCoverage ?? 0;
  return { killed, survived, noCov, valid: killed + survived + noCov };
};
const total = tally(counts);

const rows = [];
for (const test of tests.values()) {
  let unique = 0;
  for (const key of test.kills) if (killers.get(key) === 1) unique += 1;
  const isProtected = PROTECTED.test(test.file) || PROTECTED.test(test.name);
  const kind = test.kills.size === 0 ? "zero-kill" : unique === 0 ? "covered" : "";
  rows.push({ file: test.file, name: test.name, kills: test.kills.size, unique, kind, protected: isProtected });
}
const zero = rows.filter((r) => r.kind === "zero-kill");
const covered = rows.filter((r) => r.kind === "covered");

console.log(`Reports merged: ${reports.length}`);
console.log("Mutant status counts:", counts);
console.log(`Mutation score (killed+timeout over all valid): ${pct(total.killed, total.valid)}`);
console.log(`Mutation score over covered code: ${pct(total.killed, total.killed + total.survived)}`);
console.log("\n| File | Killed | Timeout | Survived | No coverage | Score |\n|---|---|---|---|---|---|");
for (const [file, c] of Object.entries(perFile).sort()) {
  const t = tally(c);
  console.log(`| ${file} | ${c.Killed ?? 0} | ${c.Timeout ?? 0} | ${t.survived} | ${t.noCov} | ${pct(t.killed, t.valid)} |`);
}
console.log(`\nTests in the kill matrix: ${rows.length}`);
console.log(`Zero-kill tests: ${zero.length} (${zero.filter((r) => r.protected).length} protected)`);
console.log(`Covered-by-others tests: ${covered.length} (${covered.filter((r) => r.protected).length} protected)`);
console.log(
  `Unprotected candidates: ${zero.filter((r) => !r.protected).length} zero-kill, ${covered.filter((r) => !r.protected).length} covered`,
);
const byFile = {};
for (const r of rows) {
  const f = (byFile[r.file] ??= { tests: 0, zero: 0, covered: 0 });
  f.tests += 1;
  if (!r.protected && r.kind === "zero-kill") f.zero += 1;
  if (!r.protected && r.kind === "covered") f.covered += 1;
}
console.log("\n| Test file | Tests | Unprotected zero-kill | Unprotected covered |\n|---|---|---|---|");
for (const [file, f] of Object.entries(byFile).sort()) console.log(`| ${file} | ${f.tests} | ${f.zero} | ${f.covered} |`);

if (process.argv.includes("--json")) {
  mkdirSync(resolve(ROOT, "docs/research"), { recursive: true });
  writeFileSync(resolve(ROOT, "docs/research/kill-matrix.json"), JSON.stringify(rows, null, 2) + "\n");
  console.log("Wrote docs/research/kill-matrix.json");
}
