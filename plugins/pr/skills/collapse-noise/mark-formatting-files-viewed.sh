#!/usr/bin/env bash
# Mark PR files that contain only review-noise changes as "Viewed" in the GitHub
# Files Changed tab, so reviewers focus on real changes. Two kinds of noise are
# collapsed:
#   1. Formatting/lint-fixable diffs   -> auto-fixer applied to base equals head.
#   2. Import-path-only diffs          -> base and head differ ONLY in the module
#      specifiers of import/export/require statements (e.g. paths corrected after
#      files were moved between directories). The moved files themselves are
#      matched via git rename detection.
#   3. Identifier-rename-only diffs   -> optional: with --rename old=new pairs,
#      the base with every case style of `old` replaced by `new` (camelCase,
#      PascalCase, snake_case, SCREAMING_SNAKE, kebab-case, flat, spaced words)
#      equals head, possibly combined with import-path edits.
#
# Usage:
#   mark-formatting-files-viewed.sh <owner/repo> <pr-number> "<auto-fix-cmd>" [--rename old=new ...]
#
# Examples:
#   mark-formatting-files-viewed.sh acme/web 56 "pnpm exec biome check --write ."
#   mark-formatting-files-viewed.sh foo/bar 42 "pnpm exec prettier --write ."
#   mark-formatting-files-viewed.sh foo/bar 42 "pnpm exec prettier --write ." --rename shopCart=basket --rename order=purchase
#
# Preconditions:
#   - Run from inside a local checkout of the PR's repo.
#   - Both the PR base and head commits must be fetched locally
#     (gh pr checkout NN; or git fetch origin pull/NN/head:pr-NN).
#   - jq, gh, and git on PATH.

set -euo pipefail

if [ $# -lt 3 ]; then
  sed -n '2,27p' "$0"
  exit 64
fi

REPO_FULL="$1"; PR="$2"; FIX_CMD="$3"
shift 3
RENAMES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --rename)
      [[ "${2:-}" == ?*=?* ]] || { echo "Error: --rename needs old=new, got '${2:-}'" >&2; exit 64; }
      RENAMES+=("$2"); shift 2 ;;
    *) echo "Error: unknown argument '$1'" >&2; exit 64 ;;
  esac
done
OWNER="${REPO_FULL%/*}"; REPO="${REPO_FULL#*/}"

# Blank out the module specifier in import/export/require/dynamic-import
# statements, so two versions of a file that differ ONLY in import paths compare
# equal. The quote char is preserved; only the path between quotes is replaced.
# \x27 = single quote, \x22 = double quote (kept as escapes to dodge shell
# quoting). Single-quoted perl program so bash leaves $1/$2/$3 for perl.
normalize_imports() {
  perl -pe 's/\b(from|import|require)(\s*\(?\s*)([\x27\x22])[^\x27\x22]*\3/${1}${2}${3}__IMPORT_PATH__${3}/g'
}

# Rewrite every case style of each --rename pair in stdin. Words are split on
# camelCase humps and _ - separators, so shopCart=basket also rewrites
# ShopCart, shop_cart, SHOP_CART, shop-cart, shopcart and "shop cart".
# Longer spellings are replaced first; matching is on the whole spelling, so a
# pair also rewrites it inside a longer identifier (getShopCarts).
apply_renames() {
  RENAME_PAIRS="$(printf '%s\n' "${RENAMES[@]}")" python3 -c '
import os, re, sys
def words(name):
    return [w.lower() for w in re.findall(r"[A-Z]+(?![a-z])|[A-Z]?[a-z0-9]+", name)]
def styles(ws):
    cap = [w.capitalize() for w in ws]
    return {
        "camel": ws[0] + "".join(cap[1:]),
        "pascal": "".join(cap),
        "snake": "_".join(ws),
        "upper": "_".join(ws).upper(),
        "kebab": "-".join(ws),
        "flat": "".join(ws),
        "flatcap": "".join(ws).capitalize(),
        "spaced": " ".join(ws),
        "spacedcap": " ".join(ws).capitalize(),
    }
table = {}
for line in os.environ["RENAME_PAIRS"].splitlines():
    old, new = line.split("=", 1)
    o, n = styles(words(old)), styles(words(new))
    for k in o:
        table.setdefault(o[k], n[k])
keys = sorted(table, key=len, reverse=True)
pattern = re.compile("|".join(re.escape(k) for k in keys))
sys.stdout.write(pattern.sub(lambda m: table[m.group(0)], sys.stdin.read()))
'
}

# Whitespace-only detection is gated to extensions where whitespace carries no
# semantics. Python, YAML, Makefiles, Markdown etc. stay OUT: an indentation
# change there is a behavior/content change.
WS_SAFE_EXT='ts|tsx|js|jsx|mjs|cjs|java|kt|kts|go|c|cc|cpp|h|hpp|cs|rs|php|scala|swift|sql|css|scss|less'

whitespace_only() { # $1 base-file $2 head-file
  [[ "${1##*.}" =~ ^($WS_SAFE_EXT)$ ]] || return 1
  diff -qwB "$1" "$2" >/dev/null 2>&1
}

# JSON: identical after jq -S (key order + layout are presentation, JSON has no
# comments). YAML: identical parsed data AND identical comment lines — parsing
# drops comments, and a comment-only change is written for reviewers, so data
# equality alone must NOT collapse it. The comment extraction is naive ('#' in
# a string reads as a comment) — that only ever fails toward NOT marking.
HAVE_PYYAML=0
python3 -c 'import yaml' 2>/dev/null && HAVE_PYYAML=1

canonical_equal() { # $1 base-file $2 head-file
  local ext="${1##*.}"
  case "$ext" in
    json)
      local a b
      a=$(jq -S . "$1" 2>/dev/null) || return 1
      b=$(jq -S . "$2" 2>/dev/null) || return 1
      [ "$a" = "$b" ]
      ;;
    yaml|yml)
      [ "$HAVE_PYYAML" = 1 ] || return 1
      local ca cb
      ca=$(grep -o '#.*' "$1" | sort) ; cb=$(grep -o '#.*' "$2" | sort)
      [ "$ca" = "$cb" ] || return 1
      python3 - "$1" "$2" <<'PY' 2>/dev/null
import json, sys, yaml
def canon(p):
    with open(p) as f:
        return json.dumps(yaml.safe_load(f), sort_keys=True)
sys.exit(0 if canon(sys.argv[1]) == canon(sys.argv[2]) else 1)
PY
      ;;
    *) return 1 ;;
  esac
}

echo "Fetching PR metadata..."
META=$(gh api graphql -f query="{ repository(owner:\"$OWNER\",name:\"$REPO\") { pullRequest(number:$PR) { id baseRefOid headRefOid files(first:100) { totalCount nodes { path } pageInfo { hasNextPage endCursor } } } } }")
PR_ID=$(jq -r '.data.repository.pullRequest.id' <<<"$META")
BASE=$(jq -r '.data.repository.pullRequest.baseRefOid' <<<"$META")
HEAD_OID=$(jq -r '.data.repository.pullRequest.headRefOid' <<<"$META")
TOTAL=$(jq -r '.data.repository.pullRequest.files.totalCount' <<<"$META")
FILES=$(jq -r '.data.repository.pullRequest.files.nodes[].path' <<<"$META")

# Follow the connection cursor — files(first:100) is a page, not the PR.
HAS_NEXT=$(jq -r '.data.repository.pullRequest.files.pageInfo.hasNextPage' <<<"$META")
CURSOR=$(jq -r '.data.repository.pullRequest.files.pageInfo.endCursor' <<<"$META")
while [ "$HAS_NEXT" = "true" ]; do
  PAGE=$(gh api graphql -f query="{ repository(owner:\"$OWNER\",name:\"$REPO\") { pullRequest(number:$PR) { files(first:100, after:\"$CURSOR\") { nodes { path } pageInfo { hasNextPage endCursor } } } } }")
  FILES+=$'\n'"$(jq -r '.data.repository.pullRequest.files.nodes[].path' <<<"$PAGE")"
  HAS_NEXT=$(jq -r '.data.repository.pullRequest.files.pageInfo.hasNextPage' <<<"$PAGE")
  CURSOR=$(jq -r '.data.repository.pullRequest.files.pageInfo.endCursor' <<<"$PAGE")
done

FETCHED=$(grep -c . <<<"$FILES" || true)
if [ "$FETCHED" -ne "$TOTAL" ]; then
  echo "Error: fetched $FETCHED file paths but the PR reports $TOTAL — refusing to classify a partial list." >&2
  exit 1
fi
echo "Fetched $FETCHED changed files."

# Worktree at base ref so we can run the auto-fixer over real files with real config.
WT=$(mktemp -d -t pr-base-XXXXXX)
trap 'git worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"' EXIT

echo "Creating worktree at base ref $BASE..."
git worktree add --detach "$WT" "$BASE" >/dev/null

echo "Running auto-fixer in worktree: $FIX_CMD"
FIX_LOG=$(mktemp)
if ! ( cd "$WT" && eval "$FIX_CMD" ) >"$FIX_LOG" 2>&1; then
  # Some fixers exit nonzero legitimately (eslint --fix with unfixable errors
  # left), so a nonzero exit is a warning. Nonzero AND an untouched worktree
  # means the command likely never ran (not installed, wrong cwd, bad config) —
  # every formatting-only file would silently classify as substantive.
  echo "Warning: auto-fix command exited nonzero. Last output:" >&2
  tail -5 "$FIX_LOG" >&2
  if git -C "$WT" diff --quiet 2>/dev/null; then
    echo "Warning: and it modified nothing in the worktree — likely misconfigured or missing. Formatting-only detection will find 0 files; fix the command and re-run." >&2
  fi
fi
rm -f "$FIX_LOG"

# Map new-path -> old-path for files renamed/moved in this PR, so we can find a
# moved file's base content (which lives at its old path) for comparison.
declare -A RENAME_FROM
while IFS=$'\t' read -r _status old new; do
  [ -n "${new:-}" ] && RENAME_FROM["$new"]="$old"
done < <(git diff -M --diff-filter=R --name-status "$BASE" "$HEAD_OID")

# Files where a renamed name is stored or sent on the wire: proto and schema
# definitions, migrations, ORM entities, generated DB types. Rename-only diffs
# there stay expanded.
CONTRACT_PATHS='(\.proto|\.sql|\.prisma|\.graphql|\.entity\.[jt]s|\.avsc)$|(^|/)(migrations|schema)/'

renamed_equal() { # $1 base-file $2 head-file
  local renamed="$HEAD_TMP_DIR/renamed.${1##*.}"
  apply_renames < "$1" > "$renamed"
  cmp -s "$renamed" "$2" \
    || [ "$(normalize_imports < "$renamed")" = "$(normalize_imports < "$2")" ] \
    || whitespace_only "$renamed" "$2"
}

# With --rename, index the files the PR deletes by their renamed content, so a
# moved-and-renamed file whose git similarity is below 50% still finds its base.
declare -A DELETED_BY_RENAMED_KEY
if [ "${#RENAMES[@]}" -gt 0 ]; then
  while IFS= read -r gone; do
    [ -n "$gone" ] && [ -f "$WT/$gone" ] || continue
    key=$(apply_renames < "$WT/$gone" | normalize_imports | sha1sum)
    DELETED_BY_RENAMED_KEY["$key"]="$gone"
  done < <(git diff --no-renames --diff-filter=D --name-only "$BASE" "$HEAD_OID")
fi

# Classify each PR file
TO_MARK=()
FORMAT_ONLY=0
IMPORT_ONLY=0
WS_ONLY=0
CANON_ONLY=0
RENAME_ONLY=0
RENAME_CONTRACT=0
SKIPPED_ADDED=0
SKIPPED_SUBSTANTIVE=0

# Head content lands in a temp file (named with the real extension so the
# extension-gated checks see it) — diff and jq want files, not strings.
HEAD_TMP_DIR=$(mktemp -d -t pr-head-XXXXXX)
trap 'git worktree remove --force "$WT" >/dev/null 2>&1 || rm -rf "$WT"; rm -rf "$HEAD_TMP_DIR"' EXIT

while IFS= read -r path; do
  [ -z "$path" ] && continue

  # Locate the auto-fixed base content. For a moved file it sits at the old path.
  base_path="$path"
  if [ ! -f "$WT/$base_path" ]; then
    base_path="${RENAME_FROM[$path]:-}"
  fi
  if { [ -z "$base_path" ] || [ ! -f "$WT/$base_path" ]; } && [ "${#RENAMES[@]}" -gt 0 ]; then
    # A file rewritten by the rename is too different for git's rename
    # detection; pair it with the deleted file whose renamed content it equals.
    head_key=$(git show "$HEAD_OID:$path" 2>/dev/null | normalize_imports | sha1sum)
    base_path="${DELETED_BY_RENAMED_KEY[$head_key]:-}"
  fi
  if [ -z "$base_path" ] || [ ! -f "$WT/$base_path" ]; then
    SKIPPED_ADDED=$((SKIPPED_ADDED+1))   # genuinely added (no base version)
    continue
  fi
  head_file="$HEAD_TMP_DIR/head.${path##*.}"
  if ! git show "$HEAD_OID:$path" > "$head_file" 2>/dev/null; then
    SKIPPED_ADDED=$((SKIPPED_ADDED+1))   # file deleted in PR
    continue
  fi

  base_file="$WT/$base_path"
  if cmp -s "$base_file" "$head_file"; then
    TO_MARK+=("$path"); FORMAT_ONLY=$((FORMAT_ONLY+1))
  elif [ "$(normalize_imports < "$base_file")" = "$(normalize_imports < "$head_file")" ]; then
    # Differs only in import-statement paths (move/import-correction noise).
    TO_MARK+=("$path"); IMPORT_ONLY=$((IMPORT_ONLY+1))
  elif whitespace_only "$base_file" "$head_file"; then
    TO_MARK+=("$path"); WS_ONLY=$((WS_ONLY+1))
  elif canonical_equal "$base_file" "$head_file"; then
    TO_MARK+=("$path"); CANON_ONLY=$((CANON_ONLY+1))
  elif [ "${#RENAMES[@]}" -gt 0 ] && renamed_equal "$base_file" "$head_file"; then
    if [[ "$path" =~ $CONTRACT_PATHS ]]; then
      # A renamed column, table or wire field is a schema change, not noise.
      RENAME_CONTRACT=$((RENAME_CONTRACT+1)); SKIPPED_SUBSTANTIVE=$((SKIPPED_SUBSTANTIVE+1))
    else
      TO_MARK+=("$path"); RENAME_ONLY=$((RENAME_ONLY+1))
    fi
  else
    SKIPPED_SUBSTANTIVE=$((SKIPPED_SUBSTANTIVE+1))
  fi
done <<<"$FILES"

echo "Formatting-only:      $FORMAT_ONLY"
echo "Import-path-only:     $IMPORT_ONLY"
echo "Whitespace-only:      $WS_ONLY"
echo "Canonical JSON/YAML:  $CANON_ONLY"
if [ "${#RENAMES[@]}" -gt 0 ]; then
  echo "Identifier-rename:    $RENAME_ONLY  (pairs: ${RENAMES[*]})"
  echo "Rename, kept (schema/contract): $RENAME_CONTRACT  (counted as substantive)"
fi
echo "Substantive (review): $SKIPPED_SUBSTANTIVE"
echo "Added (skip):         $SKIPPED_ADDED"

if [ "${#TO_MARK[@]}" -eq 0 ]; then
  echo "Nothing to mark."
  exit 0
fi

# Batched GraphQL mutations with aliases (per-file loop is silently rate-limited),
# chunked at 50 aliases per request to stay well inside GitHub's per-request limits.
CHUNK=50
MUT_FILE=$(mktemp)
echo "Submitting ${#TO_MARK[@]} marks in batches of up to $CHUNK..."
for ((start=0; start<${#TO_MARK[@]}; start+=CHUNK)); do
  {
    printf 'mutation {\n'
    i=0
    for p in "${TO_MARK[@]:start:CHUNK}"; do
      i=$((i+1))
      safe=$(printf '%s' "$p" | jq -Rs .)
      printf '  m%d: markFileAsViewed(input: {pullRequestId: "%s", path: %s}) { pullRequest { id } }\n' "$i" "$PR_ID" "$safe"
    done
    printf '}\n'
  } >"$MUT_FILE"
  gh api graphql -F query=@"$MUT_FILE" >/dev/null
done
rm -f "$MUT_FILE"

# Verify — the mutation lies. It returns 200 even when rate-limited individually,
# so always read back viewerViewedState, following the same pagination.
VIEWED_COUNT=0
CURSOR=""
while :; do
  AFTER=""
  [ -n "$CURSOR" ] && AFTER=", after:\"$CURSOR\""
  PAGE=$(gh api graphql -f query="{ repository(owner:\"$OWNER\",name:\"$REPO\") { pullRequest(number:$PR) { files(first:100$AFTER) { nodes { viewerViewedState } pageInfo { hasNextPage endCursor } } } } }")
  VIEWED_COUNT=$((VIEWED_COUNT + $(jq '[.data.repository.pullRequest.files.nodes[] | select(.viewerViewedState=="VIEWED")] | length' <<<"$PAGE")))
  [ "$(jq -r '.data.repository.pullRequest.files.pageInfo.hasNextPage' <<<"$PAGE")" = "true" ] || break
  CURSOR=$(jq -r '.data.repository.pullRequest.files.pageInfo.endCursor' <<<"$PAGE")
done

echo "Verified: $VIEWED_COUNT files in VIEWED state on PR #$PR (expected ${#TO_MARK[@]})."
if [ "$VIEWED_COUNT" -lt "${#TO_MARK[@]}" ]; then
  echo "Warning: fewer VIEWED than marked — some mutations were silently dropped (rate limit?). Re-run to top up." >&2
  exit 1
fi
