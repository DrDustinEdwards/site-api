// The weekly mutation run of the code-map workflow (.github/workflows/code-map.yml), one chunk at a
// time; never a gate. Each chunk writes reports/mutation/<chunk>.json and its own incremental file.
import process from "node:process";

const ALL = ["src/**/*.ts"];
const CHUNKS = {
  contract: ["src/contract.ts", "src/contract/**/*.ts"],
  server: ["src/server.ts", "src/server/**/*.ts"],
  admin: ["src/admin.ts", "src/admin/**/*.ts"],
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
