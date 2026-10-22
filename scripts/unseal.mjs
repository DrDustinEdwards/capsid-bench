#!/usr/bin/env node
// Opens the sealed runs for the analysis (protocol section 8; scripts/seal.mjs seals them).
// Run only after round R_seal is published.
//
//   SEAL_MODULES=... node scripts/unseal.mjs export.json --sealed <checkout of the sealed
//     branch> --t <T_seal> --commit <registered commit of bench-run.yml> --out opened.json
//
// For each scored run whose stored report carries `sealed`, it opens the run only when
// every check passes. A run that fails one is a missing run (section 8): its status
// becomes "missing", which scripts/analyze.mjs counts as a slot with no scored run, and
// the reason is printed. A failure to reach drand stops the script instead.
//   - sealed/<run>.tlock exists and its SHA-256 is the one Capsid recorded;
//   - its Sigstore bundle verifies against the public-good trust root, signed by
//     bench-run.yml on main of this repository at the registered commit;
//   - the bundle's Rekor entry is the index Capsid recorded, and was integrated before
//     round R_seal was published;
//   - the ciphertext is locked to R_seal itself, and opens to this run's own bundle.
// It writes the export with each opened run's claim, hidden passed counts and usage filled
// in, the fields scripts/analyze.mjs reads.

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { roundAt, roundTime, QUICKNET } from "./seed.mjs";
import { sha256 } from "./seal.mjs";

export const REPOSITORY = "DrDustinEdwards/capsid-bench";
export const WORKFLOW_IDENTITY = `https://github.com/${REPOSITORY}/.github/workflows/bench-run.yml@refs/heads/main`;
export const ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
// Fulcio's GitHub Workflow SHA extension: the commit the signing workflow ran at.
export const WORKFLOW_SHA_OID = "1.3.6.1.4.1.57264.1.3";

const reportOf = (run) => (run.report && typeof run.report === "object" ? run.report : JSON.parse(run.report ?? "null") ?? {});

// The round an armored tlock ciphertext is locked to, from its age header's tlock stanza.
export function lockedRound(armored) {
  const body = armored
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("-----"))
    .join("");
  const header = Buffer.from(body, "base64").toString("latin1");
  const stanza = header.match(/^-> tlock (\d+) ([0-9a-f]{64})$/m);
  if (!stanza) throw new Error("no tlock stanza in the ciphertext's header");
  if (stanza[2] !== QUICKNET.chain_hash) throw new Error(`locked to chain ${stanza[2]}, not quicknet`);
  return Number(stanza[1]);
}

// The checks that need no network, on one run's stored files.
export function checkSealed({ runId, recorded, ciphertext, bundle, round }) {
  if (sha256(ciphertext) !== recorded.sha256) throw new Error(`${runId}: the ciphertext's SHA-256 is not the one Capsid recorded`);
  const entry = bundle.verificationMaterial?.tlogEntries?.[0];
  if (!entry) throw new Error(`${runId}: the Sigstore bundle has no Rekor entry`);
  if (Number(entry.logIndex) !== recorded.log_index) throw new Error(`${runId}: Rekor index ${entry.logIndex}, but Capsid recorded ${recorded.log_index}`);
  if (!(Number(entry.integratedTime) < roundTime(round))) throw new Error(`${runId}: integrated into Rekor at ${entry.integratedTime}, not before round ${round} at ${roundTime(round)}`);
  const locked = lockedRound(ciphertext.toString("utf8"));
  if (locked !== round) throw new Error(`${runId}: locked to round ${locked}, not R_seal ${round}`);
}

// The opened bundle's outcome fields, as Capsid would have stored them unsealed.
export function outcomeOf(runId, opened) {
  if (opened.run_id !== runId || opened.report?.run_id !== runId) throw new Error(`${runId}: the ciphertext opens to run ${opened.run_id}'s bundle`);
  const hidden = opened.report.hidden;
  if (!hidden) throw new Error(`${runId}: the sealed report has no hidden test counts`);
  const u = opened.report.usage ?? {};
  return {
    claimed_done: opened.report.claimed_done === true ? 1 : 0,
    fail_to_pass_passed: hidden.fail_to_pass.passed,
    pass_to_pass_passed: hidden.pass_to_pass.passed,
    turns: u.turns ?? null,
    output_tokens: u.output_tokens ?? null,
    duration_ms: u.duration_ms ?? null,
  };
}

export async function unseal(data, { sealedDir, t, commit, tlock, sigstore }) {
  const round = roundAt(t);
  if (Date.now() / 1000 < roundTime(round)) throw new Error(`round ${round} is not published yet`);
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error("--commit must be the registered 40-character commit");
  const verifier = await sigstore.createVerifier({ certificateIdentityURI: WORKFLOW_IDENTITY, certificateIssuer: ACTIONS_ISSUER, certificateOIDs: { [WORKFLOW_SHA_OID]: commit } });
  const runs = [];
  const missing = [];
  let opened = 0;
  for (const run of data.runs) {
    const recorded = reportOf(run).sealed;
    if (!recorded || run.status !== "scored") {
      runs.push(run);
      continue;
    }
    let ciphertext;
    try {
      ciphertext = readFileSync(join(sealedDir, "sealed", `${run.id}.tlock`));
      const bundle = JSON.parse(readFileSync(join(sealedDir, "sealed", `${run.id}.sigstore.json`), "utf8"));
      checkSealed({ runId: run.id, recorded, ciphertext, bundle, round });
      verifier.verify(bundle, ciphertext);
    } catch (err) {
      missing.push({ id: run.id, reason: err.message });
      runs.push({ ...run, status: "missing" });
      continue;
    }
    const plain = await tlock.timelockDecrypt(ciphertext.toString("utf8"), tlock.mainnetClient());
    let outcome;
    try {
      outcome = outcomeOf(run.id, JSON.parse(plain.toString("utf8")));
    } catch (err) {
      missing.push({ id: run.id, reason: err.message });
      runs.push({ ...run, status: "missing" });
      continue;
    }
    runs.push({ ...run, ...outcome });
    opened++;
  }
  return { data: { ...data, runs }, opened, missing };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { sealed: { type: "string" }, t: { type: "string" }, commit: { type: "string" }, out: { type: "string" } } });
  const require = createRequire(join(process.env.SEAL_MODULES ?? ".", "unseal.cjs"));
  const data = JSON.parse(readFileSync(positionals[0], "utf8"));
  unseal(data, { sealedDir: values.sealed, t: values.t, commit: values.commit, tlock: require("tlock-js"), sigstore: require("sigstore") })
    .then(({ data: out, opened, missing }) => {
      writeFileSync(values.out, JSON.stringify(out));
      console.log(`opened ${opened} sealed runs; ${missing.length} missing`);
      for (const m of missing) console.log(`missing ${m.id}: ${m.reason}`);
    })
    .catch((err) => {
      console.error(`unseal: ${err.message}`);
      process.exit(1);
    });
}
