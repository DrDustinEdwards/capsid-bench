#!/usr/bin/env node
// The treatment's second-turn message: what the verifier saw of the repository's
// EXISTING tests on the agent's diff, and nothing about the new tests that decide
// resolved. That is what a pull request's CI would show; the FAIL_TO_PASS tests come
// from the withheld test patch and are never named or counted here.
//
//   node scripts/verifier-message.mjs score.json   ->  prints the message

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function verifierResult(score) {
  if (!score?.environment?.ok || !score.hidden) {
    return "The verifier could not run the tests (an infrastructure problem, not your change). Judge your work from your own test runs.";
  }
  const { total, passed } = score.hidden.pass_to_pass;
  const failures = score.pass_to_pass_failures ?? [];
  if (failures.length === 0) return `All ${total} existing tests it ran passed.`;
  const listed = failures.slice(0, 50).map((name) => `- ${name}`).join("\n");
  const more = failures.length > 50 ? `\n- and ${failures.length - 50} more` : "";
  return `${passed} of ${total} existing tests passed. These failed:\n${listed}${more}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let score = null;
  try {
    score = JSON.parse(readFileSync(process.argv[2], "utf8"));
  } catch {
    // An unreadable score reads as the verifier not running.
  }
  const template = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "prompts", "verifier.md"), "utf8");
  process.stdout.write(template.replace("{{VERIFIER_RESULT}}", () => verifierResult(score)));
}
