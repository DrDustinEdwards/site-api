// The weekly mutation run of the code-map workflow (.github/workflows/code-map.yml), one chunk at a
// time; never a gate. Each chunk writes reports/mutation/<chunk>.json and its own incremental file.
import { chunkedStryker } from "@dustinedwards/devkit/stryker";

export default chunkedStryker({
  all: ["src/**/*.ts"],
  chunks: {
    contract: ["src/contract.ts", "src/contract/**/*.ts"],
    server: ["src/server.ts", "src/server/**/*.ts"],
    admin: ["src/admin.ts", "src/admin/**/*.ts"],
  },
});
