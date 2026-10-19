#!/usr/bin/env node
// The /bench/score body for one run, from the scorer's output and Claude Code's JSON
// results (one per turn; the treatment has two).
//
//   node scripts/report.mjs out.json --run bench_x --arm baseline --score score.json \
//     --result turn1.json [--result turn2.json] [--claim true] [--job job_x] \
//     [--image-bytes N] [--model claude-sonnet-5-5] [--version 2.x.y] [--machine-failed reason]
//     [--timed-out true]
//
// Usage is summed across turns. total_cost_usd is Claude Code's own client-side
// estimate at API list prices: on the subscription it is not money spent, and the
// design records it as the API-rate equivalent. A missing or unreadable result
// contributes nothing, so a run that never reached the model reports null usage
// rather than zero.

import { readFileSync, writeFileSync } from "node:fs";

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function sumUsage(results) {
  const real = results.filter((r) => r && typeof r === "object");
  if (real.length === 0) return { cost_usd: null, turns: null, duration_ms: null, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_creation_tokens: null };
  const sum = (pick) => real.reduce((total, r) => total + (Number.isFinite(pick(r)) ? pick(r) : 0), 0);
  return {
    cost_usd: sum((r) => r.total_cost_usd),
    turns: sum((r) => r.num_turns),
    duration_ms: sum((r) => r.duration_ms),
    input_tokens: sum((r) => r.usage?.input_tokens),
    output_tokens: sum((r) => r.usage?.output_tokens),
    cache_read_tokens: sum((r) => r.usage?.cache_read_input_tokens),
    cache_creation_tokens: sum((r) => r.usage?.cache_creation_input_tokens),
  };
}

// Why a model arm's run is unjudged rather than scored, or null. Only the machine's
// failures are unjudged: Claude Code never started, or stopped with an error during
// execution (an API or usage-limit failure); those are rerun once and then excluded.
// Running out of time or turns is the agent's own outcome and is scored, because
// dropping the slow runs would drop the runs most likely to fail (Grok's review,
// change 1). A run killed by the clock leaves no result, so the workflow says so.
export function modelFailure(arm, results, timedOut = false) {
  if (arm !== "baseline" && arm !== "treatment") return null;
  const failed = results.find((r) => r && r.subtype === "error_during_execution");
  if (failed) return `Claude Code stopped with an error during execution: ${String(failed.result ?? "").slice(0, 200)}`;
  if (timedOut) return null;
  const first = results[0];
  if (!first || typeof first !== "object") return "Claude Code produced no result and was not killed at the time budget (it never started)";
  return null;
}

export function buildReport({ run, arm, score, results, claim, job, imageBytes, model, version, machineFailed, timedOut }) {
  const failure = machineFailed || modelFailure(arm, results, timedOut === true);
  const environment = failure ? { ok: false, reason: failure } : (score?.environment ?? { ok: false, reason: "the scorer produced no output" });
  return {
    run_id: run,
    environment,
    ...(environment.ok && score.hidden ? { hidden: score.hidden } : {}),
    // The treatment's claim is read by Capsid from its job; the report carries none.
    claimed_done: arm === "treatment" ? null : claim === true,
    capsid_job_id: job || null,
    usage: { model: model || null, claude_code_version: version || null, ...sumUsage(results) },
    image_bytes: Number.isInteger(imageBytes) ? imageBytes : null,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [out, ...rest] = process.argv.slice(2);
  const opts = { results: [] };
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (flag === "--run") opts.run = value;
    else if (flag === "--arm") opts.arm = value;
    else if (flag === "--score") opts.score = readJson(value);
    else if (flag === "--result") opts.results.push(readJson(value));
    else if (flag === "--claim") opts.claim = value === "true";
    else if (flag === "--job") opts.job = value;
    else if (flag === "--image-bytes") opts.imageBytes = value ? Number(value) : null;
    else if (flag === "--model") opts.model = value;
    else if (flag === "--version") opts.version = value;
    else if (flag === "--machine-failed") opts.machineFailed = value;
    else if (flag === "--timed-out") opts.timedOut = value === "true";
    else {
      console.error(`report: unknown flag ${flag}`);
      process.exit(2);
    }
  }
  writeFileSync(out, JSON.stringify(buildReport(opts)));
}
