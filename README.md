# capsid-bench

The paired comparison for the Capsid methods paper: Claude Code used well, against the same model working through [Capsid](https://github.com/DrDustinEdwards/capsid)'s method, on the same tasks, scored on hidden tests. The primary outcome is the **false success claim**: a run that says it is done while the hidden tests fail.

The study design is `capsid/research/design-paired-comparison.md` in Capsid. Capsid's side (the task list, the runs, the scoring rules) is [docs/bench.md](https://github.com/DrDustinEdwards/capsid/blob/master/docs/bench.md) in the capsid repo.

## How a run works

`bench-run.yml`, started by hand with a task id and an arm:

1. Capsid opens the run, or refuses: the switch is off, 4 runs are already going, or the task is unknown.
2. The task's image starts with its repository at `/testbed`, reduced by `scripts/flatten-repo.sh` to one commit holding the base tree, with no remotes and no later objects, so the fix is not in its history. Its only way out is an allowlist proxy (`scripts/egress-proxy.mjs`): `api.anthropic.com`, plus Capsid's host for the treatment. The benchmark datasets are public, so this is what keeps the hidden tests hidden.
3. The arm runs, with `claude-sonnet-5-5` and the Claude Code version in the `CLAUDE_CODE_VERSION` variable. The two model arms are the same apart from the Capsid job (protocol section 2):
   - Both get the system prompt `prompts/shared.md`. The treatment's system prompt adds `prompts/treatment.md`.
   - The baseline's first message is the issue (`prompts/issue.md`). The treatment's task is posted as a signed Capsid job in the `bench` namespace (`prompts/job-body.md`), its first message is the job's id, and it reaches Capsid over MCP. Both see the issue in the same external fence (`scripts/issue.mjs`).
   - Both have the same two phases, frozen in the workflow's `PHASE1_*` and `PHASE2_*` values: phase one is 80 turns and 36 minutes. Then an independent verifier runs the repository's existing tests on the diff and sends back what failed, never the new tests (`scripts/verifier-message.mjs`, `prompts/verifier.md`). Phase two is 20 turns and 9 minutes. Neither arm is told to use a subagent.
   - **The treatment's job** is closed after the run by `scripts/post-job.mjs --close`, with supersede and a fixed reason. Its status is not an outcome.
   - **The claim** is the claim tool, for every arm: `bench-claim done|not-done` appends to a claim file in the container (`scripts/bench-claim.sh`). The file is copied out when the verifier message is delivered and again at the end, and `scripts/read-claims.mjs` counts only the latest line written after delivery. The treatment's job status is not its claim.
   - **check-gold** and **check-false-claim** call no model. They apply the upstream fix, or plant a file that fixes nothing, and both claim done through the same tool. Gold must score resolved, and the planted file must score a false claim. They prove the harness end to end before any model run.
4. A fresh runner scores the diff against the hidden tests (`scripts/score.mjs`): the benchmark's own harness for benchmark tasks, the repo's own commands with no network for real tasks. It posts the counts and the claim to Capsid, which computes resolved and the false claim.

A run Capsid cannot judge (the machine failed, a hidden test did not run, Claude Code never started or hit an API error) is recorded as unjudged, never failed. The design reruns it once, and Capsid refuses further starts. A model arm that runs out of time or turns is scored as the agent's outcome, not unjudged: `scripts/stop-agent.sh` stops what it left running in the task container and the report says the clock ran out. Claude Code stopping with an error during execution (a usage limit or a transport error, which are not told apart) ends the run the same way, and the report says so: Capsid leaves a slot's first such stop unjudged and scores the second. A phase-one clock kill or error stop never gets the verifier message, so no claim counts. A run whose phase one ended inside its clock but whose verifier message was never delivered is unjudged.

## Setup (once)

- Secrets: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`, Dustin's subscription), `BENCH_KEY` (`node scripts/improve-derive-key.mjs --bench` in capsid), `BENCH_DRIVER_KEY` (a Capsid driver key for the `bench` namespace, no flags).
- Never set `ANTHROPIC_API_KEY` here: it would win over the token and bill the Console account. The run refuses to start if it is set.
- Variables: `CLAUDE_CODE_VERSION` and `SWE_HARNESS_REF` (a commit of [SWE-rebench/SWE-bench-fork](https://github.com/SWE-rebench/SWE-bench-fork)), both fixed at pre-registration.
- In Capsid: migration 0047 applied, the `bench` namespace created, and KV `bench:enabled` set to `on` only while runs are wanted.

## Tasks

`tasks/<task_id>.json`, one file per task; the format is in [tasks/README.md](tasks/README.md). `bench-load.yml` writes benchmark tasks from Hugging Face and registers them with Capsid, which then refuses any change to them.

## Not yet verified

These are checked by the planted runs and the first pilot run, not by anything here: the SWE-rebench image names and harness flags; that Claude Code's installer and binary work inside the task images; that `IS_SANDBOX=1` lets `--dangerously-skip-permissions` run as root; and that `api.anthropic.com` is the only host Claude Code needs with a `setup-token` token (the proxy logs every refusal). SWE-bench-Live tasks need its own harness and are not wired in yet; the pilot uses SWE-rebench and real tasks.
