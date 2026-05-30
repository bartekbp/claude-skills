---
name: simplify-pr
description: Use whenever a PR carries mechanical review noise alongside the real change — a mass formatter/linter pass (often hundreds of files) or import-path-only edits from moving files between directories. Reviewers always want a clean diff, so apply this proactively after opening a PR or before requesting review on any such PR. Marks the noise-only files as "Viewed" via the GitHub GraphQL API so they collapse by default, leaving only the substantive files expanded in the Files Changed tab.
---

# Simplify PR for Review

## Overview

**GitHub only.** This relies on GitHub's per-file "Viewed" state and the `markFileAsViewed` GraphQL mutation. GitLab, Bitbucket, and other forges have no equivalent per-reviewer collapse, so the skill does not apply there.

After a formatter or linter auto-fix pass (any `--write` / `--fix`-style run) — or after moving files between directories and letting the editor rewrite every import path — a PR's Files Changed tab is dominated by trivial diffs (trailing commas, quote normalization, `import type`, optional chaining, `../old/dir` → `../new/dir`, etc.). Reviewers waste time clicking through them.

GitHub's **per-file "Viewed" state** collapses a file by default in the diff view. It is set per reviewer via the `markFileAsViewed` GraphQL mutation. Marking the noise-only files for yourself (or someone else with their token) leaves only the substantive files expanded.

Two classes of noise are collapsed:
1. **Formatting / lint-fixable** — the auto-fixer applied to the base version reproduces the head version.
2. **Import-path-only** — the base and head differ *only* in the module specifiers of `import` / `export … from` / `require` / dynamic `import()` statements. This is the signature of moving files between directories: the moved files (matched via git rename detection) and every file that imported them get path-only edits.

## When to Use

Reviewers always want a clean diff, so reach for this on any PR that carries mechanical noise — don't wait to be asked.

- PR includes a sweeping formatter or linter pass touching many files
- PR moves files between directories, leaving a long tail of import-path-only diffs
- You can identify the noise deterministically — auto-fix-only diffs by re-running the formatter/linter, import-path-only diffs by blanking module specifiers and comparing

**Don't use when:**
- The PR is small (manual triage is faster)
- The repo lacks a deterministic auto-fixer (you can't prove a diff is "linter-only")
- You're trying to hide changes from review (this collapses, it doesn't conceal — `?file-filters[]=` URL state can re-expand)

## How "Viewed" Works (Important Constraints)

| Property | Reality |
|---|---|
| Per-viewer state | Set under the auth'd user's account only. Other reviewers still see everything expanded unless they mark for themselves. |
| Set via | GraphQL mutation `markFileAsViewed { pullRequestId, path }` |
| Auth | Any token with PR read access works; the marks are scoped to that token's user. |
| Rate limit | **Per-file mutation loop gets silently throttled** — calls return success but state doesn't persist. Use one batched mutation with aliases instead. |

## Detecting "Linter-Would-Do-This" Files

Authoritative test: apply the same auto-fixer to the BASE version and compare against the HEAD version. If they match, the entire diff is reproducible by the auto-fixer → safe to collapse.

```bash
# pseudo-code per changed file
git show "$BASE_SHA:$path" > /tmp/old
cp /tmp/old /tmp/old.fixed
( cd "$(dirname /tmp/old.fixed)" && <auto-fix-command> /tmp/old.fixed )
git show "$HEAD_SHA:$path" > /tmp/new
diff -q /tmp/old.fixed /tmp/new   # exit 0 → mark viewed
```

For format-only detection, run the project's formatter in write mode (e.g. `prettier --write`, `biome format --write`, `gofmt -w`, `black`).
For "lint-fixable" detection (broader), run the linter's auto-fix (e.g. `eslint --fix`, `biome check --write`, `ruff check --fix`).

Trade-off: a lint auto-fix is broader but slower and may mutate things you don't want considered "lint-only" (e.g. import sorting, dead-code removal). Pick the narrowest tool that captures the intent — prefer the format-only command unless the PR's noise needs the broader fixer.

## Detecting "Only Import Paths Changed" Files (file moves)

A formatter will never rewrite import paths to follow a moved file, so the auto-fixer test above classifies these as substantive. They need a separate test: **blank the module specifier out of every import/export/require statement in both versions, then compare.** If they match, the only difference was the paths.

The helper does this automatically as a fallback after the auto-fix test, so a file with *both* formatting noise and path-only edits is still caught. Two pieces:

- **The moved files themselves.** Their base content lives at the *old* path. The helper builds a new-path → old-path map with `git diff -M --diff-filter=R --name-status` (rename detection) and compares against the old base.
- **The importers.** Every file that referenced a moved file gets `'../old' → '../new'` edits. Blanking the specifier collapses them.

```bash
# normalize: replace the path between the quotes with a placeholder, keep everything else
perl -pe 's/\b(from|import|require)(\s*\(?\s*)([\x27\x22])[^\x27\x22]*\3/${1}${2}${3}__IMPORT_PATH__${3}/g'
```

This is intentionally semantic, not just textual: adding/removing an import, or changing which symbols are imported, still differs after blanking (more/fewer lines, different identifiers) and is correctly left expanded. The blank covers JS/TS `import` / `export … from` / `require()` / dynamic `import()`. It does **not** cover Go imports — review those manually.

Caveat: blanking the path also collapses a genuine *retarget* of an import to a different module when that is the only change on the line (e.g. `./oldImpl` → `./newImpl` pointing at different behavior). From the diff alone this is indistinguishable from a move; if a PR mixes real retargets with move noise, spot-check before relying on the collapse.

## The Rate-Limit Trap

Per-file mutations in a loop hit a silent secondary rate limit on GitHub — calls return `200 OK` with `pullRequest.id` in the response but the viewed state is dropped. Verify by reading back `viewerViewedState` after a batch; if you see far fewer `VIEWED` than expected, this is what bit you.

**Fix:** issue one GraphQL request with aliased mutations:

```graphql
mutation {
  m1: markFileAsViewed(input: {pullRequestId: "PR_...", path: "src/foo.ts"}) { pullRequest { id } }
  m2: markFileAsViewed(input: {pullRequestId: "PR_...", path: "src/bar.ts"}) { pullRequest { id } }
  # ... up to ~50–100 per request safely
}
```

A single batched call of 55 mutations completed atomically and persisted in my test where the per-file loop persisted only 3.

## Quick Reference

```bash
# 1. Get PR node ID and file paths
gh api graphql -f query='{ repository(owner:"OWNER",name:"REPO") { pullRequest(number:NN) { id files(first:100) { nodes { path } } } } }'

# 2. Run the helper. Per file it: (a) auto-fixes the base and compares to head
#    (formatting-only), (b) falls back to blanking import paths and comparing
#    (import-path-only, incl. moved files via rename detection), then batches the
#    marks. It reports counts for each class so you can sanity-check.
#    Pass the project's own formatter/linter auto-fix command as the 3rd arg.
./mark-formatting-files-viewed.sh OWNER/REPO PR_NUMBER "<auto-fix-command>"  # e.g. "npx prettier --write ." or "pnpm exec biome check --write ."

# 3. Verify
gh api graphql -f query='{ repository(owner:"OWNER",name:"REPO") { pullRequest(number:NN) { files(first:100) { nodes { path viewerViewedState } } } } }' \
  --jq '.data.repository.pullRequest.files.nodes | group_by(.viewerViewedState) | map({state:.[0].viewerViewedState,count:length})'
```

See [mark-formatting-files-viewed.sh](mark-formatting-files-viewed.sh) for the full helper.

## Common Mistakes

| Mistake | Fix |
|---|---|
| Per-file mutation loop with no errors but few marks persist | Batch into one mutation with aliases |
| Used `git diff` to classify (misses lint-fixable changes) | Apply the auto-fixer to base and compare to head |
| Auto-fixer needs the repo's config (e.g. `.prettierrc`, `biome.json`, `.eslintrc`) and isn't on PATH | Run from the repo root, invoking the project-local binary (e.g. `pnpm exec` / `npx`) |
| Auto-fixer changes things the PR author didn't intend (e.g. import-sort) | Use the narrower format-only command, not the full lint auto-fix |
| Expected other reviewers to see files collapsed | Viewed state is per-viewer; tell them or use their token |
| File has BOTH lint-fixable noise AND a real change | Don't mark viewed — auto-fixed base won't equal head, helper script will correctly skip it |
| Moved file's diff classified as substantive | The moved file's base lives at its OLD path — the helper resolves it via `git diff -M` rename detection. If renames aren't detected (heavily rewritten file), it's correctly left expanded. |
| Treated a real import retarget as move noise | Blanking the specifier can't tell `./a`→`./b` (move) from `./a`→`./differentImpl` (behavior change). Spot-check PRs that mix both. |
| Expected Go import-path moves to collapse | The blank only covers JS/TS `import`/`export … from`/`require`/`import()`. Review Go moves manually. |
| Pagination | `files(first:100)` caps at 100. For larger PRs paginate with `endCursor`. |

## Verification

The mutation responds with the PR ID whether or not the state actually persists. Always read back `viewerViewedState` for the marked files and confirm the count matches expectations before assuming the work is done.
