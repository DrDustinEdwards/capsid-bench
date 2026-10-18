#!/usr/bin/env node
// The baseline's claim, by the rule fixed before any run (the design's section 4): the
// last non-empty line of Claude Code's final message is `BENCH-RESULT: DONE` for a
// success claim. Anything else, including no such line, an error result or no result
// at all, is no claim. Matched exactly apart from surrounding whitespace and markdown
// emphasis or code ticks, which a model adds without meaning anything by them.
//
//   node scripts/parse-claim.mjs result.json   ->  prints true or false
//
// The treatment's claim is not parsed here: Capsid reads it from the treatment's job.

import { readFileSync } from "node:fs";

export function parseClaim(result) {
  if (!result || result.is_error || typeof result.result !== "string") return false;
  const lines = result.result
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines.at(-1) ?? "";
  return last.replace(/^[*_`]+|[*_`]+$/g, "").trim() === "BENCH-RESULT: DONE";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let result = null;
  try {
    result = JSON.parse(readFileSync(process.argv[2], "utf8"));
  } catch {
    // An unreadable result is no claim.
  }
  process.stdout.write(parseClaim(result) ? "true" : "false");
}
