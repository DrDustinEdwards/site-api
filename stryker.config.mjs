// StrykerJS mutation baseline (job_d4d6135b5363). Measurement only: not a gate, not in CI, and not a
// dependency. Run in chunks so a finished chunk is never lost:
//
//   npm i --no-save @stryker-mutator/core@9.6.1 @stryker-mutator/vitest-runner@9.6.1
//   for c in contract server admin rest; do STRYKER_CHUNK=$c npx stryker run; done
//   node scripts/report-mutation.mjs --json
//
// Each chunk writes reports/mutation/<chunk>.json and its own incremental file.
// scripts/report-mutation.mjs merges every JSON report it finds.
import process from "node:process";

const ALL = ["src/**/*.ts"];
const CHUNKS = {
  contract: ["src/contract.ts"],
  server: ["src/server.ts"],
  admin: ["src/admin.ts"],
};
CHUNKS.rest = [...ALL, ...Object.values(CHUNKS).flat().map((glob) => `!${glob}`)];

const chunk = process.env.STRYKER_CHUNK;
if (chunk && !CHUNKS[chunk]) {
  throw new Error(`Unknown STRYKER_CHUNK "${chunk}"; one of ${Object.keys(CHUNKS).join(", ")}`);
}
const name = chunk ?? "mutation";

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  coverageAnalysis: "perTest",
  disableBail: true,
  incremental: true,
  incrementalFile: `reports/stryker-incremental-${name}.json`,
  mutate: [...(chunk ? CHUNKS[chunk] : ALL), "!**/*.d.ts"],
  ignoreStatic: true,
  reporters: ["json", "clear-text", "progress"],
  jsonReporter: { fileName: `reports/mutation/${name}.json` },
  concurrency: 4,
  timeoutMS: 30000,
  tempDirName: ".stryker-tmp",
};
