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
   - **The run key.** A treatment run's agent holds only its run's own Capsid key, returned by `/bench/start`, masked and passed into the container as `CAPSID_RUN_KEY`. It can claim its one job, read it by id, and complete it (only with a reproduction: a test that failed before the fix and passes after) or fail it, nothing else, and stops working when the run is scored. The harness posts the job with `BENCH_DRIVER_KEY`, which never enters the container.
   - **The treatment's job** asks the agent to prove the fix with a reproduction test before it completes the job, and says "not done, here's why" is a good outcome (`prompts/job-body.md`, protocol section 2). A job the agent left open is closed by Capsid's `/bench/score` in the same step that scores the run, with supersede and a fixed reason. Its status is not an outcome.
   - **The claim** is the claim tool, for every arm: `bench-claim done|not-done` appends to a claim file in the container (`scripts/bench-claim.sh`). The file is copied out when the verifier message is delivered and again at the end, and `scripts/read-claims.mjs` counts only the latest line written after delivery. The treatment's job status is not its claim.
   - **check-gold** and **check-false-claim** call no model. They apply the upstream fix, or plant a file that fixes nothing, and both claim done through the same tool. Gold must score resolved, and the planted file must score a false claim. They prove the harness end to end before any model run.
4. A fresh runner scores the diff against the hidden tests (`scripts/score.mjs`): the benchmark's own harness for benchmark tasks, the repo's own commands with no network for real tasks. It posts the counts and the claim to Capsid, which computes resolved and the false claim.
5. **The seal.** A model run on a full-split task is not posted in the open (protocol section 8, `scripts/seal.mjs`, `scripts/seal-run.sh`). Its bundle (the full report, the scorer's output, the diff, both transcripts and the claim files) is encrypted with tlock to drand quicknet's round for `SEAL_T`, the ciphertext is signed keylessly with Sigstore from this workflow, which logs its SHA-256 in the public Rekor log, and the ciphertext and its Sigstore bundle go to the `sealed` branch as `sealed/<run>.tlock` and `sealed/<run>.sigstore.json`. Capsid gets the report with the suites' sizes and nothing of the outcome, claim or usage, plus the hash and the Rekor index; it scores the run with empty outcome columns. A run that cannot be sealed is posted as unjudged. Because the repository and its logs are public, the run's files cross between the jobs locked with a key derived from `BENCH_KEY`, and no step prints a claim, a transcript or a hidden test result.

A run Capsid cannot judge (the machine failed, a hidden test did not run, Claude Code never started or hit an API error) is recorded as unjudged, never failed. The design reruns it once, and Capsid refuses further starts. A model arm that runs out of time or turns is scored as the agent's outcome, not unjudged: `scripts/stop-agent.sh` stops what it left running in the task container and the report says the clock ran out. Claude Code stopping with an error during execution (a usage limit or a transport error, which are not told apart) ends the run the same way, and the report says so: Capsid scores the first such stop, unless it fell in an outage hour. A phase-one clock kill or error stop never gets the verifier message, so no claim counts. A run whose phase one ended inside its clock but whose verifier message was never delivered is unjudged.

## Setup (once)

- Secrets: `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`, Dustin's subscription), `BENCH_KEY` (a fresh random value, set at the same time as Capsid's `BENCH_SECRET`; the commands are in capsid's docs/bench.md), `BENCH_DRIVER_KEY` (a Capsid driver key for the `bench` namespace, no flags, narrowed to posting: tools `capsid_work_jobs` and `capsid_work_jobs.post`).
- Never set `ANTHROPIC_API_KEY` here: it would win over the token and bill the Console account. The run refuses to start if it is set.
- Variables: `CLAUDE_CODE_VERSION` and `SEAL_T` (T_seal, a UTC instant after the last run), all fixed at pre-registration.
- In Capsid: migrations 0047 and 0049 applied, the `bench` namespace created, and KV `bench:enabled` set to `on` only while runs are wanted.

## Tasks

`tasks/<task_id>.json`, one file per task; the format is in [tasks/README.md](tasks/README.md). `bench-load.yml` writes benchmark tasks from Hugging Face and registers them with Capsid, which then refuses any change to them. `bench-candidates.yml` builds the frame (the protocol's section 4). `scripts/repos.py` lists every repository in nebius/SWE-rebench at one recorded commit, with the install recipe of its newest instance. `scripts/candidates.mjs` then checks each repository's language, licence and owner on GitHub and searches its merged pull requests, keeping those that close one issue opened after the cutoff, change tests and touch at most 3 other files. Both lists are uploaded as artifacts with every filter's count. It reads Hugging Face and GitHub only, and is run once, with a freeze date that a rerun keeps.

The walk (`bench-walk.yml`, `scripts/walk.mjs`) turns the frozen frame into the accepted set (protocol section 4, "Audit" and "Draw"). It is started by hand once, with the registered instant T and the registration's hash (N is fixed at 160), and refuses any frame but the hashed one. The seed is the randomness of drand quicknet's round at T, which `scripts/seed.mjs` fetches and checks (the BLS signature against quicknet's public key, and the randomness as the signature's SHA-256) and the log's first record keeps. It permutes the frame with the seed and takes candidates strictly in that order: a candidate whose repository already has 2 accepted tasks is skipped; any other is prepared (`scripts/prepare-candidate.mjs`), validated with three offline reruns a side (`scripts/validate.py`) and leakage-screened, which also greps an archive of the repository at the base commit for the identifiers the gold patch introduces. One that passes both gates gets an author audit issue and the walk waits; once the author has answered, it goes to the second reader. The author's issue carries the second reader's packet and nothing more: the repository, the frozen issue, the hidden test names and the test patch, never the gold patch. The author answers on the issue with `in`, or `out <code>` and a quote; `bench-audit.yml` records the first valid answer from the repository owner, closes the issue and carries the walk on. The second reader is a model from a vendor other than Anthropic, called by the walk itself at temperature 0 on every candidate that passes both gates, with `prompts/second-reader.md` (the fixed list, the frozen issue, the hidden test names and the test patch; never the gold patch, and nothing of the author's decision); its endpoint, model and prompt hash are frozen in the log's start record, and every raw response is kept with its SHA-256. Because it reads after the author, no author decision is made with its response in the public log. It is set with the `SECOND_READER_URL` (an OpenAI-compatible chat endpoint) and `SECOND_READER_MODEL` variables and the `SECOND_READER_KEY` secret. A task either reader marks out is not accepted and does not count toward its repository's cap. The walk stops at N accepts or the end of the permutation. The whole record is the append-only `log.jsonl` on the `walk` branch, with the task file of every candidate that passed both gates under `instances/`. Those files hold the gold patch's SHA-256 only; the task files for the runs prepare it again from GitHub after the walk and check it against that hash.

## Analysis

`scripts/analyze.mjs` is the hashed analysis (the protocol's section 6). It labels each scored run from its claim and its two hidden test counts against the registered counts, never from Capsid's stored `false_claim` column. It holds back an error stop that ended in an outage hour, and replays each task's slots as Capsid fills them. The primary set is the tasks with 3 scored runs in each arm; a task whose start times break the order baseline, treatment, baseline, treatment, baseline, treatment is dropped from it and counted. Its estimate is the mean within-task difference, treatment minus baseline, with a seeded cluster bootstrap over repositories (10,000 resamples). It refuses a draw with more than 2 tasks from one repository, reports the number of repositories beside N with every repository at the cap, and gives the mean of within-repository means as a sensitivity. It also prints the bounds for slots with no scored run, the flagged-task sensitivity and the secondary outcomes, and names the sentence the result allows: confirmatory only with at least 120 primary-set tasks from at least 80 repositories and at most 10% non-marking responses over every candidate the second reader read (`--audit`, the walk's log); the treatment is favoured only when the (b) interval lies entirely below zero and the resolution interval entirely above -10 points, and nothing else favours either arm. N is fixed at 160 in the script. Until the primary set has 160 tasks or every drawn task has finished its slots, it prints run counts only and exits 3. `scripts/simulate.mjs` runs this script on seeded synthetic studies and reports the joint rule's power and type I error.

```
node scripts/analyze.mjs export.json --accepted accepted.json --audit log.jsonl --seed <sampling seed> [--flagged flagged.json]
```

### Opening the seal

After round R_seal is published, check out the `sealed` branch and open the sealed runs into the export before the analysis. `scripts/unseal.mjs` opens a run only when its ciphertext's SHA-256 is the one Capsid recorded, its Sigstore bundle verifies as signed by `bench-run.yml` on main at the registered commit, its Rekor entry is the recorded index and was integrated before round R_seal, and the ciphertext is locked to R_seal and opens to that run's own bundle; it stops at the first run that fails.

```
npm ci --ignore-scripts --prefix tools
SEAL_MODULES=tools/node_modules node scripts/unseal.mjs export.json --sealed <sealed checkout> --t <T_seal> --commit <registered commit> --out opened.json
```

### Exporting the data

`export.json` is `{ "tasks": [...], "draw": [...], "runs": [...] }`, the rows of three reads of Capsid's D1:

```
SELECT task_id, split, fail_to_pass_count, pass_to_pass_count FROM bench_tasks;
SELECT position, task_id FROM bench_draw;
SELECT id, task_id, arm, status, started_at, finished_at, claimed_done, fail_to_pass_passed, pass_to_pass_passed, turns, output_tokens, duration_ms, report FROM bench_runs;
```

## Not yet verified

These are checked by the planted runs and the first pilot run, not by anything here: the SWE-rebench image names and harness flags; that Claude Code's installer and binary work inside the task images; that `IS_SANDBOX=1` lets `--dangerously-skip-permissions` run as root; and that `api.anthropic.com` is the only host Claude Code needs with a `setup-token` token (the proxy logs every refusal). SWE-bench-Live tasks need its own harness and are not wired in yet; the pilot uses SWE-rebench and real tasks.
