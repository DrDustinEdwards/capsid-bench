import assert from "node:assert/strict";
import { test } from "node:test";
import { bodyAt, findBase, leakage, splitDiff } from "../scripts/prepare-candidate.mjs";

// Turning a frame candidate into a task (protocol section 4): the base commit, the frozen
// issue text and the leakage screen, against hand-made GitHub answers.

const DIFF = `diff --git a/src/fix.py b/src/fix.py
index 1..2 100644
--- a/src/fix.py
+++ b/src/fix.py
@@ -1 +1 @@
-x = 1
+x = compute(2)
diff --git a/tests/test_fix.py b/tests/test_fix.py
--- a/tests/test_fix.py
+++ b/tests/test_fix.py
@@ -0,0 +1 @@
+assert x == 2
`;

test("a diff splits into its files", () => {
  const parts = splitDiff(DIFF);
  assert.deepEqual(parts.map((p) => p.path), ["src/fix.py", "tests/test_fix.py"]);
  assert.equal(parts.map((p) => p.text).join(""), DIFF);
});

const candidate = (over = {}) => ({ merge_commit: "m", merge_parents: ["p"], test_files: ["tests/test_fix.py"], fix_files: ["src/fix.py"], ...over });

test("the base is the parent of the fixing change, or not found", async () => {
  const files = { "p..m": ["src/fix.py", "tests/test_fix.py"], "p2..m": ["src/fix.py", "tests/test_fix.py"] };
  const tools = (map) => ({ filesBetween: async (a, b) => map[`${a}..${b}`] ?? [], parentOf: async (sha) => ({ m: "p", p: "p2", p2: "p3" })[sha] });
  // A merge commit: its first parent.
  assert.equal(await findBase(candidate({ merge_parents: ["first", "second"] }), 3, tools({})), "first");
  // A squash: the one parent carries exactly the pull request's files.
  assert.equal(await findBase(candidate(), 1, tools(files)), "p");
  // A rebase of two commits: the parent only carries part, two back carries all.
  assert.equal(await findBase(candidate(), 2, tools({ "p..m": ["tests/test_fix.py"], "p2..m": files["p2..m"] })), "p2");
  // Neither: not found.
  assert.equal(await findBase(candidate(), 2, tools({ "p..m": ["tests/test_fix.py"], "p2..m": ["other.py"] })), null);
  assert.equal(await findBase(candidate({ merge_commit: null }), 1, tools(files)), null);
});

test("the issue text is the body as it stood before the first fix commit", () => {
  const issue = {
    body: "edited later",
    lastEditedAt: "2026-08-03T00:00:00Z",
    userContentEdits: { nodes: [{ editedAt: "2026-08-03T00:00:00Z", diff: "edited later" }, { editedAt: "2026-08-01T00:00:00Z", diff: "original" }, { editedAt: "2026-08-02T00:00:00Z", diff: "first edit" }] },
  };
  assert.equal(bodyAt(issue, "2026-08-02T12:00:00Z"), "first edit");
  assert.equal(bodyAt(issue, "2026-08-01T12:00:00Z"), "original");
  // Every edit after the fix began: the oldest revision.
  assert.equal(bodyAt(issue, "2026-07-30T00:00:00Z"), "original");
  assert.equal(bodyAt(issue, "2026-09-01T00:00:00Z"), "edited later");
  assert.equal(bodyAt({ body: "never edited", lastEditedAt: null }, "2026-07-30T00:00:00Z"), "never edited");
});

test("the edit history is paged back until an edit at or before the first fix", async () => {
  const { editsBack } = await import("../scripts/prepare-candidate.mjs");
  const calls = [];
  const gh = { graphql: async (_q, vars) => (calls.push(vars.before), { repository: { issue: { userContentEdits: { nodes: [{ editedAt: "2026-08-01T00:00:00Z", diff: "original" }], pageInfo: { hasPreviousPage: false, startCursor: null } } } } }) };
  const newest = { nodes: [{ editedAt: "2026-08-05T00:00:00Z", diff: "later" }], pageInfo: { hasPreviousPage: true, startCursor: "c1" } };
  const edits = await editsBack(gh, {}, newest, "2026-08-02T00:00:00Z");
  assert.deepEqual(calls, ["c1"]);
  assert.equal(bodyAt({ body: "later", lastEditedAt: "2026-08-05T00:00:00Z", userContentEdits: edits }, "2026-08-02T00:00:00Z"), "original");
  // An edit before the fix is already in hand: no further page.
  await editsBack(gh, {}, { nodes: [{ editedAt: "2026-08-01T00:00:00Z", diff: "x" }], pageInfo: { hasPreviousPage: true, startCursor: "c2" } }, "2026-08-02T00:00:00Z");
  assert.deepEqual(calls, ["c1"]);
});

test("the leakage screen matches whole added lines, not punctuation", () => {
  const issue = "It breaks.\n  x = compute(2)  \n}\n";
  assert.deepEqual(leakage(DIFF, issue), ["x = compute(2)"]);
  assert.deepEqual(leakage("+++ b/x\n+}\n+  \n+);\n", "}\n);\n"), []);
  assert.deepEqual(leakage(DIFF, "x = compute(2) is the fix"), []);
});

test("the leakage screen also matches identifiers the gold patch introduces, as whole words", async () => {
  const { addedIdentifiers, introducedIdentifiers } = await import("../scripts/prepare-candidate.mjs");
  const patch = "+++ b/x.py\n+def parse_rows(maxRows):\n+    return helper_one(maxRows) + value\n";
  assert.deepEqual(addedIdentifiers(patch), ["helper_one", "maxRows", "parse_rows"]);
  // helper_one is already in the base tree, so the patch does not introduce it.
  const introduced = introducedIdentifiers(patch, new Set(["helper_one"]));
  assert.deepEqual(introduced, ["maxRows", "parse_rows"]);
  assert.deepEqual(leakage(patch, "Add parse_rows for the CSV path.", introduced), ["identifier parse_rows"]);
  assert.deepEqual(leakage(patch, "We call helper_one and parse rows by hand.", introduced), []);
});
