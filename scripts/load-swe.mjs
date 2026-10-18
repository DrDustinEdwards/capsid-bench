#!/usr/bin/env node
// Write tasks/<instance_id>.json for chosen instances of a SWE-bench-format dataset on
// Hugging Face, read through the public datasets-server API.
//
//   node scripts/load-swe.mjs --dataset nebius/SWE-rebench-leaderboard --config default \
//     --split <window> --bench-split pilot --ids "a__b-1 c__d-2"
//
// The rows are data from outside, written as JSON and never executed. Each task is
// checked by scripts/task.mjs's rules before it is written, so an instance dated before
// the model's cutoff is refused here rather than at run time. The image name is the
// row's own when it carries one, else the SWE-bench harness's naming under the given
// namespace; check-gold confirms it pulls before any model run.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkTask } from "./task.mjs";

// SWE-bench stores the two test lists as JSON text; some exports store real arrays.
export function testList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.trim()) {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String);
  }
  return [];
}

export function imageFor(row, namespace) {
  if (typeof row.docker_image === "string" && row.docker_image) return row.docker_image;
  if (typeof row.image_name === "string" && row.image_name) return row.image_name;
  return `${namespace}/sweb.eval.x86_64.${row.instance_id.replace(/__/g, "_1776_").toLowerCase()}:latest`;
}

export function taskFromRow(row, { source, dataset, split, benchSplit, namespace }) {
  return {
    task_id: row.instance_id,
    source,
    split: benchSplit,
    repo: row.repo,
    issue_created_at: row.created_at,
    base_commit: row.base_commit,
    image: imageFor(row, namespace),
    problem_statement: row.problem_statement,
    gold_patch: row.patch,
    fail_to_pass: testList(row.FAIL_TO_PASS),
    pass_to_pass: testList(row.PASS_TO_PASS),
    harness: { dataset, split, namespace },
  };
}

async function rows(dataset, config, split) {
  const all = [];
  for (let offset = 0; ; offset += 100) {
    const url = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(dataset)}&config=${encodeURIComponent(config)}&split=${encodeURIComponent(split)}&offset=${offset}&length=100`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    const page = await response.json();
    all.push(...page.rows.map((r) => r.row));
    if (page.rows.length < 100 || all.length >= page.num_rows_total) return all;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = Object.fromEntries(
    process.argv
      .slice(2)
      .reduce((pairs, v, i, a) => (i % 2 === 0 ? [...pairs, [v.replace(/^--/, ""), a[i + 1]]] : pairs), [])
  );
  const ids = new Set((args.ids ?? "").split(/\s+/).filter(Boolean));
  if (!args.dataset || !args.split || !args["bench-split"] || ids.size === 0) {
    console.error("usage: node scripts/load-swe.mjs --dataset D --split S --bench-split pilot|full --ids \"id1 id2\" [--config default] [--source swe-rebench] [--namespace swerebench]");
    process.exit(2);
  }
  const opts = {
    source: args.source ?? "swe-rebench",
    dataset: args.dataset,
    split: args.split,
    benchSplit: args["bench-split"],
    namespace: args.namespace ?? "swerebench",
  };
  const found = (await rows(args.dataset, args.config ?? "default", args.split)).filter((r) => ids.has(r.instance_id));
  let bad = 0;
  for (const row of found) {
    const task = taskFromRow(row, opts);
    const problems = checkTask(task);
    if (problems.length) {
      bad++;
      console.error(`${row.instance_id}: not written:\n  ${problems.join("\n  ")}`);
      continue;
    }
    writeFileSync(join("tasks", `${task.task_id}.json`), `${JSON.stringify(task, null, 2)}\n`);
    console.log(`wrote tasks/${task.task_id}.json (${task.fail_to_pass.length} FAIL_TO_PASS, ${task.pass_to_pass.length} PASS_TO_PASS)`);
  }
  const missing = [...ids].filter((id) => !found.some((r) => r.instance_id === id));
  if (missing.length) console.error(`not in ${args.dataset} ${args.split}: ${missing.join(", ")}`);
  if (bad || missing.length) process.exit(1);
}
