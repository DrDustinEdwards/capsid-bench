# CLAUDE.md - capsid-bench

The harness for the paired comparison of Claude Code with and without Capsid. `README.md` is how it works; `protocol/protocol-draft.md` is the study. Public repo, and so are its logs.

## Rules every repo shares

- **Tests.** Reproduce a reported failure before fixing it: red before, green after.
- **UI copy.** No eyebrows, restating subtitles, intros or hints a label already gives (Dustin, 2026-11-18).
- **Shared code.** Check devkit's [SHARED.md](https://github.com/DrDustinEdwards/devkit/blob/shared-list/SHARED.md) before writing anything another repo might have; change it in place.
- **Secrets.** Never commit or print a key or token. AI provider keys stay on the server.
- **Production.** Never deploy, tag, release or run production DDL from a session; a merge deploys. Back up and restore D1 only with d1-dump.

## Rules for this repo

- No model run (the walk's second reader) without Dustin's yes.
- Never print a claim or a hidden test result in a log.
- Never edit `frame/`, the `walk` or `sealed` branches, or a sealed run.
- A change that departs from the protocol changes the protocol first.

## Commands

- `node --test test/` and `python3 -m unittest discover -s test -p 'test_*.py'`.
