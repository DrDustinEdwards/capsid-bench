# CLAUDE.md - capsid-bench

The harness for the paired comparison of Claude Code with and without Capsid: frame, walk, runs, scoring, seal and analysis. `README.md` is how it works and `protocol/protocol-draft.md` is the study it implements; a change that departs from the protocol changes the protocol first. Public repo, and so are its logs.

## Rules

- Tests: keep the minimal set (a few browser tests for flows that must never break, one integration test per real behaviour, unit tests only for tricky logic, shared code tested once where it lives), and remove any test that pins design, repeats coverage or has never caught a real mistake, unless it guards a harm that cannot be undone.
- No model run (`bench-run`, the walk's second reader) without Dustin's explicit yes. Never print a claim, a hidden test result or a secret in a log.
- Never edit `frame/` (the walk refuses a frame whose hash changed), the `walk` or `sealed` branches, or a sealed run.

## Commands

- `node --test test/` and `python3 -m unittest discover -s test -p 'test_*.py'`: what CI's test job runs.
- `npm ci --ignore-scripts --prefix tools`: the seal and drand dependencies, from `tools/package-lock.json`.
