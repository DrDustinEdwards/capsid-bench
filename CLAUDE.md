# CLAUDE.md - capsid-bench

The harness for the paired comparison of Claude Code with and without Capsid: frame, walk, runs, scoring, seal and analysis. `README.md` is how it works and `protocol/protocol-draft.md` is the study it implements; a change that departs from the protocol changes the protocol first. Public repo, and so are its logs.

## Rules every repo shares

- **Tests.** Reproduce a reported failure before fixing it, and report red before and green after. Keep the minimal set: a few browser tests for flows that must never break, one integration test per real behavior, unit tests only for tricky logic, shared code tested once where it lives. Remove a test that pins design, repeats coverage or never caught a mistake, unless it guards a harm that cannot be undone.
- **Shared code.** Before writing anything another site might have, check https://github.com/DrDustinEdwards/devkit/blob/shared-list/SHARED.md. Change shared code in place and delete what the change replaces in the same PR.
- **Secrets.** Never commit or print a key, token, `.dev.vars` or `.env`.

## Rules for this repo

- No model run (`bench-run`, the walk's second reader) without Dustin's explicit yes. Never print a claim or a hidden test result in a log.
- Never edit `frame/` (the walk refuses a frame whose hash changed), the `walk` or `sealed` branches, or a sealed run.

## Commands

- `node --test test/` and `python3 -m unittest discover -s test -p 'test_*.py'`: what CI's test job runs.
- `npm ci --ignore-scripts --prefix tools`: the seal and drand dependencies, from `tools/package-lock.json`.
