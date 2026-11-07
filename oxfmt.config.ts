import { defineConfig } from "oxfmt";
import { format } from "@dustinedwards/devkit/oxfmt";

export default defineConfig({
  ...format,
  ignorePatterns: [
    ...(format.ignorePatterns ?? []),
    // The frozen frame: the walk hashes it byte for byte (CLAUDE.md: never edit frame/).
    "frame/",
    // The registered study: the walk freezes the second reader's prompt hash, and the protocol and the task files
    // (hidden test names, patch hashes) are what the registration and the runs were hashed from.
    "prompts/",
    "protocol/",
    "tasks/",
    // The seal's installed dependencies.
    "tools/node_modules/",
  ],
});
