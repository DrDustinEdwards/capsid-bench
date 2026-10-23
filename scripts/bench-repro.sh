#!/bin/sh
# The treatment's reproduction tool (protocol section 2, "Prove it before done"),
# installed in the task container as /usr/local/bin/bench-repro. It names the one new
# test file that reproduces the issue, and writes nothing else:
#
#   bench-repro tests/test_issue.py
#
# At the phase break the harness reads the latest name, applies only that file to the
# base and runs it, then runs it on the agent's diff (scripts/repro.py), and posts
# what it saw to Capsid. The agent's job is completed only when that check passed.
set -eu
case "${1:-}" in
  ""|/*|*..*) echo "usage: bench-repro <repo-relative path of the new test file>" >&2; exit 2 ;;
esac
mkdir -p /var/bench
printf '%s\n' "$1" > /var/bench/repro
echo "named: $1"
