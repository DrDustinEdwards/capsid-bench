#!/usr/bin/env node
// One task file (tasks/<task_id>.json), checked. See tasks/README.md for the format.
//
//   node scripts/task.mjs check tasks/x.json    exits 1 on a malformed task

import { readFileSync } from "node:fs";
import { isMain } from "./net.mjs";

const SOURCES = ["swe-rebench", "swe-bench-live", "own"];
const SPLITS = ["pilot", "full", "excluded"];
// After the model's reliable knowledge cutoff (June 2026): the design's post-cutoff rule.
export const CUTOFF = "2026-06-30T23:59:59Z";

export function checkTask(task) {
  const problems = [];
  const str = (field) => typeof task[field] === "string" && task[field].length > 0;
  if (typeof task.task_id === "string" && !/^[A-Za-z0-9._-]{1,200}$/.test(task.task_id))
    problems.push(
      "task_id may hold only letters, digits, dot, underscore and hyphen (it names the file and reaches a shell)",
    );
  for (const field of [
    "task_id",
    "repo",
    "base_commit",
    "image",
    "problem_statement",
    "gold_patch",
    "issue_created_at",
  ]) {
    if (!str(field)) problems.push(`${field} must be a non-empty string`);
  }
  // These reach GITHUB_OUTPUT one per line, so a line break would write another output.
  for (const field of ["repo", "base_commit", "image"]) {
    if (typeof task[field] === "string" && /[\r\n]/.test(task[field]))
      problems.push(`${field} may not hold a line break (it is written to GITHUB_OUTPUT)`);
  }
  // The image holds the run's credentials while it runs, so it is named by content, not by a
  // tag someone else can move (scripts/image-digest.mjs writes the pin).
  if (str("image") && !/^[^\s@]+@sha256:[0-9a-f]{64}$/.test(task.image))
    problems.push("image must be pinned by digest: name:tag@sha256:<64 hex digits>");
  // The repo is cloned from https://github.com/<repo>.git, so another host must not fit.
  if (str("repo") && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(task.repo))
    problems.push("repo must be owner/name on GitHub (letters, digits, dot, underscore, hyphen)");
  if (!SOURCES.includes(task.source)) problems.push(`source must be one of ${SOURCES.join(", ")}`);
  if (!SPLITS.includes(task.split)) problems.push(`split must be one of ${SPLITS.join(", ")}`);
  if (!Array.isArray(task.fail_to_pass) || task.fail_to_pass.length === 0)
    problems.push("fail_to_pass must list at least one test");
  if (!Array.isArray(task.pass_to_pass)) problems.push("pass_to_pass must be a list");
  if (
    str("issue_created_at") &&
    !(Date.parse(task.issue_created_at) > Date.parse(CUTOFF)) &&
    task.split !== "excluded"
  ) {
    problems.push(
      `issue_created_at ${task.issue_created_at} is not after the cutoff ${CUTOFF}; such a task can only be split "excluded"`,
    );
  }
  if (task.source === "own") {
    if (!str("fix_commit"))
      problems.push("an own task needs fix_commit, the merged fix the hidden files come from");
    if (!Array.isArray(task.hidden_files) || task.hidden_files.length === 0)
      problems.push("an own task needs hidden_files, the test files its fix added");
    if (typeof task.setup !== "string")
      problems.push(
        "an own task needs setup, the install command run with network before the tests",
      );
  } else if (
    !task.harness ||
    typeof task.harness.dataset !== "string" ||
    typeof task.harness.split !== "string"
  ) {
    problems.push(
      "a benchmark task needs harness.dataset and harness.split, which the benchmark's harness loads it by",
    );
  }
  return problems;
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

if (isMain(import.meta.url)) {
  const [command, file] = process.argv.slice(2);
  load(file);
  if (command !== "check") {
    console.error(`task: unknown command ${command}`);
    process.exit(2);
  }
}
