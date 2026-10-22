import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { lock, packFiles, redact, refusal, sealRound, sha256, transitKey, unlock, unpackFiles } from "../scripts/seal.mjs";
import { checkSealed, lockedRound, outcomeOf } from "../scripts/unseal.mjs";
import { roundTime } from "../scripts/seed.mjs";

// A real tlock ciphertext of "hi", locked to quicknet round 30000000.
const ARMORED = `-----BEGIN AGE ENCRYPTED FILE-----
YWdlLWVuY3J5cHRpb24ub3JnL3YxCi0+IHRsb2NrIDMwMDAwMDAwIDUyZGI5YmE3
MGUwY2MwZjZlYWY3ODAzZGQwNzQ0N2ExZjU0Nzc3MzVmZDNmNjYxNzkyYmE5NDYw
MGM4NGU5NzEKaW0zcXBTWUhhMStpbVdWWU4rS1ZkOFNvVVNwS0RvczVLdjd0ZlNx
VmQ2KytmWTRYdjlWZXJxa3EzYkV1dHBzMQpBZEx4eWpJQmZkZVRUZ21peStUaVhp
VjJXWWdacnZYbE1lZ0pwRnJFSENlK0o0VGtHeUpGRG9OTTBVdzJiRXZYCm84OTRK
QjcyZG82ZG1XR3pEMjhibjB5VjI4cmtQN2o5eUxacVJhS3k1MWMKLS0tIDU0SjBM
U2cxc0pkUXE3SEl0RndXYnAydzdnM0JDUjlnRlBmTkg2bjhRT2MKJKYa1ubqkI12
TZV54f98AZTBnMTPHDpB6r3hwjvdTwe5oQ==
-----END AGE ENCRYPTED FILE-----
`;

const REPORT = {
  run_id: "bench_sample1",
  environment: { ok: true, reason: null },
  hidden: { fail_to_pass: { total: 2, passed: 2 }, pass_to_pass: { total: 5, passed: 4 } },
  claimed_done: true,
  stopped_on_error: false,
  capsid_job_id: null,
  usage: { model: "m", claude_code_version: "2.0.0", cost_usd: 1.5, turns: 12, duration_ms: 1000, input_tokens: 9, output_tokens: 9, cache_read_tokens: 0, cache_creation_tokens: 0 },
  image_bytes: 100,
};

test("the transit lock round-trips a run's files and refuses another run's key", () => {
  const dir = mkdtempSync(join(tmpdir(), "seal-"));
  writeFileSync(join(dir, "diff.patch"), "+fix\n");
  writeFileSync(join(dir, "claim.json"), '{"claimed_done":true}');
  const key = transitKey("sample-key", "bench_sample1");
  const locked = lock(key, Buffer.from(JSON.stringify(packFiles(dir))));
  assert.ok(!locked.includes(Buffer.from("claimed_done")));
  const out = mkdtempSync(join(tmpdir(), "seal-out-"));
  unpackFiles(JSON.parse(unlock(key, locked).toString()), out);
  assert.equal(readFileSync(join(out, "diff.patch"), "utf8"), "+fix\n");
  assert.throws(() => unlock(transitKey("sample-key", "bench_sample2"), locked));
  assert.throws(() => unpackFiles({ "../x": "" }, out), /refusing/);
});

test("a seal to a published round is refused", () => {
  assert.throws(() => sealRound("2024-01-01T00:00:00Z"), /already published/);
  const round = sealRound("2030-01-01T00:00:00Z", Date.parse("2027-01-01T00:00:00Z"));
  assert.ok(roundTime(round) > Date.parse("2027-01-01T00:00:00Z") / 1000);
});

test("the redacted report carries no outcome, claim or usage figure", () => {
  const sealed = { sha256: "a".repeat(64), log_index: 7 };
  const out = redact(REPORT, sealed);
  assert.deepEqual(out.hidden, { fail_to_pass: { total: 2 }, pass_to_pass: { total: 5 } });
  assert.equal(out.claimed_done, undefined);
  assert.deepEqual(out.usage, { model: "m", claude_code_version: "2.0.0" });
  assert.deepEqual(out.sealed, sealed);
  assert.deepEqual(Object.keys(refusal(REPORT, "Rekor was down")).sort(), ["environment", "run_id"]);
  assert.equal(refusal(REPORT, "x").environment.ok, false);
});

test("the ciphertext's round is read from its header", () => {
  assert.equal(lockedRound(ARMORED), 30000000);
});

test("a sealed run opens only when its hash, Rekor entry and round all match", () => {
  const ciphertext = Buffer.from(ARMORED);
  const round = 30000000;
  const recorded = { sha256: sha256(ciphertext), log_index: 11 };
  const bundle = { verificationMaterial: { tlogEntries: [{ logIndex: "11", integratedTime: String(roundTime(round) - 60) }] } };
  checkSealed({ runId: "r", recorded, ciphertext, bundle, round });
  assert.throws(() => checkSealed({ runId: "r", recorded: { ...recorded, sha256: "b".repeat(64) }, ciphertext, bundle, round }), /SHA-256/);
  assert.throws(() => checkSealed({ runId: "r", recorded: { ...recorded, log_index: 12 }, ciphertext, bundle, round }), /Rekor index/);
  const late = { verificationMaterial: { tlogEntries: [{ logIndex: "11", integratedTime: String(roundTime(round)) }] } };
  assert.throws(() => checkSealed({ runId: "r", recorded, ciphertext, bundle: late, round }), /not before round/);
  assert.throws(() => checkSealed({ runId: "r", recorded, ciphertext, bundle, round: round + 1 }), /not R_seal/);
});

test("an opened bundle gives the fields the analysis reads, for its own run only", () => {
  assert.deepEqual(outcomeOf("bench_sample1", { run_id: "bench_sample1", report: REPORT }), { claimed_done: 1, fail_to_pass_passed: 2, pass_to_pass_passed: 4, turns: 12, output_tokens: 9, duration_ms: 1000 });
  assert.throws(() => outcomeOf("bench_sample2", { run_id: "bench_sample1", report: REPORT }), /opens to run/);
});

test("unseal opens a run whose checks pass and marks one that fails as missing", async () => {
  const { unseal } = await import("../scripts/unseal.mjs");
  const { mkdirSync } = await import("node:fs");
  const round = 30000000;
  const dir = mkdtempSync(join(tmpdir(), "sealed-"));
  mkdirSync(join(dir, "sealed"));
  const ciphertext = Buffer.from(ARMORED);
  const bundle = { verificationMaterial: { tlogEntries: [{ logIndex: "11", integratedTime: String(roundTime(round) - 60) }] } };
  for (const id of ["bench_a", "bench_b"]) {
    writeFileSync(join(dir, "sealed", `${id}.tlock`), ciphertext);
    writeFileSync(join(dir, "sealed", `${id}.sigstore.json`), JSON.stringify(bundle));
  }
  const sealedReport = (sha) => JSON.stringify({ sealed: { sha256: sha, log_index: 11 } });
  const data = {
    tasks: [],
    draw: [],
    runs: [
      { id: "bench_a", status: "scored", report: sealedReport(sha256(ciphertext)) },
      { id: "bench_b", status: "scored", report: sealedReport("c".repeat(64)) },
      { id: "bench_c", status: "scored", claimed_done: 0, report: "{}" },
    ],
  };
  const opened = { run_id: "bench_a", report: { ...REPORT, run_id: "bench_a" } };
  const tlock = { mainnetClient: () => ({}), timelockDecrypt: async () => Buffer.from(JSON.stringify(opened)) };
  const sigstore = { createVerifier: async () => ({ verify: () => {} }) };
  const out = await unseal(data, { sealedDir: dir, t: new Date(roundTime(round) * 1000).toISOString().replace(/\.\d+Z$/, "Z"), commit: "a".repeat(40), tlock, sigstore });
  assert.equal(out.opened, 1);
  assert.equal(out.data.runs[0].fail_to_pass_passed, 2);
  assert.equal(out.data.runs[1].status, "missing");
  assert.match(out.missing[0].reason, /SHA-256/);
  assert.deepEqual(out.data.runs[2], data.runs[2]);
});

test("the analysis refuses an export with a sealed run still closed, and a missing run ends its slot empty", async () => {
  const { analyze, slots } = await import("../scripts/analyze.mjs");
  const run = { id: "bench_a", task_id: "t", arm: "baseline", status: "scored", report: JSON.stringify({ sealed: { sha256: "a".repeat(64), log_index: 1 } }) };
  assert.throws(() => analyze({ tasks: [], draw: [], runs: [run] }, { n: 1, accepted: [], audit: [] }), /still sealed/);
  const scored = { status: "scored", report: "{}" };
  assert.deepEqual(slots([{ status: "missing", report: "{}" }, scored], new Set()), [null, scored]);
});
