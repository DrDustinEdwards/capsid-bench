#!/usr/bin/env bash
# Copies the task container's claim file (scripts/bench-claim.sh) to <out>: an empty
# file when the agent has written no claim. When the container cannot be read, <out>
# is left absent and the script fails, so a missing copy is never taken for an empty one.
#
#   scripts/copy-claims.sh <out>
set -uo pipefail
out="$1"
if docker exec task sh -c 'cat /var/bench/claims.jsonl 2>/dev/null; true' > "${out}.tmp"; then
  mv "${out}.tmp" "${out}"
else
  rm -f "${out}.tmp"
  exit 1
fi
