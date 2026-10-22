import assert from "node:assert/strict";
import { test } from "node:test";
import { fenced, nextAction, parseDecision, parseModelDecision, permutation, replay, secondPrompt, secondReaderConfig } from "../scripts/walk.mjs";

// The walk (protocol section 4, "Audit" and "Draw") replayed from hand-made logs over a
// fake frame: repositories in the "sample" namespace.

const frame = ["a", "a", "a", "b", "b", "c", "d", "e"].map((repo, i) => ({ task_id: `sample__${repo}-${i}`, repo: `sample/${repo}` }));
const start = (n) => ({ event: "start", seed: "seed-1", n, cap: 2 });
const order = permutation(frame.map((c) => c.task_id), "seed-1");
const at = (i) => ({ position: i + 1, task_id: order[i], repo: frame.find((c) => c.task_id === order[i]).repo });
const pass = (i) => ({ ...at(i), event: "gates passed" });
const audit = (i, reader, decision) => ({ ...at(i), event: "audit", reader, decision, ...(decision === "out" ? { reason: "ambiguous", quote: "x" } : {}) });
// Both readers' decisions on one candidate that passed the gates.
const both = (i, author, second = "in") => [pass(i), audit(i, "second", second), audit(i, "author", author)];

test("the permutation is fixed by the seed and keeps every candidate", () => {
  assert.deepEqual(permutation(["x", "y", "z", "w"], "s"), permutation(["x", "y", "z", "w"], "s"));
  assert.notDeepEqual(order, frame.map((c) => c.task_id));
  assert.deepEqual([...order].sort(), frame.map((c) => c.task_id).sort());
});

test("the walk starts at the first position, and each pass goes to the second reader and then waits for the author", () => {
  assert.deepEqual(nextAction(replay(frame, [start(3)])), { action: "validate", position: 1, task_id: order[0], repo: at(0).repo });
  assert.deepEqual(nextAction(replay(frame, [start(3), pass(0)])), { action: "second-read", task_id: order[0], position: 1 });
  const waiting = nextAction(replay(frame, [start(3), pass(0), audit(0, "second", "in")]));
  assert.deepEqual(waiting, { action: "wait", reader: "author", tasks: [order[0]] });
  // An excluded candidate needs no audit: the walk goes on.
  assert.equal(nextAction(replay(frame, [start(3), { ...at(0), event: "excluded", reason: "build failed" }])).position, 2);
  assert.equal(nextAction(replay(frame, [start(3), ...both(0, "out")])).position, 2);
});

test("a candidate is skipped once its repository has 2 accepted tasks", () => {
  // Accept every candidate in order until one would be a third from its repository.
  const log = [start(8)];
  const seen = new Map();
  for (let i = 0; i < order.length; i++) {
    const next = nextAction(replay(frame, log));
    const repo = at(i).repo;
    if ((seen.get(repo) ?? 0) >= 2) {
      assert.equal(next.action, "skip");
      log.push({ ...at(i), event: "skipped" });
      continue;
    }
    assert.equal(next.action, "validate");
    seen.set(repo, (seen.get(repo) ?? 0) + 1);
    log.push(...both(i, "in"));
  }
  assert.ok(log.some((r) => r.event === "skipped"));
  assert.equal(replay(frame, log).accepted.length, 7);
});

test("either reader's out keeps a task out of the accepted set and off its repository's cap", () => {
  const log = [start(2), ...both(0, "in", "out"), ...both(1, "out", "in"), ...both(2, "in")];
  assert.deepEqual(replay(frame, log).accepted, [order[2]]);
  assert.equal(nextAction(replay(frame, log)).position, 4);
  // A non-marking response leaves the author's accept standing.
  log.push(...both(3, "in", "none"));
  assert.deepEqual(replay(frame, log).accepted, [order[2], order[3]]);
  assert.deepEqual(nextAction(replay(frame, log)), { action: "done", accepted: 2, n: 2, unmet: false });
});

test("an exhausted permutation ends the walk with N unmet", () => {
  const log = [start(20), ...order.map((_, i) => ({ ...at(i), event: "excluded", reason: "did not fail before" }))];
  assert.deepEqual(nextAction(replay(frame, log)), { action: "done", accepted: 0, n: 20, unmet: true });
});

test("a reader's comment is in, or out with a listed code and a quote", () => {
  assert.deepEqual(parseDecision("in"), { decision: "in" });
  assert.deepEqual(parseDecision(" IN \n"), { decision: "in" });
  assert.deepEqual(parseDecision('out ambiguous "either return None or raise"'), { decision: "out", reason: "ambiguous", quote: '"either return None or raise"' });
  assert.deepEqual(parseDecision("out network-or-time\n> calls example.com"), { decision: "out", reason: "network-or-time", quote: "> calls example.com" });
  assert.equal(parseDecision("out ambiguous"), null);
  assert.equal(parseDecision("out bad-code because"), null);
  assert.equal(parseDecision("in, looks fine"), null);
  assert.equal(parseDecision("looks fine"), null);
});

test("audit text is fenced so nothing in it renders or links", () => {
  assert.equal(fenced("a ``` b"), "````\na ``` b\n````");
  assert.equal(fenced("@someone #12"), "```\n@someone #12\n```");
});

test("the seed's round is the quicknet round produced at T, or the last one before it", async () => {
  const { roundAt, roundTime, roundMessage } = await import("../scripts/seed.mjs");
  assert.equal(roundAt("2023-08-23T15:09:27Z"), 1);
  assert.equal(roundAt("2023-08-23T15:09:29Z"), 1);
  assert.equal(roundAt("2023-08-23T15:09:30Z"), 2);
  assert.equal(roundTime(roundAt("2026-11-01T00:00:00Z")) <= Date.parse("2026-11-01T00:00:00Z") / 1000, true);
  assert.throws(() => roundAt("2026-11-01 00:00"));
  assert.equal(roundMessage(1).toString("hex"), "cd2662154e6d76b2b2b92e70c0cac3ccf534f9b74eb5b89819ec509083d00a50");
});

test("the second reader marks out only with out and exactly one listed code", () => {
  assert.deepEqual(parseModelDecision("in"), { decision: "in" });
  assert.deepEqual(parseModelDecision("`out ambiguous`"), { decision: "out", reason: "ambiguous" });
  assert.deepEqual(parseModelDecision("out network-or-time"), { decision: "out", reason: "network-or-time" });
  for (const text of ["out", "out unclear", "out ambiguous network-or-time", "I can't help with that.", "", null, "in, but ambiguous"]) {
    assert.deepEqual(parseModelDecision(text), { decision: "none" }, String(text));
  }
});

test("the second reader's prompt holds the list and the packet but never the gold patch, and its vendor is not Anthropic", () => {
  const prompt = secondPrompt("{{REASONS}}\n{{TASK}}", { repo: "sample/a", problem_statement: "It breaks.", FAIL_TO_PASS: ["t1"], test_patch: "+t", patch: "+gold" });
  assert.match(prompt, /ambiguous: the issue is ambiguous/);
  assert.match(prompt, /It breaks\.[\s\S]*t1[\s\S]*\+t\nTASK>>>$/);
  assert.doesNotMatch(prompt, /gold|fixing change/);
  assert.throws(() => secondReaderConfig({ SECOND_READER_URL: "https://api.anthropic.com/v1/messages", SECOND_READER_MODEL: "m" }, "p"));
  assert.throws(() => secondReaderConfig({ SECOND_READER_URL: "https://example.com/v1", SECOND_READER_MODEL: "claude-x" }, "p"));
  assert.throws(() => secondReaderConfig({}, "p"));
  assert.equal(secondReaderConfig({ SECOND_READER_URL: "https://example.com/v1", SECOND_READER_MODEL: "m" }, "p").prompt_sha256.length, 64);
});
