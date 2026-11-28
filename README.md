# capsid-bench

The paired comparison for the Capsid methods paper: Claude Code used well, against the same model working through [Capsid](https://github.com/DrDustinEdwards/capsid)'s method, on the same tasks, scored on hidden tests. The primary outcome is the **false success claim**: a run that says it is done while the hidden tests fail.

The study design is `capsid/research/design-paired-comparison.md` in Capsid, written for the retired job-queue treatment.

## Status: parked

The run harness is parked. Dustin ruled on 2026-11-28 that Capsid's job queue retires, and the treatment arm, the run's claim, the scorer and the seal's posting all went through it (`capsid_work_jobs` and Capsid's `/bench/*` endpoints). The workflows and scripts that called it are removed: the run workflow, the claim tool, the reproduction check, the egress proxy, the scorer, the report builder, the verifier message and the saved-run replays (review and mutants). No run was made with them. The paired study is to be redesigned around project threads and handoffs before any run, and the protocol changes first (`protocol/protocol-draft.md`, its status section).

What the repository still does is the study's data side: the task files, the frame, the walk that draws and audits the accepted set, the hashed analysis, and the seal's time-lock and its opening.

## Setup

- Secrets: `BENCH_KEY` (the seal's own key for locking files between jobs), `SECOND_READER_KEY` for the walk's second reader. Variables: `SEAL_T`, `SECOND_READER_URL`, `SECOND_READER_MODEL`.
- No model run without Dustin's yes.

## Tasks

`tasks/<task_id>.json`, one file per task; the format is in [tasks/README.md](tasks/README.md). `bench-load.yml` writes benchmark tasks from Hugging Face onto a branch for a pull request; `scripts/task.mjs check` validates each file. `bench-candidates.yml` builds the frame (the protocol's section 4). `scripts/repos.py` lists every repository in nebius/SWE-rebench at one recorded commit, with the install recipe of its newest instance. `scripts/candidates.mjs` then checks each repository's language, license and owner on GitHub and searches its merged pull requests, keeping those that close one issue opened after the cutoff, change tests and touch at most 3 other files. Both lists are uploaded as artifacts with every filter's count. It reads Hugging Face and GitHub only, and is run once, with a freeze date that a rerun keeps.

The walk (`bench-walk.yml`, `scripts/walk.mjs`) turns the frozen frame into the accepted set (protocol section 4, "Audit" and "Draw"). It is started by hand once, with the registered instant T and the registration's hash (N is fixed at 160), and refuses any frame but the hashed one. The seed is the randomness of drand quicknet's round at T, which `scripts/seed.mjs` fetches and checks (the BLS signature against quicknet's public key, and the randomness as the signature's SHA-256) and the log's first record keeps. It permutes the frame with the seed and takes candidates strictly in that order: a candidate whose repository already has 2 accepted tasks is skipped; any other is prepared (`scripts/prepare-candidate.mjs`), validated with three offline reruns a side (`scripts/validate.py`) and leakage-screened, which also greps an archive of the repository at the base commit for the identifiers the gold patch introduces. One that passes both gates gets an author audit issue and the walk waits; once the author has answered, it goes to the second reader. The author's issue carries the second reader's packet and nothing more: the repository, the frozen issue, the hidden test names and the test patch, never the gold patch. The author answers on the issue with `in`, or `out <code>` and a quote; `bench-audit.yml` records the first valid answer from the repository owner, closes the issue and carries the walk on. The second reader is a model from a vendor other than Anthropic, called by the walk itself at temperature 0 on every candidate that passes both gates, with `prompts/second-reader.md` (the fixed list, the frozen issue, the hidden test names and the test patch; never the gold patch, and nothing of the author's decision); its endpoint, model and prompt hash are frozen in the log's start record, and every raw response is kept with its SHA-256. Because it reads after the author, no author decision is made with its response in the public log. It is set with the `SECOND_READER_URL` (an OpenAI-compatible chat endpoint) and `SECOND_READER_MODEL` variables and the `SECOND_READER_KEY` secret. A task either reader marks out is not accepted and does not count toward its repository's cap. The walk stops at N accepts or the end of the permutation. The whole record is the append-only `log.jsonl` on the `walk` branch, with the task file of every candidate that passed both gates under `instances/`. Those files hold the gold patch's SHA-256 only; the task files for the runs prepare it again from GitHub after the walk and check it against that hash.

## Analysis

`scripts/analyze.mjs` is the hashed analysis (the protocol's section 6). It labels each scored run from its claim and its two hidden test counts against the registered counts, never from Capsid's stored `false_claim` column. It holds back an error stop that ended in an outage hour, and replays each task's slots as Capsid fills them. The primary set is the tasks with 3 scored runs in each arm; a task whose start times break the order baseline, treatment, baseline, treatment, baseline, treatment is dropped from it and counted. Its estimate is the mean within-task difference, treatment minus baseline, with a seeded cluster bootstrap over repositories (10,000 resamples). It refuses a draw with more than 2 tasks from one repository, reports the number of repositories beside N with every repository at the cap, and gives the mean of within-repository means as a sensitivity. It also prints the bounds for slots with no scored run, the flagged-task sensitivity and the secondary outcomes, and names the sentence the result allows: confirmatory only with at least 120 primary-set tasks from at least 80 repositories and at most 10% non-marking responses over every candidate the second reader read (`--audit`, the walk's log); the treatment is favored only when the (b) interval lies entirely below zero and the resolution interval entirely above -10 points, and nothing else favors either arm. N is fixed at 160 in the script. Until the primary set has 160 tasks or every drawn task has finished its slots, it prints run counts only and exits 3. `scripts/simulate.mjs` runs this script on seeded synthetic studies and reports the joint rule's power and type I error.

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

`export.json` is `{ "tasks": [...], "draw": [...], "runs": [...] }`, the rows of three reads of the run tables Capsid's bench endpoints kept, the format the analysis reads (a redesigned study fixes its own):

```
SELECT task_id, split, fail_to_pass_count, pass_to_pass_count FROM bench_tasks;
SELECT position, task_id FROM bench_draw;
SELECT id, task_id, arm, status, started_at, finished_at, claimed_done, fail_to_pass_passed, pass_to_pass_passed, turns, output_tokens, duration_ms, report FROM bench_runs;
```
