import { defineConfig } from "oxlint";
import { base, node } from "@dustinedwards/devkit/oxlint";

export default defineConfig({
  extends: [base],
  rules: {
    // off in devkit 0.24.0
    "typescript/no-non-null-assertion": "off",
  },
  overrides: [{ files: ["bin/**", "test/**"], ...node }],
});
