import assert from "node:assert/strict";
import { test } from "node:test";
import { fenced, nextAction, parseDecision, permutation, replay, secondSubset } from "../scripts/walk.mjs";

// The walk (protocol section 4, "Audit" and "Draw") replayed from hand-made logs over a
// fake frame: repositories in the "sample" namespace.

const frame = ["a", "a", "a", "b", "b", "c", "d", "e"].map((repo, i) => ({ task_id: `sample__${repo}-${i}`, repo: `sample/${repo}` }));
const start = (n) => ({ event: "start", seed: "seed-1", n, cap: 2 });
const order = permutation(frame.map((c) => c.task_id), "seed-1");
const at = (i) => ({ position: i + 1, task_id: order[i], repo: frame.find((c) => c.task_id === order[i]).repo });
const pass = (i) => ({ ...at(i), event: "gates passed" });
const audit = (i, reader, decision) => ({ ...at(i), event: "audit", reader, decision, ...(decision === "out" ? { reason: "ambiguous", quote: "x" } : {}) });

test("the permutation is fixed by the seed and keeps every candidate", () => {
  assert.deepEqual(permutation(["x", "y", "z", "w"], "s"), permutation(["x", "y", "z", "w"], "s"));
  assert.notDeepEqual(order, frame.map((c) => c.task_id));
  assert.deepEqual([...order].sort(), frame.map((c) => c.task_id).sort());
});

test("the walk starts at the first position and waits on each pass for the author", () => {
  assert.deepEqual(nextAction(replay(frame, [start(3)])), { action: "validate", position: 1, task_id: order[0], repo: at(0).repo });
  const waiting = nextAction(replay(frame, [start(3), pass(0)]));
  assert.deepEqual(waiting, { action: "wait", reader: "author", tasks: [order[0]] });
  // An excluded candidate needs no audit: the walk goes on.
  assert.equal(nextAction(replay(frame, [start(3), { ...at(0), event: "excluded", reason: "build failed" }])).position, 2);
  assert.equal(nextAction(replay(frame, [start(3), pass(0), audit(0, "author", "out")])).position, 2);
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
    log.push(pass(i), audit(i, "author", "in"));
  }
  assert.ok(log.some((r) => r.event === "skipped"));
  assert.equal(replay(frame, log).accepted.length, 7);
});

test("at N the second reader's subset is drawn, and a removal reopens the walk", () => {
  const log = [start(2), pass(0), audit(0, "author", "in"), pass(1), audit(1, "author", "out"), pass(2), audit(2, "author", "in")];
  const drawn = nextAction(replay(frame, log));
  assert.equal(drawn.action, "draw-second");
  // Fewer than 20 audited: the second reader audits every one, in permutation order.
  assert.deepEqual(drawn.tasks, [order[0], order[1], order[2]]);
  log.push({ event: "second reader set", tasks: drawn.tasks });
  assert.deepEqual(nextAction(replay(frame, log)), { action: "wait", reader: "second", tasks: drawn.tasks });
  // The second reader takes one out: the walk resumes at the next position.
  log.push(audit(0, "second", "out"), audit(1, "second", "in"), audit(2, "second", "in"));
  assert.deepEqual(replay(frame, log).accepted, [order[2]]);
  assert.equal(nextAction(replay(frame, log)).position, 4);
  // The second reader cannot bring the author's reject back in.
  assert.ok(!replay(frame, log).accepted.includes(order[1]));
  // A replacement goes to the author, then the second reader, before the walk is done.
  log.push(pass(3), audit(3, "author", "in"));
  assert.deepEqual(nextAction(replay(frame, log)), { action: "wait", reader: "second", tasks: [order[3]] });
  log.push(audit(3, "second", "in"));
  assert.deepEqual(nextAction(replay(frame, log)), { action: "done", accepted: 2, n: 2, unmet: false });
});

test("an exhausted permutation ends the walk with N unmet", () => {
  const log = [start(20), ...order.map((_, i) => ({ ...at(i), event: "excluded", reason: "did not fail before" }))];
  assert.equal(nextAction(replay(frame, log)).action, "draw-second");
  log.push({ event: "second reader set", tasks: [] });
  assert.deepEqual(nextAction(replay(frame, log)), { action: "done", accepted: 0, n: 20, unmet: true });
});

test("the second reader's subset is 10 and 10, filled from the other group when one is short", () => {
  const ids = (p, k) => Array.from({ length: k }, (_, i) => `${p}${i}`);
  const state = (inn, out) => ({ seed: "s", order: [...inn, ...out], authorIn: inn, authorOut: out });
  const count = (picked, p) => picked.filter((id) => id.startsWith(p)).length;
  const even = secondSubset(state(ids("i", 30), ids("o", 30)));
  assert.equal(count(even, "i"), 10);
  assert.equal(count(even, "o"), 10);
  const short = secondSubset(state(ids("i", 30), ids("o", 4)));
  assert.equal(count(short, "i"), 16);
  assert.equal(count(short, "o"), 4);
  assert.equal(secondSubset(state(ids("i", 12), ids("o", 5))).length, 17);
  assert.deepEqual(secondSubset(state(ids("i", 30), ids("o", 30))), even);
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
