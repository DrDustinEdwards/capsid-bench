import { defineConfig } from "oxlint";
import { base, node } from "@dustinedwards/devkit/oxlint";

export default defineConfig({
  extends: [base],
  // frame/ is the frozen task frame: the walk refuses one whose hash changed, so lint never reads it.
  ignorePatterns: ["frame/", "tools/node_modules/"],
  // Node's globals for the scripts, the seal's dependency folder and the tests.
  overrides: [{ files: ["scripts/**", "tools/**", "test/**"], ...node }],
});
