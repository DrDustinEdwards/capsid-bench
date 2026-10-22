#!/usr/bin/env bash
# Seals one run (scripts/seal.mjs) and stores the ciphertext and its Sigstore bundle on
# the public `sealed` branch, as sealed/<run>.tlock and sealed/<run>.sigstore.json. On
# success <out>/redacted.json is the report Capsid gets; on any failure the script exits
# non-zero and the caller posts a refusal, which leaves the run unjudged.
#
#   SEAL_T=... RUN_ID=... GH_TOKEN=... scripts/seal-run.sh <report> <score> <run dir> <out>
#
# Needs the job's id-token: write (Sigstore signs with the workflow's identity) and
# contents: write (the push).
set -euo pipefail
report="$1"; score="$2"; dir="$3"; out="$4"
[ -n "${SEAL_T:-}" ] || { echo "set the repo variable SEAL_T (T_seal, set at registration)" >&2; exit 1; }
npm ci --silent --ignore-scripts --prefix tools
SEAL_MODULES="${PWD}/tools/node_modules" node scripts/seal.mjs seal --t "${SEAL_T}" --report "${report}" --score "${score}" --dir "${dir}" --out "${out}"

# The push. Up to four runs score at once, so a rejected push fetches and tries again.
repo="${RUNNER_TEMP}/sealed-branch"
rm -rf "${repo}"
git init --quiet "${repo}"
auth="AUTHORIZATION: basic $(printf 'x-access-token:%s' "${GH_TOKEN}" | base64 -w0)"
g() { git -C "${repo}" -c "http.extraheader=${auth}" -c user.name="github-actions[bot]" -c user.email="41898282+github-actions[bot]@users.noreply.github.com" "$@"; }
g remote add origin "https://github.com/${GITHUB_REPOSITORY}.git"
for attempt in 1 2 3 4 5 6; do
  if g fetch --quiet --depth 1 origin sealed 2>/dev/null; then
    g checkout --quiet -B sealed FETCH_HEAD
  else
    g checkout --quiet --orphan sealed
  fi
  mkdir -p "${repo}/sealed"
  cp "${out}/${RUN_ID}.tlock" "${out}/${RUN_ID}.sigstore.json" "${repo}/sealed/"
  g add sealed
  g commit --quiet -m "Seal ${RUN_ID}"
  if g push --quiet origin HEAD:sealed; then
    echo "stored ${RUN_ID} on the sealed branch"
    exit 0
  fi
  sleep $((attempt * 5))
done
echo "could not push to the sealed branch" >&2
exit 1
