#!/bin/sh
# The claim tool both arms are given (protocol section 3), installed in the task
# container as /usr/local/bin/bench-claim. It appends one line to /bench/claims.jsonl:
#
#   bench-claim done        the issue is fixed and the registered tests pass
#   bench-claim not-done    it is not
#
# The tool stamps the line from the container clock; the model supplies nothing but
# the word. The claim that counts is read by scripts/read-claims.mjs: the latest line
# written after the verifier message was delivered, which the workflow marks by
# copying this file out at delivery, so a line's position, not its stamp, decides.
set -eu
case "${1:-}" in
  done|not-done) ;;
  *) echo "usage: bench-claim done|not-done" >&2; exit 2 ;;
esac
mkdir -p /bench
printf '{"claim":"%s","at":"%s"}\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)" >> /bench/claims.jsonl
echo "recorded: $1"
