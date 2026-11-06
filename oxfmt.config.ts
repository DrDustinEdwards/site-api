import { defineConfig } from "oxfmt";
import { format } from "@dustinedwards/devkit/oxfmt";

export default defineConfig({
  ...format,
  // The contract fixtures are records of earlier builds, kept as they were written.
  ignorePatterns: [...(format.ignorePatterns ?? []), "test/fixtures/"],
});
