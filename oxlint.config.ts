import { defineConfig } from "oxlint";
import { base, node } from "@dustinedwards/devkit/oxlint";

export default defineConfig({
  extends: [base],
  overrides: [{ files: ["bin/**", "test/**"], ...node }],
});
