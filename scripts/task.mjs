#!/usr/bin/env node
// One task file (tasks/<task_id>.json), checked and read. See tasks/README.md for the
// format.
//
//   node scripts/task.mjs check tasks/x.json              exits 1 on a malformed task
//   node scripts/task.mjs register tasks/x.json out.json  the /bench/tasks body
//   node scripts/task.mjs stage tasks/x.json <dir>        <dir>/agent/problem.md, the only task
//                                                         file the agent's container mounts, and
//                                                         <dir>/private/ (gold.patch, setup.sh),
//                                                         which it never sees; image, source,
//                                                         repo and base_commit to $GITHUB_OUTPUT
//
// The hidden tests and the upstream fix live in the same file, which is safe because
// nothing from this repo is mounted into the agent's container apart from the staged
// problem statement.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SOURCES = ["swe-rebench", "swe-bench-live", "own"];
const SPLITS = ["pilot", "full", "excluded"];
// After the model's reliable knowledge cutoff (June 2026): the design's post-cutoff rule.
export const CUTOFF = "2026-06-30T23:59:59Z";

export function checkTask(task) {
  const problems = [];
  const str = (field) => typeof task[field] === "string" && task[field].length > 0;
  if (typeof task.task_id === "string" && !/^[A-Za-z0-9._-]{1,200}$/.test(task.task_id)) problems.push("task_id may hold only letters, digits, dot, underscore and hyphen (it names the file and reaches a shell)");
  for (const field of ["task_id", "repo", "base_commit", "image", "problem_statement", "gold_patch", "issue_created_at"]) {
    if (!str(field)) problems.push(`${field} must be a non-empty string`);
  }
  if (!SOURCES.includes(task.source)) problems.push(`source must be one of ${SOURCES.join(", ")}`);
  if (!SPLITS.includes(task.split)) problems.push(`split must be one of ${SPLITS.join(", ")}`);
  if (!Array.isArray(task.fail_to_pass) || task.fail_to_pass.length === 0) problems.push("fail_to_pass must list at least one test");
  if (!Array.isArray(task.pass_to_pass)) problems.push("pass_to_pass must be a list");
  if (str("issue_created_at") && !(Date.parse(task.issue_created_at) > Date.parse(CUTOFF)) && task.split !== "excluded") {
    problems.push(`issue_created_at ${task.issue_created_at} is not after the cutoff ${CUTOFF}; such a task can only be split "excluded"`);
  }
  if (task.source === "own") {
    if (!str("fix_commit")) problems.push("an own task needs fix_commit, the merged fix the hidden files come from");
    if (!Array.isArray(task.hidden_files) || task.hidden_files.length === 0) problems.push("an own task needs hidden_files, the test files its fix added");
    if (typeof task.setup !== "string") problems.push("an own task needs setup, the install command run with network before the tests");
  } else if (!task.harness || typeof task.harness.dataset !== "string" || typeof task.harness.split !== "string") {
    problems.push("a benchmark task needs harness.dataset and harness.split, which the benchmark's harness loads it by");
  }
  return problems;
}

export function registrationOf(task) {
  return {
    task: {
      task_id: task.task_id,
      source: task.source,
      split: task.split,
      repo: task.repo,
      issue_created_at: task.issue_created_at,
      fail_to_pass_count: task.fail_to_pass.length,
      pass_to_pass_count: task.pass_to_pass.length,
    },
  };
}

function load(file) {
  const task = JSON.parse(readFileSync(file, "utf8"));
  const problems = checkTask(task);
  if (problems.length) {
    console.error(`task: ${file} is malformed:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  return task;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, file, out] = process.argv.slice(2);
  const task = load(file);
  if (command === "register") {
    writeFileSync(out, JSON.stringify(registrationOf(task)));
  } else if (command === "stage") {
    mkdirSync(join(out, "agent"), { recursive: true });
    mkdirSync(join(out, "private"), { recursive: true });
    writeFileSync(join(out, "agent", "problem.md"), task.problem_statement);
    writeFileSync(join(out, "private", "gold.patch"), task.gold_patch);
    writeFileSync(join(out, "private", "setup.sh"), task.setup ?? "");
    if (process.env.GITHUB_OUTPUT) {
      appendFileSync(process.env.GITHUB_OUTPUT, `image=${task.image}\nsource=${task.source}\nbase_commit=${task.base_commit}\nrepo=${task.repo}\n`);
    }
  } else if (command !== "check") {
    console.error(`task: unknown command ${command}`);
    process.exit(2);
  }
}
