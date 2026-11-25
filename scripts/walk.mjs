#!/usr/bin/env node
// The walk (protocol section 4, "Audit" and "Draw"): the frozen frame permuted once with the
// registered seed, then each candidate in that order skipped at the repository cap, or
// prepared, validated, leakage-screened and audited by both readers, until N tasks are
// accepted or the permutation ends.
//
// State is one append-only log (log.jsonl on the `walk` branch) and the instances that
// passed the gates (instances/<task_id>.json), replayed on every run. Strictly in order:
// no candidate is considered until the one before it, and both audits, are recorded.
//
//   node scripts/walk.mjs start --dir <walk dir> --beacon seed.json --registration <sha256>
//
// N is 160, fixed in scripts/analyze.mjs; start refuses any other --n.
//   node scripts/walk.mjs step --frame frame/candidates.json --repos frame/repos.json --dir <walk dir>
//   node scripts/walk.mjs open-audits --dir <walk dir> --repo owner/name
//   node scripts/walk.mjs record --dir <walk dir> --issue <n> --commenter <login> --body-file <f> --author <login>
//   node scripts/walk.mjs status --frame frame/candidates.json --dir <walk dir>
//
// `step` does one thing and prints it as JSON: { action, ... }. Actions: skip (repository
// at the cap), validate (one candidate through preparation, validation and the leakage
// screen), second-read (one task put to the second reader), wait (an author audit is open)
// and done.
//
// The second reader (scripts/audit.mjs) is frozen in the start record: SECOND_READER_URL,
// SECOND_READER_MODEL and SECOND_READER_KEY name it; a change after the start is refused.

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { N, REPO_CAP, rng } from "./analyze.mjs";
import {
  addedIdentifiers,
  github,
  introducedIdentifiers,
  leakage,
  prepare,
} from "./prepare-candidate.mjs";
import {
  askSecondReader,
  auditBody,
  PROMPT_PATH,
  parseDecision,
  parseModelDecision,
  secondPrompt,
  secondReaderConfig,
} from "./audit.mjs";
import { githubHeaders, withTemp } from "./net.mjs";
import { sha256 } from "./seed.mjs";

// The frozen frame; the walk refuses any other.
export const FRAME_SHA256 = "68cbf6d39d73a3730e13aad43b2bfcb54df72cfaff2cee1a6e44930c567f006e";

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

export const readLog = (path) =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];

// The walk's state, replayed from the log.
export function replay(candidates, log) {
  const start = log[0];
  if (start?.event !== "start") throw new Error("the log has no start record");
  const byId = new Map(candidates.map((c) => [c.task_id, c]));
  const order = permutation(
    candidates.map((c) => c.task_id),
    start.seed,
  );
  const records = log.slice(1);
  const of = (event, reader) =>
    records.filter((r) => r.event === event && (!reader || r.reader === reader));
  const decision = (reader, id) => of("audit", reader).find((r) => r.task_id === id);
  const passed = of("gates passed");
  // A task is accepted when the author marks it in and the second reader does not mark it
  // out. A task either reader marks out does not count toward its repository's cap.
  const accepted = passed
    .filter(
      (r) =>
        decision("author", r.task_id)?.decision === "in" &&
        decision("second", r.task_id) &&
        decision("second", r.task_id).decision !== "out",
    )
    .map((r) => r.task_id);
  const considered = records
    .filter((r) => Number.isInteger(r.position))
    .reduce((m, r) => Math.max(m, r.position), 0);
  const perRepo = new Map();
  for (const id of accepted)
    perRepo.set(byId.get(id).repo, (perRepo.get(byId.get(id).repo) ?? 0) + 1);
  return {
    seed: start.seed,
    n: start.n,
    order,
    byId,
    next: considered + 1,
    passed,
    pendingAuthor: passed.filter((r) => !decision("author", r.task_id)).map((r) => r.task_id),
    pendingSecond: passed.filter((r) => !decision("second", r.task_id)).map((r) => r.task_id),
    accepted,
    perRepo,
    opened: of("audit opened"),
  };
}

// What happens next, from the state alone. The author decides first and the second reader
// after, so no author decision is made with the second reader's response in the public
// log (Grok's third review, 2026-10-22). The second reader is blind to the author either way.
export function nextAction(state) {
  if (state.pendingAuthor.length)
    return { action: "wait", reader: "author", tasks: state.pendingAuthor };
  if (state.pendingSecond.length)
    return {
      action: "second-read",
      task_id: state.pendingSecond[0],
      position: state.order.indexOf(state.pendingSecond[0]) + 1,
    };
  if (state.accepted.length < state.n && state.next <= state.order.length) {
    const taskId = state.order[state.next - 1];
    const repo = state.byId.get(taskId).repo;
    const kind = (state.perRepo.get(repo) ?? 0) >= REPO_CAP ? "skip" : "validate";
    return { action: kind, position: state.next, task_id: taskId, repo };
  }
  return {
    action: "done",
    accepted: state.accepted.length,
    n: state.n,
    unmet: state.accepted.length < state.n,
  };
}

function append(dir, record) {
  appendFileSync(
    join(dir, "log.jsonl"),
    `${JSON.stringify({ ...record, at: new Date().toISOString() })}\n`,
  );
}

function loadFrame(path) {
  if (sha256(readFileSync(path)) !== FRAME_SHA256)
    throw new Error(`${path} is not the frozen frame`);
  return JSON.parse(readFileSync(path, "utf8"));
}

// Which of `names` occur as whole words anywhere in the repository at the base commit:
// one archive download and one grep over it.
async function namesInBase(repo, base, names) {
  if (!names.length) return new Set();
  return withTemp("base-", async (work) => {
    const response = await fetch(`https://api.github.com/repos/${repo}/tarball/${base}`, {
      headers: githubHeaders(process.env.GITHUB_TOKEN, "capsid-bench-walk"),
    });
    if (!response.ok)
      throw new Error(`the archive of ${repo} at ${base} answered ${response.status}`);
    writeFileSync(join(work, "base.tar.gz"), Buffer.from(await response.arrayBuffer()));
    mkdirSync(join(work, "tree"));
    const tar = spawnSync("tar", ["xzf", join(work, "base.tar.gz"), "-C", join(work, "tree")], {
      stdio: "inherit",
    });
    if (tar.status !== 0) throw new Error(`tar exited ${tar.status}`);
    writeFileSync(join(work, "names.txt"), `${names.join("\n")}\n`);
    const grep = spawnSync("grep", ["-rhowIF", "-f", join(work, "names.txt"), join(work, "tree")], {
      encoding: "utf8",
      maxBuffer: 1 << 30,
    });
    if (grep.status > 1) throw new Error(`grep exited ${grep.status}`);
    return new Set(grep.stdout.split("\n").filter(Boolean));
  });
}

// One candidate through the three mechanical gates, in the protocol's order.
async function gates(dir, candidate, recipe, position) {
  const base = { position, task_id: candidate.task_id, repo: candidate.repo };
  const instance = await prepare(github(process.env.GITHUB_TOKEN), candidate, recipe);
  if (instance.excluded)
    return { ...base, event: "excluded", step: "preparation", reason: instance.excluded };
  const result = await withTemp("walk-", (work) => {
    writeFileSync(join(work, "instance.json"), JSON.stringify(instance));
    const run = spawnSync(
      "python3",
      ["scripts/validate.py", join(work, "instance.json"), join(work, "result.json")],
      { stdio: "inherit" },
    );
    if (run.status !== 0) throw new Error(`validate.py exited ${run.status}`);
    return JSON.parse(readFileSync(join(work, "result.json"), "utf8"));
  });
  if (result.verdict !== "passed")
    return {
      ...base,
      event: "excluded",
      step: "validation",
      reason: result.verdict,
      unreadable_runs: result.unreadable_runs,
      detail: result.detail,
    };
  const matches = leakage(
    instance.patch,
    instance.problem_statement ?? "",
    introducedIdentifiers(
      instance.patch,
      await namesInBase(candidate.repo, instance.base_commit, addedIdentifiers(instance.patch)),
    ),
  );
  if (matches.length)
    return { ...base, event: "excluded", step: "leakage", reason: "leakage screen", matches };
  // The gold patch stays off the walk branch: the instance keeps only its SHA-256, and the
  // task files for the runs prepare it again from GitHub after the walk, checked against it.
  const { patch, ...rest } = instance;
  const task = {
    ...rest,
    patch_sha256: sha256(patch),
    FAIL_TO_PASS: result.FAIL_TO_PASS,
    PASS_TO_PASS: result.PASS_TO_PASS,
  };
  mkdirSync(join(dir, "instances"), { recursive: true });
  writeFileSync(
    join(dir, "instances", `${candidate.task_id}.json`),
    `${JSON.stringify(task, null, 1)}\n`,
  );
  return {
    ...base,
    event: "gates passed",
    fail_to_pass: task.FAIL_TO_PASS.length,
    pass_to_pass: task.PASS_TO_PASS.length,
  };
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: Object.fromEntries(
      [
        "frame",
        "repos",
        "dir",
        "beacon",
        "registration",
        "n",
        "repo",
        "issue",
        "commenter",
        "body-file",
        "author",
      ].map((k) => [k, { type: "string" }]),
    ),
  });
  const dir = values.dir ?? ".";
  const logPath = join(dir, "log.jsonl");
  const log = readLog(logPath);

  if (command === "start") {
    // The seed is the verified drand round's randomness (scripts/seed.mjs), never typed in.
    const beacon = JSON.parse(readFileSync(values.beacon, "utf8"));
    if (!/^[0-9a-f]{64}$/.test(beacon.randomness ?? "") || !beacon.t)
      throw new Error("start needs the registered round from scripts/seed.mjs --t");
    if (values.n !== undefined && Number(values.n) !== N)
      throw new Error(`N is fixed at ${N} by the registration`);
    if (!/^[0-9a-f]{64}$/.test(values.registration ?? ""))
      throw new Error("start needs the registration's --registration sha256");
    const second_reader = secondReaderConfig(process.env, readFileSync(PROMPT_PATH));
    const record = {
      event: "start",
      seed: beacon.randomness,
      n: N,
      cap: REPO_CAP,
      frame_sha256: FRAME_SHA256,
      registration_sha256: values.registration,
      beacon,
      second_reader,
    };
    if (log.length) {
      const same = ["seed", "n", "registration_sha256"].every((k) => log[0][k] === record[k]);
      if (!same)
        throw new Error("the walk has already started with another seed, N or registration");
      return console.log(JSON.stringify({ action: "started", seed: log[0].seed, n: log[0].n }));
    }
    mkdirSync(dir, { recursive: true });
    append(dir, record);
    return console.log(
      JSON.stringify({ action: "started", seed: record.seed, n: record.n, round: beacon.round }),
    );
  }

  if (command === "step" || command === "status") {
    const frame = loadFrame(values.frame);
    const state = replay(frame.candidates, log);
    const next = nextAction(state);
    if (command === "status") {
      return console.log(
        JSON.stringify({
          ...next,
          considered: state.next - 1,
          of: state.order.length,
          accepted: state.accepted.length,
          n: state.n,
        }),
      );
    }
    if (next.action === "skip")
      append(dir, {
        position: next.position,
        task_id: next.task_id,
        repo: next.repo,
        event: "skipped",
        reason: "repository at cap",
      });
    if (next.action === "validate") {
      const repos = JSON.parse(readFileSync(values.repos, "utf8"));
      const candidate = state.byId.get(next.task_id);
      const recipe = repos.repos.find((r) => r.repo === candidate.listed_as)?.recipe ?? null;
      const record = await gates(dir, candidate, recipe, next.position);
      append(dir, record);
      return console.log(JSON.stringify({ ...next, event: record.event, reason: record.reason }));
    }
    if (next.action === "second-read") {
      // No substitution: the reader must be the one frozen at the start.
      const template = readFileSync(PROMPT_PATH, "utf8");
      const config = secondReaderConfig(process.env, template);
      if (JSON.stringify(config) !== JSON.stringify(log[0].second_reader))
        throw new Error("the second reader is not the one frozen at the start");
      const instance = JSON.parse(
        readFileSync(join(dir, "instances", `${next.task_id}.json`), "utf8"),
      );
      const raw = await askSecondReader(
        config,
        secondPrompt(template, instance),
        process.env.SECOND_READER_KEY,
      );
      let content = null;
      try {
        content = JSON.parse(raw).choices?.[0]?.message?.content ?? null;
      } catch {}
      const parsed = parseModelDecision(content);
      append(dir, {
        event: "audit",
        reader: "second",
        position: next.position,
        task_id: next.task_id,
        ...parsed,
        raw,
        raw_sha256: sha256(raw),
        model: config.model,
        prompt_sha256: config.prompt_sha256,
      });
      return console.log(JSON.stringify({ ...next, ...parsed }));
    }
    return console.log(JSON.stringify(next));
  }

  if (command === "open-audits") {
    // One issue per open audit, opened once; the log records its number.
    const frame = loadFrame(values.frame);
    const state = replay(frame.candidates, log);
    const due = state.pendingAuthor.map((id) => ["author", id]);
    for (const [reader, id] of due) {
      if (state.opened.some((r) => r.reader === reader && r.task_id === id)) continue;
      const instance = JSON.parse(readFileSync(join(dir, "instances", `${id}.json`), "utf8"));
      const position = state.order.indexOf(id) + 1;
      const fileUrl = `https://github.com/${values.repo}/blob/walk/instances/${encodeURIComponent(id)}.json`;
      const issue = await createIssue(
        values.repo,
        `Audit (${reader === "author" ? "author" : "second reader"}) ${position}: ${id}`,
        auditBody(instance, fileUrl),
      );
      append(dir, { event: "audit opened", reader, task_id: id, position, issue });
      console.log(`opened #${issue}: ${reader} audit of ${id}`);
    }
    return;
  }

  if (command === "record") {
    const issue = Number(values.issue);
    const opened = log.filter((r) => r.event === "audit opened" && r.issue === issue).at(-1);
    if (!opened) return console.log(JSON.stringify({ recorded: false, why: "not an audit issue" }));
    if (
      log.some(
        (r) => r.event === "audit" && r.reader === opened.reader && r.task_id === opened.task_id,
      )
    )
      return console.log(JSON.stringify({ recorded: false, why: "already recorded" }));
    if (!values.author || values.commenter.toLowerCase() !== values.author.toLowerCase())
      return console.log(JSON.stringify({ recorded: false, why: "not this audit's reader" }));
    const parsed = parseDecision(readFileSync(values["body-file"], "utf8"));
    if (!parsed)
      return console.log(JSON.stringify({ recorded: false, why: "malformed", reply: true }));
    append(dir, {
      event: "audit",
      reader: opened.reader,
      position: opened.position,
      task_id: opened.task_id,
      issue,
      ...parsed,
    });
    return console.log(JSON.stringify({ recorded: true, ...parsed }));
  }

  throw new Error(`unknown command ${command}`);
}

async function createIssue(repo, title, body) {
  const response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      ...githubHeaders(process.env.GITHUB_TOKEN, "capsid-bench-walk"),
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
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
