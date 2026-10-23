#!/bin/sh
# The treatment's reproduction tool (protocol section 2, "Prove it before done"),
# installed in the task container as /usr/local/bin/bench-repro. It names the one new
# test file that reproduces the issue, and writes nothing else:
#
#   bench-repro tests/test_issue.py
#
# The path may be relative to the current directory: it is stored relative to the
# repository root, and refused at once if no such file exists, because the check runs
# only once, at the phase break, and a wrong name then cannot be fixed.
#
# At the phase break the harness reads the latest name, applies only that file to the
# base and runs it, then runs it on the agent's diff (scripts/repro.py), and posts
# what it saw to Capsid. The agent's job is completed only when that check passed.
set -eu
case "${1:-}" in
  ""|/*|*..*) echo "usage: bench-repro <path of the new test file>" >&2; exit 2 ;;
esac
[ -f "$1" ] || { echo "bench-repro: no file $1 here ($(pwd))" >&2; exit 2; }
# The current directory's place in the repository; empty at the root, or if git cannot say.
prefix=$(git rev-parse --show-prefix 2>/dev/null || :)
path="${prefix}${1#./}"
mkdir -p /var/bench
printf '%s\n' "${path}" > /var/bench/repro
echo "named: ${path}"
