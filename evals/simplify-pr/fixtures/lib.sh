# Shared plumbing for case build scripts. Source it, then author files and
# call `commit`. Dates and identity are pinned so a rebuilt repo is
# byte-identical and promptfoo's cache stays valid across regenerations.
set -euo pipefail

DEST="${1:?usage: build.sh <dest-dir>}"
FIXTURES="$(cd "$(dirname "${BASH_SOURCE[1]}")/../../fixtures" && pwd)"

rm -rf "$DEST"
mkdir -p "$DEST"
cd "$DEST"

git init -q -b main
git config user.name "Eval Fixture"
git config user.email "eval@example.invalid"
git config commit.gpgsign false
export GIT_AUTHOR_DATE="2026-01-02T03:04:05Z"
export GIT_COMMITTER_DATE="2026-01-02T03:04:05Z"

mkdir -p scripts
cp "$FIXTURES/format.sh" scripts/format.sh
chmod +x scripts/format.sh

commit() {
  git add -A
  git commit -qm "$1"
}

# Called by build scripts as their last line (after the pr branch exists): a
# local bare `origin` so the checkout looks like a real PR clone — the first
# baseline's control arm rewrote history and then stalled on "no remote".
add_origin() {
  git init -q --bare "$DEST/.origin.git"
  git remote add origin "$DEST/.origin.git"
  git push -q origin main pr
}
