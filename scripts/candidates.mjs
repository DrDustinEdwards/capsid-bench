#!/usr/bin/env node
// The frame's candidate list (protocol section 4, "Frame"), produced once from the
// repository list scripts/repos.py wrote and then hashed. Reads GitHub only: registers
// nothing, starts no run, calls no model.
//
//   GITHUB_TOKEN=... node scripts/candidates.mjs --repos repos.json --freeze 2026-10-20 --out candidates.json
//
// A repository is eligible when GitHub gives its primary language as Python, JavaScript
// or TypeScript, its licence is permissive, and its owner is not the author's. A
// candidate is a merged pull request in an eligible repository that:
//   1. was merged after 2026-07-01 and on or before the freeze date (UTC);
//   2. closes exactly one issue in the same repository (GitHub's closing references: a
//      closing keyword or a linked issue), so the task has one problem statement;
//   3. that issue was opened after the 2026-06-30 cutoff;
//   4. adds or changes tests (a file on a test path);
//   5. touches at most 3 non-test files.
// Each filter's count, and each repository left out with its reason, go into the file.
// A rerun after a fix keeps the same freeze date: the date is chosen once.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

export const ISSUE_CUTOFF = "2026-06-30T23:59:59Z"; // scripts/task.mjs CUTOFF
export const MERGED_AFTER = "2026-07-01T23:59:59Z";
export const LANGUAGES = new Set(["Python", "JavaScript", "TypeScript"]);
export const PERMISSIVE = new Set(["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "0BSD", "Unlicense", "PSF-2.0", "Zlib", "BSL-1.0", "MIT-0"]);
export const AUTHOR_OWNERS = new Set(["drdustinedwards"]);
// Test paths: a tests or spec directory, test_*, *_test.*, *.test.*, *.spec.* or conftest.py.
const TEST_PATH = /(^|\/)(tests?|testing|__tests__|spec)(\/|$)|(^|\/)test_[^/]*$|_test\.[^/]+$|\.(test|spec)\.[^/]+$|(^|\/)conftest\.py$/;
// GitHub's search refuses a query over 256 characters.
const QUERY_LIMIT = 256;

export const isTestPath = (path) => TEST_PATH.test(path);

// Why a repository is left out, or null when it is eligible.
export function repoRefusal(info) {
  if (!info) return "not found on GitHub";
  if (AUTHOR_OWNERS.has(info.owner.login.toLowerCase())) return "the author's own";
  if (!LANGUAGES.has(info.primaryLanguage?.name)) return "not Python, JavaScript or TypeScript";
  if (!PERMISSIVE.has(info.licenseInfo?.spdxId)) return "licence not permissive";
  return null;
}

export const PR_STEPS = ["merged in the window", "closes one issue in the repository", "issue opened after the cutoff", "changes tests", "at most 3 non-test files"];

// The first filter a pull request fails, or null with the candidate it makes.
export function prVerdict(pr, freezeEnd) {
  if (!pr.mergedAt || pr.mergedAt <= MERGED_AFTER || pr.mergedAt > freezeEnd) return { failed: PR_STEPS[0] };
  const repo = pr.repository.nameWithOwner;
  const issues = pr.closingIssuesReferences.nodes.filter((i) => i.repository.nameWithOwner === repo);
  if (issues.length !== 1 || pr.closingIssuesReferences.totalCount !== pr.closingIssuesReferences.nodes.length) return { failed: PR_STEPS[1] };
  const [issue] = issues;
  if (issue.createdAt <= ISSUE_CUTOFF) return { failed: PR_STEPS[2] };
  const files = pr.files.map((f) => f.path).sort();
  const tests = files.filter(isTestPath);
  if (tests.length === 0) return { failed: PR_STEPS[3] };
  const fix = files.filter((f) => !isTestPath(f));
  if (fix.length > 3) return { failed: PR_STEPS[4] };
  const [owner, name] = repo.split("/");
  return {
    failed: null,
    candidate: {
      task_id: `${owner}__${name}-${pr.number}`,
      repo,
      pr: pr.number,
      pr_url: pr.url,
      merged_at: pr.mergedAt,
      merge_commit: pr.mergeCommit?.oid ?? null,
      merge_parents: pr.mergeCommit?.parents.nodes.map((p) => p.oid) ?? [],
      base_ref_oid: pr.baseRefOid,
      head_ref_oid: pr.headRefOid,
      issue: { number: issue.number, url: issue.url, created_at: issue.createdAt },
      test_files: tests,
      fix_files: fix,
    },
  };
}

// Repository qualifiers packed into as few searches as GitHub's query length allows.
export function searchBatches(repos, rest) {
  const batches = [];
  let current = [];
  for (const repo of repos) {
    const next = [...current, repo];
    if (current.length && [...next.map((r) => `repo:${r}`), rest].join(" ").length > QUERY_LIMIT) {
      batches.push(current);
      current = [repo];
    } else current = next;
  }
  if (current.length) batches.push(current);
  return batches;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One GraphQL call, waiting out the hourly limit and GitHub's secondary limits.
export function client(token, fetchImpl = fetch, wait = sleep) {
  return async function graphql(query, variables = {}) {
    for (let attempt = 0; ; attempt++) {
      const response = await fetchImpl("https://api.github.com/graphql", {
        method: "POST",
        headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": "capsid-bench-candidates" },
        body: JSON.stringify({ query, variables }),
      });
      if ((response.status === 403 || response.status === 429 || response.status >= 500) && attempt < 8) {
        const after = Number(response.headers.get("retry-after")) || 0;
        await wait(Math.max(after * 1000, 5000 * 2 ** attempt));
        continue;
      }
      if (!response.ok) throw new Error(`GitHub GraphQL answered ${response.status}`);
      const body = await response.json();
      const fatal = (body.errors ?? []).filter((e) => e.type !== "NOT_FOUND");
      if (fatal.some((e) => e.type === "RATE_LIMITED") && attempt < 8) {
        await wait(60000 * (attempt + 1));
        continue;
      }
      if (fatal.length) throw new Error(`GitHub GraphQL: ${fatal.map((e) => e.message).join("; ")}`);
      const limit = body.data?.rateLimit;
      if (limit && limit.remaining < 50) await wait(Math.max(0, Date.parse(limit.resetAt) - Date.now()) + 5000);
      return body.data;
    }
  };
}

const REPO_FIELDS = "nameWithOwner owner { login } primaryLanguage { name } licenseInfo { spdxId }";

export async function lookUpRepos(graphql, names) {
  const found = new Map();
  for (let i = 0; i < names.length; i += 50) {
    const chunk = names.slice(i, i + 50);
    const vars = {};
    const parts = chunk.map((full, j) => {
      const [owner, name] = full.split("/");
      vars[`o${j}`] = owner;
      vars[`n${j}`] = name;
      return `r${j}: repository(owner: $o${j}, name: $n${j}) { ${REPO_FIELDS} }`;
    });
    const params = chunk.map((_, j) => `$o${j}: String!, $n${j}: String!`).join(", ");
    const data = await graphql(`query(${params}) { rateLimit { remaining resetAt } ${parts.join(" ")} }`, vars);
    chunk.forEach((full, j) => found.set(full, data?.[`r${j}`] ?? null));
  }
  return found;
}

const PR_FIELDS = `number url mergedAt baseRefOid headRefOid repository { nameWithOwner }
  mergeCommit { oid parents(first: 2) { nodes { oid } } }
  closingIssuesReferences(first: 5) { totalCount nodes { number url createdAt repository { nameWithOwner } } }
  files(first: 100) { pageInfo { hasNextPage endCursor } nodes { path } }`;

const SEARCH = `query($q: String!, $after: String) {
  rateLimit { remaining resetAt }
  search(type: ISSUE, query: $q, first: 50, after: $after) {
    issueCount pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { ${PR_FIELDS} } }
  }
}`;

const MORE_FILES = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  rateLimit { remaining resetAt }
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { files(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { path } } } }
}`;

async function allFiles(graphql, pr) {
  const files = [...pr.files.nodes];
  let page = pr.files.pageInfo;
  const [owner, name] = pr.repository.nameWithOwner.split("/");
  while (page.hasNextPage) {
    const data = await graphql(MORE_FILES, { owner, name, number: pr.number, after: page.endCursor });
    const more = data.repository.pullRequest.files;
    files.push(...more.nodes);
    page = more.pageInfo;
  }
  return files;
}

const day = (ms) => new Date(ms).toISOString().slice(0, 10);

// Every merged pull request in the batch's repositories merged between two days, split by
// date when a search would pass GitHub's 1,000-result cap.
async function searchWindow(graphql, batch, from, to, out, pause) {
  const q = (a, b) => [...batch.map((r) => `repo:${r}`), "is:pr", "is:merged", `merged:${a}..${b}`].join(" ");
  const first = await graphql(SEARCH, { q: q(from, to) });
  await pause();
  if (first.search.issueCount > 1000 && from !== to) {
    const mid = day((Date.parse(from) + Date.parse(to)) / 2);
    await searchWindow(graphql, batch, from, mid, out, pause);
    await searchWindow(graphql, batch, day(Date.parse(mid) + 86400000), to, out, pause);
    return;
  }
  if (first.search.issueCount > 1000) throw new Error(`more than 1,000 pull requests merged on ${from} in ${batch.join(", ")}`);
  let result = first.search;
  for (;;) {
    out.push(...result.nodes.filter((n) => n && n.number));
    if (!result.pageInfo.hasNextPage) break;
    result = (await graphql(SEARCH, { q: q(from, to), after: result.pageInfo.endCursor })).search;
    await pause();
  }
}

export async function buildCandidates(graphql, repoList, freeze, { pause = () => sleep(2000) } = {}) {
  const freezeEnd = `${freeze}T23:59:59Z`;
  const names = repoList.repos.map((r) => r.repo);
  const info = await lookUpRepos(graphql, names);

  const excludedRepos = [];
  const eligible = new Map(); // current name -> listed entry
  for (const entry of repoList.repos) {
    const repo = info.get(entry.repo);
    const reason = repoRefusal(repo);
    if (reason) excludedRepos.push({ repo: entry.repo, reason });
    // A renamed repository is searched under its current name, once.
    else if (eligible.has(repo.nameWithOwner)) excludedRepos.push({ repo: entry.repo, reason: `same repository as ${eligible.get(repo.nameWithOwner).listed}` });
    else eligible.set(repo.nameWithOwner, { listed: entry.repo, language: repo.primaryLanguage.name, licence: repo.licenseInfo.spdxId, recipe_instance: entry.recipe_instance });
  }

  const prs = [];
  // The search window is a day wider than the frame's on the early side; prVerdict
  // applies the exact UTC bounds.
  for (const batch of searchBatches([...eligible.keys()], "is:pr is:merged merged:2026-07-01..2026-12-31")) {
    await searchWindow(graphql, batch, "2026-07-01", freeze, prs, pause);
  }

  const kept = Object.fromEntries(PR_STEPS.map((s) => [s, 0]));
  const candidates = [];
  const seen = new Set();
  for (const pr of prs) {
    const key = `${pr.repository.nameWithOwner}#${pr.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!eligible.has(pr.repository.nameWithOwner)) continue;
    pr.files = await allFiles(graphql, pr);
    const verdict = prVerdict(pr, freezeEnd);
    for (const step of PR_STEPS) {
      if (step === verdict.failed) break;
      kept[step]++;
    }
    if (verdict.candidate) {
      const repo = eligible.get(verdict.candidate.repo);
      candidates.push({ ...verdict.candidate, listed_as: repo.listed, language: repo.language, licence: repo.licence, recipe_instance: repo.recipe_instance });
    }
  }
  candidates.sort((a, b) => (a.task_id < b.task_id ? -1 : a.task_id > b.task_id ? 1 : 0));
  excludedRepos.sort((a, b) => (a.repo < b.repo ? -1 : 1));
  return {
    repos: { listed: names.length, eligible: eligible.size, excluded: excludedRepos },
    pull_requests: { searched: seen.size, kept_after: kept },
    candidates,
  };
}

async function main() {
  const { values } = parseArgs({ options: { repos: { type: "string" }, freeze: { type: "string" }, out: { type: "string" } } });
  if (!values.repos || !values.out || !/^\d{4}-\d{2}-\d{2}$/.test(values.freeze ?? "")) throw new Error("usage: --repos <repos.json> --freeze <YYYY-MM-DD> --out <file>");
  // The freeze date is no later than the day the list is hashed, so never in the future.
  if (values.freeze > new Date().toISOString().slice(0, 10)) throw new Error(`freeze date ${values.freeze} is in the future`);
  if (values.freeze < "2026-07-02") throw new Error("freeze date before the merge window opens");
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is not set");
  const text = readFileSync(values.repos, "utf8");
  const repoList = JSON.parse(text);
  const built = await buildCandidates(client(token), repoList, values.freeze);
  const file = {
    dataset: repoList.dataset,
    dataset_commit: repoList.commit,
    repo_list_sha256: createHash("sha256").update(text).digest("hex"),
    script_commit: process.env.GITHUB_SHA ?? null,
    issue_cutoff: ISSUE_CUTOFF,
    merged_after: MERGED_AFTER,
    freeze_date: values.freeze,
    ...built,
  };
  const json = `${JSON.stringify(file, null, 1)}\n`;
  writeFileSync(values.out, json);
  const lines = [
    `# Candidate list, frozen ${values.freeze}`,
    "",
    `- ${built.repos.listed} repositories listed, ${built.repos.eligible} eligible`,
    ...Object.entries(Object.groupBy(built.repos.excluded, (r) => r.reason)).map(([reason, list]) => `  - left out, ${reason}: ${list.length}`),
    `- ${built.pull_requests.searched} merged pull requests found`,
    ...PR_STEPS.map((s) => `  - ${s}: ${built.pull_requests.kept_after[s]}`),
    "",
    `${built.candidates.length} candidates. File sha256 ${createHash("sha256").update(json).digest("hex")}.`,
  ];
  console.log(lines.join("\n"));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
