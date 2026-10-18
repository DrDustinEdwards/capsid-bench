# capsid-bench

The paired comparison for the Capsid methods paper: Claude Code used well, against the same model working through [Capsid](https://github.com/DrDustinEdwards/capsid)'s method, on the same tasks, scored on hidden tests. The primary outcome is the **false success claim**: a run that says it is done while the hidden tests fail.

The study design is `capsid/research/design-paired-comparison.md` in Capsid. Capsid's side (the task list, the runs, the scoring rules) is [docs/bench.md](https://github.com/DrDustinEdwards/capsid/blob/master/docs/bench.md) in the capsid repo.

## How a run works

`bench-run.yml`, started by hand with a task id and an arm:

1. Capsid opens the run, or refuses: the switch is off, 4 runs are already going, or the task is unknown.
2. The task's image starts with its repository at `/testbed`. Its only way out is an allowlist proxy (`scripts/egress-proxy.mjs`): `api.anthropic.com`, plus Capsid's host for the treatment. The benchmark datasets are public, so this is what keeps the hidden tests hidden.
3. The arm runs, with `claude-sonnet-5-5` and the Claude Code version in the `CLAUDE_CODE_VERSION` variable:
   - **baseline**: one `claude -p` with `prompts/baseline.md`: plan, run the tests, have a subagent review the diff, end with `BENCH-RESULT: DONE` or `NOT-DONE`. 100 turns, 45 minutes.
   - **treatment**: the task is posted as a signed Capsid job in the `bench` namespace (`prompts/job-body.md`). The agent claims it over MCP and works from its body (`prompts/treatment.md`, 80 turns). An independent verifier then runs the repository's existing tests on its diff and sends back what failed, never the new tests (`scripts/verifier-message.mjs`). In a second turn (20 turns) the agent fixes what it broke and ends the job with `complete` and a claim, or `fail`.
   - **check-gold** and **check-false-claim** call no model. They apply the upstream fix, or plant a file that fixes nothing, and both claim done. Gold must score resolved; the planted file must score a false claim. They prove the harness end to end before any model run.
4. A fresh runner scores the diff against the hidden tests (`scripts/score.mjs`): the benchmark's own harness for benchmark tasks, the repo's own commands with no network for real tasks. It posts the counts to Capsid, which computes resolved and the false claim, and reads the treatment's claim from its own job.

A run Capsid cannot judge (the machine failed, a hidden test did not run, Claude Code produced no result or hit an API error) is recorded as unjudged, never failed. The design reruns it once.

## Setup (once)

- Secrets: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`, Dustin's subscription), `BENCH_KEY` (`node scripts/improve-derive-key.mjs --bench` in capsid), `BENCH_DRIVER_KEY` (a Capsid driver key for the `bench` namespace, no flags).
- Never set `ANTHROPIC_API_KEY` here: it would win over the token and bill the Console account. The run refuses to start if it is set.
- Variables: `CLAUDE_CODE_VERSION` and `SWE_HARNESS_REF` (a commit of [SWE-rebench/SWE-bench-fork](https://github.com/SWE-rebench/SWE-bench-fork)), both fixed at pre-registration.
- In Capsid: migration 0047 applied, the `bench` namespace created, and KV `bench:enabled` set to `on` only while runs are wanted.

## Tasks

`tasks/<task_id>.json`, one file per task; the format is in [tasks/README.md](tasks/README.md). `bench-load.yml` writes benchmark tasks from Hugging Face and registers them with Capsid, which then refuses any change to them.

## Not yet verified

These are checked by the planted runs and the first pilot run, not by anything here: the SWE-rebench image names and harness flags; that Claude Code's installer and binary work inside the task images; that `IS_SANDBOX=1` lets `--dangerously-skip-permissions` run as root; and that `api.anthropic.com` is the only host Claude Code needs with a `setup-token` token (the proxy logs every refusal). SWE-bench-Live tasks need its own harness and are not wired in yet; the pilot uses SWE-rebench and real tasks.
