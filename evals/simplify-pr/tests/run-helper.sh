#!/usr/bin/env bash
# Mechanical check of the helper script against every fixture, no model calls:
# build each case repo, run mark-formatting-files-viewed.sh through the gh stub,
# and assert the persisted VIEWED set equals the case's `noise` label exactly.
# Exit nonzero on any mismatch. Run this after ANY change to the helper, the
# stub, or a fixture — the promptfoo eval measures skill wording, this measures
# script correctness, and only this one is free.
#
# Usage: tests/run-helper.sh [case-id ...]     (default: every case)
set -euo pipefail

SUITE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HELPER="$SUITE_DIR/../../plugins/pr-tools/skills/simplify-pr/mark-formatting-files-viewed.sh"
WORK="$SUITE_DIR/.work-tests"
export PATH="$SUITE_DIR/bin:$PATH"

cases=("$@")
if [ ${#cases[@]} -eq 0 ]; then
  for c in "$SUITE_DIR"/cases/*/case.json; do
    cases+=("$(basename "$(dirname "$c")")")
  done
fi

fail=0
for c in "${cases[@]}"; do
  repo="$WORK/$c"
  bash "$SUITE_DIR/cases/$c/build.sh" "$repo" >/dev/null 2>&1

  export GH_STUB_STATE="$WORK/$c-state.json"
  rm -f "$GH_STUB_STATE"

  fix_cmd=$(jq -r '.fix_cmd' "$SUITE_DIR/cases/$c/case.json")
  if ! out=$(cd "$repo" && bash "$HELPER" acme/webapp 1 "$fix_cmd" 2>&1); then
    # "Nothing to mark" exits 0; a nonzero exit here is a real helper failure.
    echo "FAIL $c — helper exited nonzero:"
    echo "$out" | tail -5 | sed 's/^/    /'
    fail=1
    continue
  fi

  marked=$(jq -r '.viewed // [] | sort | @json' "$GH_STUB_STATE" 2>/dev/null || echo '[]')
  expected=$(jq -r '[.noise[]] | sort | @json' "$SUITE_DIR/cases/$c/case.json")
  dropped=$(jq '[.requests[] | select(.persisted | not)] | length' "$GH_STUB_STATE" 2>/dev/null || echo 0)

  if [ "$marked" = "$expected" ] && [ "$dropped" -eq 0 ]; then
    echo "ok   $c ($(jq length <<<"$marked") marked)"
  else
    fail=1
    echo "FAIL $c"
    echo "    expected: $expected"
    echo "    marked:   $marked (dropped=$dropped)"
  fi
done

exit $fail
