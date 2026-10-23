#!/usr/bin/env node
// One frame candidate made into a SWE-rebench-format instance, ready for validation
// (protocol section 4, "Per task, mechanically" and "Frame"). Reads GitHub only.
//
//   GITHUB_TOKEN=... node scripts/prepare-candidate.mjs --frame frame/candidates.json \
//     --repos frame/repos.json --task <task_id> --out instance.json
//
// What it fixes, each from the pull request and never from a later checkout:
//   - the base commit: the parent of the fixing change. A merge commit's first parent;
//     otherwise the merge commit's parent when that one commit carries exactly the pull
//     request's files (a squash, or a one-commit rebase), else the commit as many first
//     parents back as the pull request has commits (a rebase). When none of these carries
//     exactly the pull request's files, the base is not found and the candidate is
//     excluded with that reason;
//   - the gold patch (the change to non-test files) and the test patch (the change to test
//     files), from the diff between the base and the merge commit;
//   - the problem statement: the issue body as it stood before the first fix commit, from
//     the issue's edit history, without comments and without the pull request text;
//   - the environment: the repository's recipe from the repository list, unedited.
//
// A candidate that cannot be prepared is written as { excluded: <reason> } and exits 0,
// so the walk records it rather than stopping.

import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isTestPath } from "./candidates.mjs";

export const BASE_NOT_FOUND = "base commit not found";

const API = "https://api.github.com";

export function github(token, fetchImpl = fetch) {
  const headers = { Authorization: `bearer ${token}`, "User-Agent": "capsid-bench-prepare", "X-GitHub-Api-Version": "2022-11-28" };
  const call = async (path, accept = "application/vnd.github+json", init = {}) => {
    for (let attempt = 0; ; attempt++) {
      const response = await fetchImpl(`${API}${path}`, { ...init, headers: { ...headers, Accept: accept, ...(init.headers ?? {}) } });
      if ((response.status === 403 || response.status === 429 || response.status >= 500) && attempt < 6) {
        await new Promise((r) => setTimeout(r, 5000 * 2 ** attempt));
        continue;
      }
      if (!response.ok) throw new Error(`GitHub ${path} answered ${response.status}`);
      return accept.endsWith("diff") ? response.text() : response.json();
    }
  };
  return {
    rest: (path) => call(path),
    diff: (path) => call(path, "application/vnd.github.diff"),
    graphql: async (query, variables) => {
      const body = await call("/graphql", "application/json", { method: "POST", body: JSON.stringify({ query, variables }), headers: { "Content-Type": "application/json" } });
      if (body.errors?.length) throw new Error(`GitHub GraphQL: ${body.errors.map((e) => e.message).join("; ")}`);
      return body.data;
    },
  };
}

// A unified diff split into its per-file parts, keyed by path.
export function splitDiff(diff) {
  const parts = diff.split(/^(?=diff --git )/m).filter((p) => p.startsWith("diff --git "));
  return parts.map((text) => ({ path: text.match(/^diff --git a\/(\S+) b\/(\S+)/)[2], text }));
}

const sameFiles = (a, b) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

// The base commit: see the header. `filesBetween(base, head)` lists the paths a compare
// shows; `parentOf(sha)` is a commit's first parent.
export async function findBase(candidate, prCommits, { filesBetween, parentOf }) {
  const prFiles = [...candidate.test_files, ...candidate.fix_files];
  const head = candidate.merge_commit;
  if (!head) return null;
  if (candidate.merge_parents.length === 2) return candidate.merge_parents[0];
  const one = candidate.merge_parents[0];
  if (one && sameFiles(await filesBetween(one, head), prFiles)) return one;
  let base = head;
  for (let i = 0; i < prCommits; i++) base = await parentOf(base);
  if (base && base !== one && sameFiles(await filesBetween(base, head), prFiles)) return base;
  return null;
}

// The issue body as it stood at `before` (the first fix commit's time). GitHub's edit
// history lists each revision with the full text it left; the oldest is the original.
export function bodyAt(issue, before) {
  const edits = [...(issue.userContentEdits?.nodes ?? [])].filter((e) => e && typeof e.diff === "string").sort((a, b) => (a.editedAt < b.editedAt ? -1 : 1));
  if (!issue.lastEditedAt || issue.lastEditedAt <= before || edits.length === 0) return issue.body;
  const standing = edits.filter((e) => e.editedAt <= before);
  return (standing.length ? standing[standing.length - 1] : edits[0]).diff;
}

const ISSUE = `query($owner: String!, $name: String!, $issue: Int!, $pr: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $issue) { body createdAt lastEditedAt userContentEdits(last: 100) { nodes { editedAt diff } pageInfo { hasPreviousPage startCursor } } }
    pullRequest(number: $pr) { commits(first: 1) { totalCount nodes { commit { committedDate authoredDate } } } }
  }
}`;

const EDITS = `query($owner: String!, $name: String!, $issue: Int!, $before: String!) {
  repository(owner: $owner, name: $name) {
    issue(number: $issue) { userContentEdits(last: 100, before: $before) { nodes { editedAt diff } pageInfo { hasPreviousPage startCursor } } }
  }
}`;

// The edit history comes 100 at a time, newest first. Page back until an edit at or
// before the first fix is in hand, or the history is complete, so bodyAt never reads a
// later snapshot because the one it needed was on an older page.
export async function editsBack(gh, vars, edits, before) {
  let page = edits;
  const nodes = [...(edits?.nodes ?? [])];
  while (page?.pageInfo?.hasPreviousPage && !nodes.some((e) => e && e.editedAt <= before)) {
    const data = await gh.graphql(EDITS, { ...vars, before: page.pageInfo.startCursor });
    page = data.repository.issue.userContentEdits;
    nodes.unshift(...(page?.nodes ?? []));
  }
  return { nodes };
}

export async function prepare(gh, candidate, recipe) {
  const [owner, name] = candidate.repo.split("/");
  const data = await gh.graphql(ISSUE, { owner, name, issue: candidate.issue.number, pr: candidate.pr });
  const { pullRequest } = data.repository;
  const firstCommit = pullRequest.commits.nodes[0]?.commit;
  const firstFix = firstCommit ? [firstCommit.committedDate, firstCommit.authoredDate].sort()[0] : candidate.merged_at;
  const issue = { ...data.repository.issue, userContentEdits: await editsBack(gh, { owner, name, issue: candidate.issue.number }, data.repository.issue.userContentEdits, firstFix) };

  const base = await findBase(candidate, pullRequest.commits.totalCount, {
    filesBetween: async (a, b) => splitDiff(await gh.diff(`/repos/${candidate.repo}/compare/${a}...${b}`)).map((p) => p.path),
    parentOf: async (sha) => (await gh.rest(`/repos/${candidate.repo}/commits/${sha}`)).parents?.[0]?.sha ?? null,
  });
  if (!base) return { task_id: candidate.task_id, excluded: BASE_NOT_FOUND };
  if (!recipe) return { task_id: candidate.task_id, excluded: "no recipe" };

  const parts = splitDiff(await gh.diff(`/repos/${candidate.repo}/compare/${base}...${candidate.merge_commit}`));
  const patch = parts.filter((p) => !isTestPath(p.path)).map((p) => p.text).join("");
  const testPatch = parts.filter((p) => isTestPath(p.path)).map((p) => p.text).join("");
  return {
    instance_id: candidate.task_id,
    repo: candidate.repo,
    base_commit: base,
    merge_commit: candidate.merge_commit,
    created_at: issue.createdAt,
    first_fix_at: firstFix,
    problem_statement: bodyAt(issue, firstFix) ?? "",
    patch,
    test_patch: testPatch,
    install_config: recipe,
    version: "0",
    FAIL_TO_PASS: [],
    PASS_TO_PASS: [],
  };
}

// The leakage screen (protocol section 4, step 4): the task is excluded if any added,
// non-blank line of the gold patch, other than a line made only of brackets or
// punctuation or a Markdown code fence (such as ```bash), occurs as a whole line in the frozen issue, after trimming whitespace; or
// if any identifier the gold patch introduces occurs in the issue as a whole word.
// `introduced` is that list (see introducedIdentifiers).
export function leakage(patch, problem, introduced = []) {
  const issueLines = new Set(problem.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  const matches = [];
  for (const line of patch.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const text = line.slice(1).trim();
    if (!text || /^[\p{P}\p{S}\s]*$/u.test(text) || /^(```|~~~)[\w+-]*$/.test(text)) continue;
    if (issueLines.has(text)) matches.push(text);
  }
  const issueWords = new Set(problem.match(WORD) ?? []);
  for (const name of introduced) if (issueWords.has(name)) matches.push(`identifier ${name}`);
  return matches;
}

const WORD = /[A-Za-z_][A-Za-z0-9_]*/g;
// An identifier, as against an English word: it has an underscore, a digit, or a capital
// letter after its first character (snake_case, name2, camelCase, PascalCase).
const identifierLike = (word) => /[_0-9]/.test(word) || /[A-Z]/.test(word.slice(1));

// The identifier-like names on the gold patch's added lines.
export function addedIdentifiers(patch) {
  const names = new Set();
  for (const line of patch.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const word of line.slice(1).match(WORD) ?? []) if (identifierLike(word)) names.add(word);
  }
  return [...names].sort();
}

// The names the gold patch introduces: added names that occur on no line of the base tree.
// `inBase` is the set of those names found in the base tree (the walk greps an archive of
// the repository at the base commit).
export function introducedIdentifiers(patch, inBase) {
  return addedIdentifiers(patch).filter((name) => !inBase.has(name));
}

async function main() {
  const { values } = parseArgs({ options: { frame: { type: "string" }, repos: { type: "string" }, task: { type: "string" }, out: { type: "string" } } });
  const frame = JSON.parse(readFileSync(values.frame, "utf8"));
  const repos = JSON.parse(readFileSync(values.repos, "utf8"));
  const candidate = frame.candidates.find((c) => c.task_id === values.task);
  if (!candidate) throw new Error(`${values.task} is not in the frame`);
  const recipe = repos.repos.find((r) => r.repo === candidate.listed_as)?.recipe ?? null;
  const result = await prepare(github(process.env.GITHUB_TOKEN), candidate, recipe);
  writeFileSync(values.out, `${JSON.stringify(result, null, 1)}\n`);
  console.log(result.excluded ? `${values.task}: excluded, ${result.excluded}` : `${values.task}: base ${result.base_commit}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
