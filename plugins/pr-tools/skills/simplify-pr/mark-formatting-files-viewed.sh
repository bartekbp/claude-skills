#!/usr/bin/env bash
# Mark PR files that contain only review-noise changes as "Viewed" in the GitHub
# Files Changed tab, so reviewers focus on real changes. Two kinds of noise are
# collapsed:
#   1. Formatting/lint-fixable diffs   -> auto-fixer applied to base equals head.
#   2. Import-path-only diffs          -> base and head differ ONLY in the module
#      specifiers of import/export/require statements (e.g. paths corrected after
#      files were moved between directories). The moved files themselves are
#      matched via git rename detection.
#
# Usage:
#   mark-formatting-files-viewed.sh <owner/repo> <pr-number> "<auto-fix-cmd>"
#
# Examples:
#   mark-formatting-files-viewed.sh acme/web 56 "pnpm exec biome check --write ."
#   mark-formatting-files-viewed.sh foo/bar 42 "pnpm exec prettier --write ."
#
# Preconditions:
#   - Run from inside a local checkout of the PR's repo.
#   - Both the PR base and head commits must be fetched locally
#     (gh pr checkout NN; or git fetch origin pull/NN/head:pr-NN).
#   - jq, gh, and git on PATH.

set -euo pipefail

if [ $# -lt 3 ]; then
  sed -n '4,20p' "$0"
  exit 64
fi

REPO_FULL="$1"; PR="$2"; FIX_CMD="$3"
OWNER="${REPO_FULL%/*}"; REPO="${REPO_FULL#*/}"

# Blank out the module specifier in import/export/require/dynamic-import
# statements, so two versions of a file that differ ONLY in import paths compare
# equal. The quote char is preserved; only the path between quotes is replaced.
# \x27 = single quote, \x22 = double quote (kept as escapes to dodge shell
# quoting). Single-quoted perl program so bash leaves $1/$2/$3 for perl.
normalize_imports() {
  perl -pe 's/\b(from|import|require)(\s*\(?\s*)([\x27\x22])[^\x27\x22]*\3/${1}${2}${3}__IMPORT_PATH__${3}/g'
}

echo "Fetching PR metadata..."
META=$(gh api graphql -f query="{ repository(owner:\"$OWNER\",name:\"$REPO\") { pullRequest(number:$PR) { id baseRefOid headRefOid files(first:100) { totalCount nodes { path } } } } }")
PR_ID=$(jq -r '.data.repository.pullRequest.id' <<<"$META")
BASE=$(jq -r '.data.repository.pullRequest.baseRefOid' <<<"$META")
HEAD_OID=$(jq -r '.data.repository.pullRequest.headRefOid' <<<"$META")
TOTAL=$(jq -r '.data.repository.pullRequest.files.totalCount' <<<"$META")
FILES=$(jq -r '.data.repository.pullRequest.files.nodes[].path' <<<"$META")

if [ "$TOTAL" -gt 100 ]; then
  echo "Warning: PR has $TOTAL files but only the first 100 are processed. Paginate manually for the rest." >&2
fi

# Worktree at base ref so we can run the auto-fixer over real files with real config.
WT=$(mktemp -d -t pr-base-XXXXXX)
trap 'git worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"' EXIT

echo "Creating worktree at base ref $BASE..."
git worktree add --detach "$WT" "$BASE" >/dev/null

echo "Running auto-fixer in worktree: $FIX_CMD"
( cd "$WT" && eval "$FIX_CMD" ) >/dev/null 2>&1 || true

# Map new-path -> old-path for files renamed/moved in this PR, so we can find a
# moved file's base content (which lives at its old path) for comparison.
declare -A RENAME_FROM
while IFS=$'\t' read -r _status old new; do
  [ -n "${new:-}" ] && RENAME_FROM["$new"]="$old"
done < <(git diff -M --diff-filter=R --name-status "$BASE" "$HEAD_OID")

# Classify each PR file
TO_MARK=()
FORMAT_ONLY=0
IMPORT_ONLY=0
SKIPPED_ADDED=0
SKIPPED_SUBSTANTIVE=0

while IFS= read -r path; do
  [ -z "$path" ] && continue

  # Locate the auto-fixed base content. For a moved file it sits at the old path.
  base_path="$path"
  if [ ! -f "$WT/$base_path" ]; then
    base_path="${RENAME_FROM[$path]:-}"
  fi
  if [ -z "$base_path" ] || [ ! -f "$WT/$base_path" ]; then
    SKIPPED_ADDED=$((SKIPPED_ADDED+1))   # genuinely added (no base version)
    continue
  fi
  if ! head_content=$(git show "$HEAD_OID:$path" 2>/dev/null); then
    SKIPPED_ADDED=$((SKIPPED_ADDED+1))   # file deleted in PR
    continue
  fi

  base_fixed=$(cat "$WT/$base_path")
  if [ "$base_fixed" = "$head_content" ]; then
    TO_MARK+=("$path"); FORMAT_ONLY=$((FORMAT_ONLY+1))
  elif [ "$(printf '%s' "$base_fixed" | normalize_imports)" = "$(printf '%s' "$head_content" | normalize_imports)" ]; then
    # Differs only in import-statement paths (move/import-correction noise).
    TO_MARK+=("$path"); IMPORT_ONLY=$((IMPORT_ONLY+1))
  else
    SKIPPED_SUBSTANTIVE=$((SKIPPED_SUBSTANTIVE+1))
  fi
done <<<"$FILES"

echo "Formatting-only:      $FORMAT_ONLY"
echo "Import-path-only:     $IMPORT_ONLY"
echo "Substantive (review): $SKIPPED_SUBSTANTIVE"
echo "Added (skip):         $SKIPPED_ADDED"

if [ "${#TO_MARK[@]}" -eq 0 ]; then
  echo "Nothing to mark."
  exit 0
fi

# Build one batched GraphQL mutation with aliases (per-file loop is silently rate-limited).
MUT_FILE=$(mktemp)
{
  printf 'mutation {\n'
  i=0
  for p in "${TO_MARK[@]}"; do
    i=$((i+1))
    safe=$(printf '%s' "$p" | jq -Rs .)
    printf '  m%d: markFileAsViewed(input: {pullRequestId: "%s", path: %s}) { pullRequest { id } }\n' "$i" "$PR_ID" "$safe"
  done
  printf '}\n'
} >"$MUT_FILE"

echo "Submitting batched mutation (${#TO_MARK[@]} files)..."
gh api graphql -F query=@"$MUT_FILE" >/dev/null

# Verify — the mutation lies. It returns 200 even when rate-limited individually,
# so always read back viewerViewedState.
VIEWED_COUNT=$(gh api graphql -f query="{ repository(owner:\"$OWNER\",name:\"$REPO\") { pullRequest(number:$PR) { files(first:100) { nodes { viewerViewedState } } } } }" --jq '[.data.repository.pullRequest.files.nodes[] | select(.viewerViewedState=="VIEWED")] | length')

echo "Verified: $VIEWED_COUNT files in VIEWED state on PR #$PR."

rm -f "$MUT_FILE"
