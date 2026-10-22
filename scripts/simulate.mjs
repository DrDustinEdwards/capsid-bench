#!/usr/bin/env node
// The simulation of the analysis (protocol section 6, "Simulation", decided 2026-10-22).
// It runs the hashed analysis itself, scripts/analyze.mjs, on seeded synthetic exports and
// reports how often the joint rule favours the treatment. This file and its output are
// hashed into the registration.
//
//   node scripts/simulate.mjs [--reps 1000] [--resamples 2000] [--seed capsid-bench-sim]
//
// THE SYNTHETIC STUDY. N tasks under the cap of 2: repositories with 2 tasks and with 1,
// in the share given below. Each task has its own (b) and resolution rates per arm, drawn
// around the scenario's means with an intraclass correlation of 0.10 between a task's runs.
// Each task gets 3 slots per arm. With the stated chance, a task loses one scored run (a
// slot with two unjudged attempts), so it leaves the primary set. Every second-reader
// response is "in". Nothing here is an assumption of the confirmatory analysis.

import { analyze, rng } from "./analyze.mjs";

const ICC = 0.1;
// Share of repositories that contribute 2 tasks: about 0.35 when the walk is replayed on
// the frozen frame at any acceptance rate from 5% to 30%.
const TWO_TASK_SHARE = 0.35;
const LOSS = 0.03; // chance a task loses a scored run and leaves the primary set

// A Beta draw with the given mean and ICC, as a sum of Gammas (Marsaglia and Tsang).
function gamma(shape, random) {
  if (shape < 1) return gamma(shape + 1, random) * Math.pow(random(), 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do {
      const u1 = random() || 1e-12;
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * random());
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = random();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
function beta(mean, random) {
  if (mean <= 0) return 0;
  if (mean >= 1) return 1;
  const k = (1 - ICC) / ICC;
  const a = gamma(mean * k, random);
  return a / (a + gamma((1 - mean) * k, random));
}

// One synthetic export, accepted set and audit log for a scenario.
export function synthetic(n, scenario, random) {
  const tasks = [];
  const draw = [];
  const runs = [];
  let clock = Date.parse("2027-01-01T00:00:00Z");
  let repo = 0;
  let left = 0;
  for (let i = 1; i <= n; i++) {
    if (left === 0) {
      repo++;
      left = random() < TWO_TASK_SHARE ? 2 : 1;
    }
    left--;
    const task_id = `sample__sim-${i}`;
    tasks.push({ task_id, repo: `sample/repo-${repo}`, split: "full", fail_to_pass_count: 1, pass_to_pass_count: 1 });
    draw.push({ position: i, task_id });
    const lose = random() < LOSS ? Math.floor(random() * 6) : -1;
    const rates = {};
    for (const arm of ["baseline", "treatment"]) {
      const shift = arm === "treatment" ? scenario : { b: 0, resolved: 0 };
      rates[arm] = {
        pr: beta(Math.min(0.99, Math.max(0.01, scenario.base.resolved + shift.resolved)), random),
        pb: beta(Math.min(0.99, Math.max(0.01, scenario.base.b + shift.b)), random),
      };
    }
    // The registered order: baseline, treatment, baseline, treatment, baseline, treatment.
    let slot = 0;
    for (let k = 0; k < 3; k++) {
      for (const arm of ["baseline", "treatment"]) {
        const { pr, pb } = rates[arm];
        const at = () => new Date((clock += 60 * 1000)).toISOString();
        if (slot === lose) {
          slot++;
          // Two unjudged attempts: the slot has no scored run.
          for (let t = 0; t < 2; t++) {
            const when = at();
            runs.push({ task_id, arm, status: "unjudged", started_at: when, finished_at: when, report: "{}" });
          }
          continue;
        }
        const resolved = random() < pr;
        // (b) is a share of all runs; it can only fall on an unresolved run.
        const b = !resolved && random() < Math.min(1, pb / Math.max(1e-9, 1 - pr));
        const when = at();
        runs.push({ task_id, arm, status: "scored", started_at: when, finished_at: when, claimed_done: resolved || b ? 1 : 0, fail_to_pass_passed: resolved ? 1 : 0, pass_to_pass_passed: 1, report: "{}" });
        slot++;
      }
    }
  }
  const accepted = tasks.map(({ task_id, repo }) => ({ task_id, repo }));
  const audit = accepted.map(({ task_id }) => ({ event: "audit", reader: "second", task_id, decision: "in" }));
  return { data: { tasks, draw, runs }, accepted, audit };
}

// The scenarios: (b) and resolution are shares of runs, base rates as planned (section 6).
export const SCENARIOS = {
  null: { base: { b: 0.2, resolved: 0.4 }, b: 0, resolved: 0 },
  b_minus_10: { base: { b: 0.2, resolved: 0.4 }, b: -0.1, resolved: 0 },
  b_minus_10_resolution_minus_10: { base: { b: 0.2, resolved: 0.4 }, b: -0.1, resolved: -0.1 },
  b_minus_5: { base: { b: 0.2, resolved: 0.4 }, b: -0.05, resolved: 0 },
  b_minus_10_low_resolution: { base: { b: 0.2, resolved: 0.3 }, b: -0.1, resolved: 0 },
};

export function simulate({ reps, resamples, seed, sizes = [120, 160] }) {
  const out = { reps, resamples, seed, icc: ICC, two_task_share: TWO_TASK_SHARE, loss: LOSS, results: [] };
  for (const n of sizes) {
    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      const random = rng(`${seed}:${n}:${name}`);
      let favoured = 0;
      let confirmatory = 0;
      for (let r = 0; r < reps; r++) {
        const { data, accepted, audit } = synthetic(n, scenario, random);
        const result = analyze(data, { accepted, audit, seed: `${seed}:${n}:${name}:${r}`, resamples });
        if (/treatment is favoured/.test(result.sentence)) favoured++;
        if (!/not confirmatory|Below the floor/i.test(result.sentence)) confirmatory++;
      }
      out.results.push({ n, scenario: name, favoured: favoured / reps, confirmatory: confirmatory / reps });
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const flag = (name, d) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  console.log(JSON.stringify(simulate({ reps: Number(flag("reps", 1000)), resamples: Number(flag("resamples", 2000)), seed: flag("seed", "capsid-bench-sim") }), null, 2));
}
