#!/usr/bin/env bash
# Replaces /testbed's git history in the task container with one commit holding the
# files the base commit tracks, as they stand on disk, with no remotes and no other
# objects. Without this the agent could read the fix in `git log` (an own task is a
# full clone) or in later commits a benchmark image still carries. Prints the new
# commit's sha, which the diff is taken against.
#
#   scripts/flatten-repo.sh
set -euo pipefail
docker exec task sh -c '
  set -e
  cd /testbed
  git ls-files -z > /tmp/bench-tracked
  rm -rf .git
  git init -q
  # Tracked files a .gitignore matches are part of the base tree too, hence -f; the
  # list holds file names, not patterns, hence --literal-pathspecs.
  git --literal-pathspecs add -f --pathspec-from-file=/tmp/bench-tracked --pathspec-file-nul
  rm -f /tmp/bench-tracked
  git -c user.name=bench -c user.email=bench@example.com commit -q --allow-empty --no-verify -m base
  git rev-parse HEAD
'
