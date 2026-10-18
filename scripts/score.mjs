#!/usr/bin/env node
// Score one diff against one task's hidden tests.
//
//   node scripts/score.mjs tasks/x.json diff.patch out.json
//
// Writes { environment: { ok, reason }, hidden: { fail_to_pass, pass_to_pass },
// pass_to_pass_failures: [...] }, the counts /bench/score takes. The treatment's
// verifier runs the same scoring and hands the agent only pass_to_pass_failures: the
// repo's existing tests, which a pull request's CI would run, and never the new tests
// that decide resolved.
//
// A test that did not run is in neither count, so its total comes up short and Capsid
// leaves the run unjudged rather than failed (src/bench.ts runOutcome). Only a machine
// failure (no report at all, an image that would not start) is reported as an
// environment failure; a patch that does not apply is the agent's result, scored as
// every hidden test failing.
//
// Benchmark tasks are scored by the benchmark's own harness (SWE-rebench's fork of the
// SWE-bench harness, installed by the workflow at a pinned ref), which pulls the task's
// image, applies the diff and the withheld test patch, and writes report.json. Own tasks
// are scored here: the repo at its base commit, setup run with network, then the diff
// and the fix's test files, then each test command with no network, passing on exit 0.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The report's two lists for one instance, as counts over the task's own test lists.
export function countsFromReport(task, instanceReport) {
  if (!instanceReport) return null;
  if (instanceReport.patch_successfully_applied === false) {
    return {
      hidden: {
        fail_to_pass: { total: task.fail_to_pass.length, passed: 0 },
        pass_to_pass: { total: task.pass_to_pass.length, passed: 0 },
      },
      pass_to_pass_failures: ["the diff did not apply to the base commit"],
    };
  }
  const status = instanceReport.tests_status ?? {};
  const pair = (names, lists) => {
    const success = new Set(lists?.success ?? []);
    const failure = new Set(lists?.failure ?? []);
    const ran = names.filter((n) => success.has(n) || failure.has(n));
    return { counts: { total: ran.length, passed: ran.filter((n) => success.has(n)).length }, failed: ran.filter((n) => failure.has(n)) };
  };
  const f2p = pair(task.fail_to_pass, status.FAIL_TO_PASS);
  const p2p = pair(task.pass_to_pass, status.PASS_TO_PASS);
  return { hidden: { fail_to_pass: f2p.counts, pass_to_pass: p2p.counts }, pass_to_pass_failures: p2p.failed };
}

// What the dataset defines for the base commit (see scoreBenchmark).
export function emptyDiffScore(task) {
  return {
    environment: { ok: true, reason: null },
    hidden: {
      fail_to_pass: { total: task.fail_to_pass.length, passed: 0 },
      pass_to_pass: { total: task.pass_to_pass.length, passed: task.pass_to_pass.length },
    },
    pass_to_pass_failures: [],
  };
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function scoreBenchmark(task, diff, work) {
  // The harness skips an empty patch and writes no report. The dataset defines the
  // answer for the base commit: every FAIL_TO_PASS test fails there and every
  // PASS_TO_PASS test passes. Without this, a run that changed nothing and claimed
  // done would be unjudged instead of a false claim.
  if (!diff.trim()) return emptyDiffScore(task);
  const preds = join(work, "preds.json");
  writeFileSync(preds, JSON.stringify([{ instance_id: task.task_id, model_name_or_path: "bench", model_patch: diff }]));
  const runId = `bench-${process.pid}`;
  const harness = run(
    "python3",
    [
      "-m",
      "swebench.harness.run_evaluation",
      "--dataset_name",
      task.harness.dataset,
      "--split",
      task.harness.split,
      "--instance_ids",
      task.task_id,
      "--predictions_path",
      preds,
      "--max_workers",
      "1",
      "--run_id",
      runId,
      "--namespace",
      task.harness.namespace ?? "swerebench",
      "--cache_level",
      "instance",
      "--timeout",
      "1800",
    ],
    { cwd: work }
  );
  process.stderr.write(harness.out.slice(-4000));
  const reportPath = join(work, "logs", "run_evaluation", runId, "bench", task.task_id, "report.json");
  if (!existsSync(reportPath)) return { environment: { ok: false, reason: `the harness wrote no report (exit ${harness.status})` } };
  const counts = countsFromReport(task, JSON.parse(readFileSync(reportPath, "utf8"))[task.task_id]);
  if (!counts) return { environment: { ok: false, reason: "the harness report has no entry for this task" } };
  return { environment: { ok: true, reason: null }, ...counts };
}

function scoreOwn(task, diffFile, work) {
  const repo = join(work, "repo");
  const steps = [
    ["git", ["clone", "--quiet", `https://github.com/${task.repo}.git`, repo]],
    ["git", ["-C", repo, "checkout", "--quiet", task.base_commit]],
  ];
  for (const [cmd, args] of steps) {
    const r = run(cmd, args);
    if (r.status !== 0) return { environment: { ok: false, reason: `${cmd} ${args[0] === "-C" ? args[2] : args[0]} failed: ${r.out.slice(-300)}` } };
  }
  // Setup runs with network on the base commit, before any agent byte is on disk, so the
  // agent's code never runs with network. Dependencies the diff adds are not installed.
  const setup = run("docker", ["run", "--rm", "-v", `${repo}:/testbed`, "-w", "/testbed", task.image, "sh", "-c", task.setup]);
  if (setup.status !== 0) return { environment: { ok: false, reason: `setup failed: ${setup.out.slice(-300)}` } };
  const diff = readFileSync(diffFile, "utf8");
  if (diff.trim()) {
    const applied = run("git", ["-C", repo, "apply", "--whitespace=nowarn", diffFile]);
    if (applied.status !== 0) {
      return {
        environment: { ok: true, reason: null },
        ...countsFromReport(task, { patch_successfully_applied: false }),
      };
    }
  }
  const hidden = run("git", ["-C", repo, "fetch", "--quiet", "origin", task.fix_commit]);
  const checkout = hidden.status === 0 ? run("git", ["-C", repo, "checkout", task.fix_commit, "--", ...task.hidden_files]) : hidden;
  if (checkout.status !== 0) return { environment: { ok: false, reason: `could not stage the hidden test files: ${checkout.out.slice(-300)}` } };
  const passes = (command) =>
    run("docker", ["run", "--rm", "--network", "none", "-v", `${repo}:/testbed`, "-w", "/testbed", task.image, "sh", "-c", command]).status === 0;
  const f2p = task.fail_to_pass.filter(passes).length;
  const p2pFailed = task.pass_to_pass.filter((c) => !passes(c));
  return {
    environment: { ok: true, reason: null },
    hidden: {
      fail_to_pass: { total: task.fail_to_pass.length, passed: f2p },
      pass_to_pass: { total: task.pass_to_pass.length, passed: task.pass_to_pass.length - p2pFailed.length },
    },
    pass_to_pass_failures: p2pFailed,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [taskFile, diffFile, out] = process.argv.slice(2);
  const task = JSON.parse(readFileSync(taskFile, "utf8"));
  const work = join(process.env.RUNNER_TEMP ?? "/tmp", `score-${process.pid}`);
  mkdirSync(work, { recursive: true });
  let result;
  try {
    result = task.source === "own" ? scoreOwn(task, diffFile, work) : scoreBenchmark(task, readFileSync(diffFile, "utf8"), work);
  } catch (err) {
    result = { environment: { ok: false, reason: `the scorer threw: ${err instanceof Error ? err.message : String(err)}` } };
  }
  writeFileSync(out, JSON.stringify(result));
  console.log(JSON.stringify({ environment: result.environment, hidden: result.hidden ?? null }));
}
