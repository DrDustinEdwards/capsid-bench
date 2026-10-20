import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCandidates, client, isTestPath, prVerdict, repoRefusal, searchBatches } from "../scripts/candidates.mjs";

// The frame's mechanical filters (protocol section 4, "Frame"), against fake GitHub
// answers: which repositories are eligible, which pull requests become candidates, and
// that every filter is counted.

const FREEZE_END = "2026-10-20T23:59:59Z";

function pr(over = {}) {
  return {
    number: 7,
    url: "https://github.com/sample/repo/pull/7",
    mergedAt: "2026-08-01T10:00:00Z",
    baseRefOid: "b".repeat(40),
    headRefOid: "h".repeat(40),
    repository: { nameWithOwner: "sample/repo" },
    mergeCommit: { oid: "m".repeat(40), parents: { nodes: [{ oid: "p".repeat(40) }] } },
    closingIssuesReferences: { totalCount: 1, nodes: [{ number: 3, url: "https://github.com/sample/repo/issues/3", createdAt: "2026-07-20T00:00:00Z", repository: { nameWithOwner: "sample/repo" } }] },
    files: [{ path: "src/fix.py" }, { path: "tests/test_fix.py" }],
    ...over,
  };
}

const repo = (over = {}) => ({ nameWithOwner: "sample/repo", owner: { login: "sample" }, primaryLanguage: { name: "Python" }, licenseInfo: { spdxId: "MIT" }, ...over });

test("a repository is eligible only if Python, JS or TS, permissive and not the author's", () => {
  assert.equal(repoRefusal(repo()), null);
  assert.equal(repoRefusal(repo({ primaryLanguage: { name: "TypeScript" } })), null);
  assert.equal(repoRefusal(null), "not found on GitHub");
  assert.equal(repoRefusal(repo({ owner: { login: "DrDustinEdwards" } })), "the author's own");
  assert.equal(repoRefusal(repo({ primaryLanguage: { name: "Rust" } })), "not Python, JavaScript or TypeScript");
  assert.equal(repoRefusal(repo({ primaryLanguage: null })), "not Python, JavaScript or TypeScript");
  assert.equal(repoRefusal(repo({ licenseInfo: { spdxId: "GPL-3.0" } })), "licence not permissive");
  assert.equal(repoRefusal(repo({ licenseInfo: { spdxId: "NOASSERTION" } })), "licence not permissive");
  assert.equal(repoRefusal(repo({ licenseInfo: null })), "licence not permissive");
});

test("test paths", () => {
  for (const p of ["tests/test_a.py", "pkg/test/a.py", "test_a.py", "a_test.go", "src/a.test.ts", "src/__tests__/a.js", "conftest.py", "spec/a.rb"]) assert.ok(isTestPath(p), p);
  for (const p of ["src/a.py", "docs/testing.md", "contest.py", "src/latest.py"]) assert.ok(!isTestPath(p), p);
});

test("a pull request is a candidate only inside every bound", () => {
  const ok = prVerdict(pr(), FREEZE_END);
  assert.equal(ok.failed, null);
  assert.deepEqual(ok.candidate, {
    task_id: "sample__repo-7",
    repo: "sample/repo",
    pr: 7,
    pr_url: "https://github.com/sample/repo/pull/7",
    merged_at: "2026-08-01T10:00:00Z",
    merge_commit: "m".repeat(40),
    merge_parents: ["p".repeat(40)],
    base_ref_oid: "b".repeat(40),
    head_ref_oid: "h".repeat(40),
    issue: { number: 3, url: "https://github.com/sample/repo/issues/3", created_at: "2026-07-20T00:00:00Z" },
    test_files: ["tests/test_fix.py"],
    fix_files: ["src/fix.py"],
  });

  const issue = (createdAt, nameWithOwner = "sample/repo", number = 3) => ({ number, url: "u", createdAt, repository: { nameWithOwner } });
  const cases = [
    [{ mergedAt: "2026-07-01T23:59:59Z" }, "merged in the window"],
    [{ mergedAt: "2026-10-21T00:00:00Z" }, "merged in the window"],
    [{ mergedAt: null }, "merged in the window"],
    [{ closingIssuesReferences: { totalCount: 0, nodes: [] } }, "closes one issue in the repository"],
    [{ closingIssuesReferences: { totalCount: 1, nodes: [issue("2026-07-20T00:00:00Z", "other/repo")] } }, "closes one issue in the repository"],
    [{ closingIssuesReferences: { totalCount: 2, nodes: [issue("2026-07-20T00:00:00Z"), issue("2026-07-21T00:00:00Z", "sample/repo", 4)] } }, "closes one issue in the repository"],
    [{ closingIssuesReferences: { totalCount: 6, nodes: [issue("2026-07-20T00:00:00Z")] } }, "closes one issue in the repository"],
    [{ closingIssuesReferences: { totalCount: 1, nodes: [issue("2026-06-30T23:59:59Z")] } }, "issue opened after the cutoff"],
    [{ files: [{ path: "src/fix.py" }] }, "changes tests"],
    [{ files: ["a.py", "b.py", "c.py", "README.md", "tests/test_a.py"].map((path) => ({ path })) }, "at most 3 non-test files"],
  ];
  for (const [over, failed] of cases) assert.equal(prVerdict(pr(over), FREEZE_END).failed, failed, JSON.stringify(over));
  // A cross-repository issue beside the repository's own one leaves one problem statement.
  const both = { totalCount: 2, nodes: [issue("2026-07-20T00:00:00Z"), issue("2026-07-20T00:00:00Z", "other/repo", 9)] };
  assert.equal(prVerdict(pr({ closingIssuesReferences: both }), FREEZE_END).failed, null);
  // Exactly three non-test files is inside the cap.
  assert.equal(prVerdict(pr({ files: ["a.py", "b.py", "c.py", "tests/test_a.py"].map((path) => ({ path })) }), FREEZE_END).failed, null);
});

test("search batches stay inside GitHub's query length", () => {
  const repos = Array.from({ length: 40 }, (_, i) => `owner-${i}/a-fairly-long-repository-name-${i}`);
  const rest = "is:pr is:merged merged:2026-07-01..2026-12-31";
  const batches = searchBatches(repos, rest);
  assert.deepEqual(batches.flat(), repos);
  for (const b of batches) assert.ok([...b.map((r) => `repo:${r}`), rest].join(" ").length <= 256);
  assert.ok(batches.length > 1);
});

test("the whole build against a fake GitHub counts every step", async () => {
  const repoList = {
    dataset: "sample/data",
    commit: "abc",
    repos: [
      { repo: "sample/repo", recipe_instance: "sample__repo-1" },
      { repo: "sample/old-name", recipe_instance: "sample__repo-0" },
      { repo: "sample/gone", recipe_instance: null },
      { repo: "sample/rusty", recipe_instance: null },
    ],
  };
  const repos = { "sample/repo": repo(), "sample/old-name": repo(), "sample/gone": null, "sample/rusty": repo({ nameWithOwner: "sample/rusty", primaryLanguage: { name: "Rust" } }) };
  const asNode = (p) => ({ ...p, files: { pageInfo: { hasNextPage: p.more ?? false, endCursor: "c1" }, nodes: p.files } });
  const found = [
    asNode(pr()),
    asNode(pr({ number: 8, files: [{ path: "src/fix.py" }], more: true })),
    asNode(pr({ number: 9, mergedAt: "2026-07-01T12:00:00Z" })),
    asNode(pr({ number: 10, closingIssuesReferences: { totalCount: 0, nodes: [] } })),
  ];
  const queries = [];
  const graphql = async (query, vars) => {
    queries.push(vars.q ?? null);
    if (query.includes("search(")) {
      if (!vars.after) return { search: { issueCount: 4, pageInfo: { hasNextPage: true, endCursor: "p1" }, nodes: found.slice(0, 2) } };
      return { search: { issueCount: 4, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [...found.slice(2), found[0]] } };
    }
    if (query.includes("pullRequest(")) return { repository: { pullRequest: { files: { pageInfo: { hasNextPage: false }, nodes: [{ path: "tests/test_more.py" }] } } } };
    const data = {};
    repoList.repos.forEach((r, j) => {
      if (vars[`o${j}`]) data[`r${j}`] = repos[`${vars[`o${j}`]}/${vars[`n${j}`]}`];
    });
    return data;
  };
  const built = await buildCandidates(graphql, repoList, "2026-10-20", { pause: async () => {} });
  assert.deepEqual(built.repos, {
    listed: 4,
    eligible: 1,
    excluded: [
      { repo: "sample/gone", reason: "not found on GitHub" },
      { repo: "sample/old-name", reason: "same repository as sample/repo" },
      { repo: "sample/rusty", reason: "not Python, JavaScript or TypeScript" },
    ],
  });
  assert.deepEqual(built.pull_requests, {
    searched: 4,
    kept_after: { "merged in the window": 3, "closes one issue in the repository": 2, "issue opened after the cutoff": 2, "changes tests": 2, "at most 3 non-test files": 2 },
  });
  // The second page of files is fetched, so #8's test file counts.
  assert.deepEqual(built.candidates.map((c) => c.task_id), ["sample__repo-7", "sample__repo-8"]);
  assert.deepEqual(built.candidates[1].test_files, ["tests/test_more.py"]);
  assert.equal(built.candidates[0].recipe_instance, "sample__repo-1");
  assert.ok(queries.filter(Boolean).every((q) => q === "repo:sample/repo is:pr is:merged merged:2026-07-01..2026-10-20"));
});

test("the client waits out rate limits and refuses other errors", async () => {
  const waits = [];
  const resetAt = new Date(Date.now() + 1000).toISOString();
  const answers = [
    new Response("", { status: 403, headers: { "retry-after": "30" } }),
    Response.json({ errors: [{ type: "RATE_LIMITED", message: "slow down" }] }),
    Response.json({ data: { rateLimit: { remaining: 10, resetAt }, x: 1 }, errors: [{ type: "NOT_FOUND", message: "gone" }] }),
  ];
  const graphql = client("t", async () => answers.shift(), async (ms) => waits.push(ms));
  assert.deepEqual(await graphql("q"), { rateLimit: { remaining: 10, resetAt }, x: 1 });
  assert.equal(waits.length, 3);
  assert.equal(waits[0], 30000);
  assert.equal(waits[1], 120000);

  const broken = client("t", async () => Response.json({ errors: [{ type: "INTERNAL", message: "no" }] }), async () => {});
  await assert.rejects(broken("q"), /GitHub GraphQL: no/);
});
