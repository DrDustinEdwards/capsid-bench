#!/usr/bin/env node
// The walk (protocol section 4, "Audit" and "Draw", decided 2026-10-21): the frozen frame
// permuted once with the registered seed, then each candidate in that order skipped at the
// repository cap, or prepared, validated, leakage-screened and audited, until N tasks are
// accepted or the permutation ends. Then the second reader's subset, and replacements for
// any task either reader takes out.
//
// All state is one append-only log (log.jsonl on the `walk` branch), one record a line,
// and the instances that passed both gates (instances/<task_id>.json). Everything below
// is replayed from that log, so a rerun at any point picks up where the last record left
// off. The walk is strictly in order: no candidate is considered until the one before it
// is recorded, including the author's audit decision.
//
//   node scripts/walk.mjs start --dir <walk dir> --beacon seed.json --n <registered N> --registration <sha256>
//   node scripts/walk.mjs step --frame frame/candidates.json --repos frame/repos.json --dir <walk dir>
//   node scripts/walk.mjs open-audits --dir <walk dir> --repo owner/name
//   node scripts/walk.mjs record --dir <walk dir> --issue <n> --commenter <login> --body-file <f> \
//     --author <login> [--second-reader <login>]
//   node scripts/walk.mjs status --frame frame/candidates.json --dir <walk dir>
//
// `step` does one thing and prints it as JSON: { action, ... }. Actions: skip (repository
// at the cap), validate (one candidate through preparation, validation and the leakage
// screen), draw-second (the second reader's subset, fixed in the log), wait (an audit is
// open) and done.

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { REPO_CAP, rng } from "./analyze.mjs";
import { github, leakage, prepare } from "./prepare-candidate.mjs";

// The frozen frame (run 39487118514, frame/candidates.json). The walk refuses any other.
export const FRAME_SHA256 = "68cbf6d3d73a3730e13aad43b2bfcb54df72cfaff2cee1a6e44930c567f006e";

// The fixed exclusion list (protocol section 4, step 6), by the code a reader writes.
export const REASONS = {
  "tests-not-issue": "the tests do not test the issue",
  "issue-states-solution": "the frozen issue states the solution",
  "network-or-time": "the tests depend on network or time",
  ambiguous: "the issue is ambiguous between incompatible fixes",
};

export const SECOND_EACH = 10;

// Fisher-Yates with the analysis script's seeded generator, over the frame's order.
export function permutation(ids, seed) {
  const out = [...ids];
  const random = rng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export const readLog = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

// The walk's state, replayed from the log.
export function replay(candidates, log) {
  const start = log[0];
  if (start?.event !== "start") throw new Error("the log has no start record");
  const byId = new Map(candidates.map((c) => [c.task_id, c]));
  const order = permutation(candidates.map((c) => c.task_id), start.seed);
  const records = log.slice(1);
  const of = (event, reader) => records.filter((r) => r.event === event && (!reader || r.reader === reader));
  const decision = (reader, id) => of("audit", reader).find((r) => r.task_id === id);
  const passed = of("gates passed");
  const authorIn = passed.filter((r) => decision("author", r.task_id)?.decision === "in");
  const authorOut = passed.filter((r) => decision("author", r.task_id)?.decision === "out");
  const secondSet = of("second reader set")[0]?.tasks ?? null;
  const drawnAt = of("second reader set")[0] ? log.indexOf(of("second reader set")[0]) : Infinity;
  // Replacements: author accepts recorded after the subset was drawn join the second
  // reader's set (the set grows only by them).
  const replacements = authorIn.filter((r) => log.indexOf(decision("author", r.task_id)) > drawnAt).map((r) => r.task_id);
  const secondTasks = secondSet ? [...secondSet, ...replacements] : [];
  const accepted = authorIn.filter((r) => decision("second", r.task_id)?.decision !== "out").map((r) => r.task_id);
  const considered = records.filter((r) => Number.isInteger(r.position)).reduce((m, r) => Math.max(m, r.position), 0);
  const perRepo = new Map();
  for (const id of accepted) perRepo.set(byId.get(id).repo, (perRepo.get(byId.get(id).repo) ?? 0) + 1);
  return {
    seed: start.seed,
    n: start.n,
    order,
    byId,
    next: considered + 1,
    passed,
    authorIn: authorIn.map((r) => r.task_id),
    authorOut: authorOut.map((r) => r.task_id),
    pendingAuthor: passed.filter((r) => !decision("author", r.task_id)).map((r) => r.task_id),
    secondSet,
    pendingSecond: secondTasks.filter((id) => !decision("second", id)),
    accepted,
    perRepo,
    opened: of("audit opened"),
  };
}

// The second reader's subset (protocol, "Audit"): 10 of the author's accepts and 10 of the
// author's audit rejects drawn with the registered seed; a short group gives all of itself
// and the rest comes from the other; fewer than 20 audited means all of them. Returned in
// permutation order.
export function secondSubset(state) {
  const pick = (ids, salt) => permutation(ids, `${state.seed}:second reader:${salt}`);
  const inn = pick(state.authorIn, "in");
  const out = pick(state.authorOut, "out");
  let chosen;
  if (inn.length + out.length <= 2 * SECOND_EACH) chosen = [...inn, ...out];
  else {
    const takeIn = Math.min(inn.length, SECOND_EACH + Math.max(0, SECOND_EACH - out.length));
    const takeOut = Math.min(out.length, 2 * SECOND_EACH - takeIn);
    chosen = [...inn.slice(0, takeIn), ...out.slice(0, takeOut)];
  }
  const rank = new Map(state.order.map((id, i) => [id, i]));
  return chosen.sort((a, b) => rank.get(a) - rank.get(b));
}

// What happens next, from the state alone.
export function nextAction(state) {
  if (state.pendingAuthor.length) return { action: "wait", reader: "author", tasks: state.pendingAuthor };
  if (state.pendingSecond.length) return { action: "wait", reader: "second", tasks: state.pendingSecond };
  if (state.accepted.length < state.n && state.next <= state.order.length) {
    const taskId = state.order[state.next - 1];
    const repo = state.byId.get(taskId).repo;
    const kind = (state.perRepo.get(repo) ?? 0) >= REPO_CAP ? "skip" : "validate";
    return { action: kind, position: state.next, task_id: taskId, repo };
  }
  if (!state.secondSet) return { action: "draw-second", tasks: secondSubset(state) };
  return { action: "done", accepted: state.accepted.length, n: state.n, unmet: state.accepted.length < state.n };
}

// A reader's comment: `in`, or `out <code>` followed by the quoted reason.
export function parseDecision(text) {
  const body = String(text ?? "").trim();
  const m = body.match(/^(in|out)\b[ \t]*([a-z-]*)\s*([\s\S]*)$/i);
  if (!m) return null;
  const decision = m[1].toLowerCase();
  if (decision === "in") return m[2] || m[3] ? null : { decision };
  const reason = m[2].toLowerCase();
  const quote = m[3].trim();
  if (!REASONS[reason] || !quote) return null;
  return { decision, reason, quote };
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

// A fence longer than any run of backticks in the text, so nothing inside renders: no
// mention, no cross-reference to another repository, no markup.
export function fenced(text, lang = "") {
  const longest = Math.max(2, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
}

const LIMIT = 15000;
const clip = (text, link) => (text.length <= LIMIT ? text : `${text.slice(0, LIMIT)}\n… cut at ${LIMIT} characters; the whole file: ${link}`);

// The audit issue's text. Never carries the other reader's decision.
export function auditBody(instance, reader, fileUrl) {
  const reasons = Object.entries(REASONS).map(([code, text]) => `- \`${code}\`: ${text}`).join("\n");
  return [
    `Audit by the ${reader === "author" ? "author" : "second reader"}, against the fixed exclusion list (protocol section 4, step 6).`,
    "",
    "Answer with one comment: `in`, or `out <code>` followed by a quote from the issue, tests or patch that shows the reason. The first valid comment is recorded and closes this issue.",
    "",
    reasons,
    "",
    "### The frozen issue",
    fenced(clip(instance.problem_statement, fileUrl)),
    "",
    `### The hidden tests (FAIL_TO_PASS, ${instance.FAIL_TO_PASS.length})`,
    fenced(clip(instance.FAIL_TO_PASS.join("\n"), fileUrl)),
    "",
    "### The test patch",
    fenced(clip(instance.test_patch, fileUrl), "diff"),
    "",
    "### The gold patch",
    fenced(clip(instance.patch, fileUrl), "diff"),
    "",
    `Repository ${fenced(instance.repo)} at base commit ${fenced(instance.base_commit)}; the whole task file is ${fileUrl}.`,
  ].join("\n");
}

function append(dir, record) {
  appendFileSync(join(dir, "log.jsonl"), `${JSON.stringify({ ...record, at: new Date().toISOString() })}\n`);
}

function loadFrame(path) {
  if (sha256(path) !== FRAME_SHA256) throw new Error(`${path} is not the frozen frame`);
  return JSON.parse(readFileSync(path, "utf8"));
}

// One candidate through the three mechanical gates, in the protocol's order.
async function gates(dir, candidate, recipe, position) {
  const base = { position, task_id: candidate.task_id, repo: candidate.repo };
  const instance = await prepare(github(process.env.GITHUB_TOKEN), candidate, recipe);
  if (instance.excluded) return { ...base, event: "excluded", step: "preparation", reason: instance.excluded };
  const work = mkdtempSync(join(tmpdir(), "walk-"));
  writeFileSync(join(work, "instance.json"), JSON.stringify(instance));
  const run = spawnSync("python3", ["scripts/validate.py", join(work, "instance.json"), join(work, "result.json")], { stdio: "inherit" });
  if (run.status !== 0) throw new Error(`validate.py exited ${run.status}`);
  const result = JSON.parse(readFileSync(join(work, "result.json"), "utf8"));
  if (result.verdict !== "passed") return { ...base, event: "excluded", step: "validation", reason: result.verdict, unreadable_runs: result.unreadable_runs, detail: result.detail };
  const matches = leakage(instance.patch, instance.problem_statement ?? "");
  if (matches.length) return { ...base, event: "excluded", step: "leakage", reason: "leakage screen", matches };
  const task = { ...instance, FAIL_TO_PASS: result.FAIL_TO_PASS, PASS_TO_PASS: result.PASS_TO_PASS };
  mkdirSync(join(dir, "instances"), { recursive: true });
  writeFileSync(join(dir, "instances", `${candidate.task_id}.json`), `${JSON.stringify(task, null, 1)}\n`);
  return { ...base, event: "gates passed", fail_to_pass: task.FAIL_TO_PASS.length, pass_to_pass: task.PASS_TO_PASS.length };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: Object.fromEntries(["frame", "repos", "dir", "beacon", "registration", "n", "repo", "issue", "commenter", "body-file", "author", "second-reader"].map((k) => [k, { type: "string" }])),
  });
  const dir = values.dir ?? ".";
  const logPath = join(dir, "log.jsonl");
  const log = readLog(logPath);

  if (command === "start") {
    // The seed is the verified drand round's randomness (scripts/seed.mjs), never typed in.
    const beacon = JSON.parse(readFileSync(values.beacon, "utf8"));
    if (!/^[0-9a-f]{64}$/.test(beacon.randomness ?? "") || !beacon.t) throw new Error("start needs the registered round from scripts/seed.mjs --t");
    if (!/^[1-9]\d*$/.test(values.n ?? "") || !/^[0-9a-f]{64}$/.test(values.registration ?? "")) throw new Error("start needs a positive --n and the registration's --registration sha256");
    const record = { event: "start", seed: beacon.randomness, n: Number(values.n), cap: REPO_CAP, frame_sha256: FRAME_SHA256, registration_sha256: values.registration, beacon };
    if (log.length) {
      const same = ["seed", "n", "registration_sha256"].every((k) => log[0][k] === record[k]);
      if (!same) throw new Error("the walk has already started with another seed, N or registration");
      return console.log(JSON.stringify({ action: "started", seed: log[0].seed, n: log[0].n }));
    }
    mkdirSync(dir, { recursive: true });
    append(dir, record);
    return console.log(JSON.stringify({ action: "started", seed: record.seed, n: record.n, round: beacon.round }));
  }

  if (command === "step" || command === "status") {
    const frame = loadFrame(values.frame);
    const state = replay(frame.candidates, log);
    const next = nextAction(state);
    if (command === "status") {
      return console.log(JSON.stringify({ ...next, considered: state.next - 1, of: state.order.length, accepted: state.accepted.length, n: state.n }));
    }
    if (next.action === "skip") append(dir, { position: next.position, task_id: next.task_id, repo: next.repo, event: "skipped", reason: "repository at cap" });
    if (next.action === "draw-second") append(dir, { event: "second reader set", tasks: next.tasks });
    if (next.action === "validate") {
      const repos = JSON.parse(readFileSync(values.repos, "utf8"));
      const candidate = state.byId.get(next.task_id);
      const recipe = repos.repos.find((r) => r.repo === candidate.listed_as)?.recipe ?? null;
      const record = await gates(dir, candidate, recipe, next.position);
      append(dir, record);
      return console.log(JSON.stringify({ ...next, event: record.event, reason: record.reason }));
    }
    return console.log(JSON.stringify(next));
  }

  if (command === "open-audits") {
    // One issue per open audit, opened once; the log records its number.
    const frame = JSON.parse(readFileSync(values.frame, "utf8"));
    const state = replay(frame.candidates, log);
    const due = [...state.pendingAuthor.map((id) => ["author", id]), ...state.pendingSecond.map((id) => ["second", id])];
    for (const [reader, id] of due) {
      if (state.opened.some((r) => r.reader === reader && r.task_id === id)) continue;
      const instance = JSON.parse(readFileSync(join(dir, "instances", `${id}.json`), "utf8"));
      const position = state.order.indexOf(id) + 1;
      const fileUrl = `https://github.com/${values.repo}/blob/walk/instances/${encodeURIComponent(id)}.json`;
      const issue = await createIssue(values.repo, `Audit (${reader === "author" ? "author" : "second reader"}) ${position}: ${id}`, auditBody(instance, reader, fileUrl));
      append(dir, { event: "audit opened", reader, task_id: id, position, issue });
      console.log(`opened #${issue}: ${reader} audit of ${id}`);
    }
    return;
  }

  if (command === "record") {
    const issue = Number(values.issue);
    const opened = log.filter((r) => r.event === "audit opened" && r.issue === issue).at(-1);
    if (!opened) return console.log(JSON.stringify({ recorded: false, why: "not an audit issue" }));
    if (log.some((r) => r.event === "audit" && r.reader === opened.reader && r.task_id === opened.task_id)) return console.log(JSON.stringify({ recorded: false, why: "already recorded" }));
    const allowed = opened.reader === "author" ? values.author : values["second-reader"];
    if (!allowed || values.commenter.toLowerCase() !== allowed.toLowerCase()) return console.log(JSON.stringify({ recorded: false, why: "not this audit's reader" }));
    const parsed = parseDecision(readFileSync(values["body-file"], "utf8"));
    if (!parsed) return console.log(JSON.stringify({ recorded: false, why: "malformed", reply: true }));
    append(dir, { event: "audit", reader: opened.reader, position: opened.position, task_id: opened.task_id, issue, ...parsed });
    return console.log(JSON.stringify({ recorded: true, ...parsed }));
  }

  throw new Error(`unknown command ${command}`);
}

async function createIssue(repo, title, body) {
  const response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: { Authorization: `bearer ${process.env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "capsid-bench-walk", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
    body: JSON.stringify({ title, body }),
  });
  if (!response.ok) throw new Error(`creating an issue answered ${response.status}`);
  return (await response.json()).number;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
