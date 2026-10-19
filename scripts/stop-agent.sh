#!/usr/bin/env bash
# Stops everything the agent left running in the task container after `timeout` killed
# the docker exec client, which does not stop the process inside: Claude Code and any
# test or build it started would keep editing /testbed while the diff is taken. Kills
# every process but the container's init (`sleep infinity`, pid 1) and this shell, and
# records that the clock ran out, so the run is scored as the agent's outcome.
#
#   scripts/stop-agent.sh <timeout exit code> <marker file>
set -uo pipefail
code="$1"
marker="$2"
[ "${code}" = 124 ] || exit 0
echo "true" > "${marker}"
docker exec task sh -c 'for p in /proc/[0-9]*; do n=${p#/proc/}; [ "$n" = 1 ] || [ "$n" = "$$" ] || kill -9 "$n" 2>/dev/null; done' || true
echo "the agent ran out of time; its processes in the task container were stopped"
