#!/usr/bin/env node
// The registered seed (protocol section 4, "Seed", decided 2026-10-21): the randomness of
// drand quicknet round R, where R is the first round at or after the registration's
// instant T. Fetches the round from drand, checks its BLS signature against quicknet's
// public key and that the randomness is the SHA-256 of the signature, and prints the
// record the walk's start keeps.
//
//   node scripts/seed.mjs --t 2026-11-01T00:00:00Z      # the registered round
//   node scripts/seed.mjs --round 1000                   # any past round, as a check
//
// Needs @noble/curves (pinned in the workflows); NOBLE_BLS names its bls12-381.js file.

import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export const QUICKNET = {
  chain_hash: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",
  public_key:
    "83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a",
  genesis_time: 1692803367,
  period: 3,
  scheme: "bls-unchained-g1-rfc9380",
};
const DST = "BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_";
const HOSTS = ["https://api.drand.sh", "https://drand.cloudflare.com"];

// R = floor((T - genesis) / period) + 1, and the time round R is produced.
export function roundAt(t) {
  const seconds = Date.parse(t) / 1000;
  if (!Number.isFinite(seconds) || !/Z$/.test(t)) throw new Error(`not a UTC instant: ${t}`);
  if (seconds < QUICKNET.genesis_time) throw new Error("T is before quicknet's genesis");
  return Math.floor((seconds - QUICKNET.genesis_time) / QUICKNET.period) + 1;
}
export const roundTime = (round) => QUICKNET.genesis_time + (round - 1) * QUICKNET.period;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest();

// The 8-byte big-endian round number; quicknet signs its SHA-256.
export function roundMessage(round) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(round));
  return sha256(bytes);
}

export function verifyBeacon(beacon, round, bls, publicKey = QUICKNET.public_key) {
  if (beacon.round !== round) throw new Error(`drand returned round ${beacon.round}, not ${round}`);
  const signature = Uint8Array.from(Buffer.from(beacon.signature, "hex"));
  if (sha256(signature).toString("hex") !== beacon.randomness) throw new Error("the randomness is not the SHA-256 of the signature");
  const sigs = bls.shortSignatures;
  const ok = sigs.verify(signature, sigs.hash(Uint8Array.from(roundMessage(round)), DST), Uint8Array.from(Buffer.from(publicKey, "hex")));
  if (!ok) throw new Error(`round ${round}'s signature does not verify against the quicknet public key`);
}

async function fetchJson(path) {
  let last;
  for (const host of HOSTS) {
    try {
      const response = await fetch(`${host}/${QUICKNET.chain_hash}${path}`);
      if (response.ok) return await response.json();
      last = new Error(`${host}${path} answered ${response.status}`);
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

async function main() {
  const { values } = parseArgs({ options: { t: { type: "string" }, round: { type: "string" } } });
  const round = values.t ? roundAt(values.t) : Number(values.round);
  if (!Number.isInteger(round) || round < 1) throw new Error("give --t <UTC instant> or --round <n>");
  if (roundTime(round) > Date.now() / 1000) throw new Error(`round ${round} is not out until ${new Date(roundTime(round) * 1000).toISOString()}`);
  const info = await fetchJson("/info");
  for (const key of ["public_key", "genesis_time", "period", "scheme"]) {
    const theirs = key === "scheme" ? info.schemeID : info[key];
    if (theirs !== QUICKNET[key]) throw new Error(`drand's ${key} is not quicknet's`);
  }
  const { bls12_381: bls } = await import(process.env.NOBLE_BLS ? pathToFileURL(process.env.NOBLE_BLS).href : "@noble/curves/bls12-381.js");
  const beacon = await fetchJson(`/public/${round}`);
  verifyBeacon(beacon, round, bls);
  console.log(JSON.stringify({ t: values.t ?? null, round, round_time: new Date(roundTime(round) * 1000).toISOString(), chain_hash: QUICKNET.chain_hash, signature: beacon.signature, randomness: beacon.randomness }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
