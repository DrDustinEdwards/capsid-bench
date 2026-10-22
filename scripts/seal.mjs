#!/usr/bin/env node
// The seal (protocol section 8, Grok's ruling D, 2026-10-22). Until drand quicknet round
// R_seal, for the registered instant T_seal, no one can read a confirmatory run's
// transcript, diff or score, and Capsid holds no outcome for it.
//
//   node scripts/seal.mjs pack <dir> <out>          the run's files, locked for transit
//   node scripts/seal.mjs unpack <in> <dir>
//   node scripts/seal.mjs seal --t <T_seal> --report report.json --score score.json \
//     --dir <run dir> --out <dir>                   writes <run>.tlock, <run>.sigstore.json
//                                                   and the redacted report, redacted.json
//   node scripts/seal.mjs refuse --report report.json --reason "..." --out redacted.json
//
// TRANSIT. The repository is public, and so are its run artifacts and logs. The agent job
// packs the run's files into one AES-256-GCM file under a key derived from BENCH_KEY and
// the run id (HMAC-SHA256(BENCH_KEY, "transit:" + run id)); the score job unpacks it. No
// step prints a run's claim, transcript or hidden test result.
//
// THE SEAL. The bundle (the full report, the scorer's output and every file of the run)
// is encrypted with tlock to round R_seal, so it opens only once drand publishes that
// round. The ciphertext is signed keylessly with Sigstore from this workflow, which puts
// its SHA-256 in the public Rekor log with the workflow's identity and commit. Capsid gets
// the redacted report: the hidden suites' sizes and no passed counts, no claim, no usage,
// and the ciphertext's hash and Rekor index. scripts/unseal.mjs checks and opens it.
//
// Needs tlock-js and sigstore (pinned in the workflow); SEAL_MODULES names the
// node_modules directory they are installed in.

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { roundAt, roundTime } from "./seed.mjs";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function transitKey(benchKey, runId) {
  if (!benchKey || !runId) throw new Error("the transit key needs BENCH_KEY and the run id");
  return createHmac("sha256", benchKey).update(`transit:${runId}`).digest();
}

// Every regular file of `dir`, by name, base64.
export function packFiles(dir) {
  const files = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isFile()) files[entry.name] = readFileSync(join(dir, entry.name)).toString("base64");
  return files;
}
export function unpackFiles(files, dir) {
  mkdirSync(dir, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith(".")) throw new Error(`refusing the file name ${JSON.stringify(name)}`);
    writeFileSync(join(dir, name), Buffer.from(data, "base64"));
  }
}

export function lock(key, plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}
export function unlock(key, sealed) {
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(0, 12));
  decipher.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
}

// R_seal, refused once it has been published: a ciphertext to a past round hides nothing.
export function sealRound(tSeal, now = Date.now()) {
  const round = roundAt(tSeal);
  if (now / 1000 >= roundTime(round)) throw new Error(`round ${round} (T_seal ${tSeal}) is already published, so a seal to it would hide nothing`);
  return round;
}

// What Capsid receives for a sealed run. The suites' sizes are registered already, so
// they say nothing about the outcome; Capsid still checks them against the registration.
export function redact(report, sealed) {
  const sizes = report.hidden
    ? { hidden: { fail_to_pass: { total: report.hidden.fail_to_pass.total }, pass_to_pass: { total: report.hidden.pass_to_pass.total } } }
    : {};
  return {
    run_id: report.run_id,
    environment: report.environment,
    ...sizes,
    stopped_on_error: report.stopped_on_error === true,
    capsid_job_id: report.capsid_job_id ?? null,
    usage: { model: report.usage?.model ?? null, claude_code_version: report.usage?.claude_code_version ?? null },
    image_bytes: report.image_bytes ?? null,
    sealed,
  };
}

// A run that could not be sealed is unjudged, and carries nothing else.
export function refusal(report, reason) {
  return { run_id: report.run_id, environment: { ok: false, reason: `the run could not be sealed: ${reason}`.slice(0, 500) } };
}

export function bundleOf(report, score, files) {
  return Buffer.from(JSON.stringify({ run_id: report.run_id, report, score, files }));
}

function modules() {
  const dir = process.env.SEAL_MODULES;
  if (!dir) throw new Error("set SEAL_MODULES to the node_modules directory holding tlock-js and sigstore");
  const require = createRequire(join(dir, "seal.cjs"));
  return { tlock: require("tlock-js"), sigstore: require("sigstore") };
}

async function seal({ t, report: reportFile, score: scoreFile, dir, out }) {
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  const score = (() => {
    try {
      return JSON.parse(readFileSync(scoreFile, "utf8"));
    } catch {
      return null;
    }
  })();
  const round = sealRound(t);
  const { tlock, sigstore } = modules();
  const ciphertext = Buffer.from(await tlock.timelockEncrypt(round, bundleOf(report, score, packFiles(dir)), tlock.mainnetClient()));
  const bundle = await sigstore.sign(ciphertext);
  const entry = bundle.verificationMaterial?.tlogEntries?.[0];
  if (!entry) throw new Error("Sigstore returned no Rekor entry");
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${report.run_id}.tlock`), ciphertext);
  writeFileSync(join(out, `${report.run_id}.sigstore.json`), `${JSON.stringify(bundle)}\n`);
  const sealed = { sha256: sha256(ciphertext), log_index: Number(entry.logIndex) };
  writeFileSync(join(out, "redacted.json"), JSON.stringify(redact(report, sealed)));
  console.log(`sealed ${report.run_id} to round ${round}: sha256 ${sealed.sha256}, Rekor index ${sealed.log_index}`);
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { t: { type: "string" }, report: { type: "string" }, score: { type: "string" }, dir: { type: "string" }, out: { type: "string" }, reason: { type: "string" } },
  });
  const runId = () => process.env.RUN_ID;
  if (command === "pack") {
    const [dir, out] = positionals;
    writeFileSync(out, lock(transitKey(process.env.BENCH_KEY, runId()), Buffer.from(JSON.stringify(packFiles(dir)))));
  } else if (command === "unpack") {
    const [file, dir] = positionals;
    unpackFiles(JSON.parse(unlock(transitKey(process.env.BENCH_KEY, runId()), readFileSync(file)).toString("utf8")), dir);
  } else if (command === "seal") {
    await seal(values);
  } else if (command === "refuse") {
    writeFileSync(values.out, JSON.stringify(refusal(JSON.parse(readFileSync(values.report, "utf8")), values.reason ?? "unknown")));
  } else {
    throw new Error("usage: seal.mjs pack|unpack|seal|refuse ...");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`seal: ${err.message}`);
    process.exit(1);
  });
}
