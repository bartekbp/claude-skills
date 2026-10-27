---
name: collapse-noise
description: Use whenever a PR carries mechanical review noise alongside the real change — a mass formatter/linter pass (often hundreds of files), import-path-only edits from moving files between directories, or a concept rename carried through many files (shopCartId -> basketId). Reviewers always want a clean diff, so apply this proactively after opening a PR or before requesting review on any such PR. Marks the noise-only files as "Viewed" via the GitHub GraphQL API so they collapse by default, leaving only the substantive files expanded in the Files Changed tab.
context: fork
agent: general-purpose
background: true
---

# Collapse PR Noise

## Overview

**GitHub only.** This relies on GitHub's per-file "Viewed" state and the `markFileAsViewed` GraphQL mutation. GitLab, Bitbucket, and other forges have no equivalent per-reviewer collapse, so the skill does not apply there.

After a formatter or linter auto-fix pass (any `--write` / `--fix`-style run) — or after moving files between directories and letting the editor rewrite every import path — a PR's Files Changed tab is dominated by trivial diffs (trailing commas, quote normalization, `import type`, optional chaining, `../old/dir` → `../new/dir`, etc.). Reviewers waste time clicking through them.

GitHub's **per-file "Viewed" state** collapses a file by default in the diff view. It is set per reviewer via the `markFileAsViewed` GraphQL mutation. Marking the noise-only files for yourself (or someone else with their token) leaves only the substantive files expanded.

Five classes of noise are collapsed, each proven deterministically:
1. **Formatting / lint-fixable** — the auto-fixer applied to the base version reproduces the head version.
2. **Import-path-only** — the base and head differ *only* in the module specifiers of `import` / `export … from` / `require` / dynamic `import()` statements. This is the signature of moving files between directories: the moved files (matched via git rename detection) and every file that imported them get path-only edits.
3. **Whitespace-only** — base and head are identical under `diff -wB`, gated to extensions where whitespace carries no semantics (JS/TS, Java, Go, C-family, CSS, SQL, …). Python, YAML, Makefiles and Markdown are excluded: an indentation change there is a real change.
4. **Canonical JSON/YAML** — same parsed data, different key order or layout. JSON via `jq -S` equality. YAML additionally requires the comment lines to be unchanged — parsing drops comments, and a comment-only edit is written *for* reviewers, so it must stay expanded.
5. **Identifier-rename-only** — with `--rename old=new` pairs, the base with every case style of `old` rewritten to `new` equals head (alone, or with import-path or whitespace edits on top). Files that define stored or wire names stay expanded.

## Execution Context

This skill runs as a background fork (`context: fork`) — already isolated from the main
conversation, costing it no context. Execute the whole workflow yourself, directly; do not
dispatch a further subagent. The work is mechanical: fetch PR metadata, run the helper against
the checkout, read back the verification, report what was collapsed and why.

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

## Detecting "Only a Concept Was Renamed" Files

A PR that renames a concept (`shopCart` → `basket`, `order` → `purchase`) touches many files whose only change is that rename: `shopCartId` → `basketId`, `ShopCartStatus` → `BasketStatus`, `shop_cart_id` → `basket_id`, "order" → "purchase" in a comment. Neither the formatter nor the import blank catches them.

**Find the pairs yourself before running the helper**, from the PR's own diff:
- renamed files name them (`shopcart.entity.ts` → `basket.entity.ts`, `order-ledger.ts` → `purchase-ledger.ts`);
- the most frequent removed identifiers and their added counterparts confirm them: `git diff BASE HEAD -U0 | grep -E '^[-+][^-+]' | grep -oE '[A-Za-z_]+' | sort | uniq -c | sort -rn | head -50`;
- the PR description or title often says it ("rename shop cart to basket").

Give each pair once in any case style; the helper rewrites every style: camelCase, PascalCase, snake_case, SCREAMING_SNAKE, kebab-case, flat lower (`shopcart`), flat capitalized (`Shopcart`) and spaced words ("shop cart"). An odd spelling the word split does not derive (here `Shopcart` as a class name split as one word) can be passed as its own pair. Pass only pairs you saw the PR apply consistently, and list them in the report.

The rename is applied to the base, then compared with head, so a file with the rename **and** anything else stays expanded. A moved file whose rename rewrote most of its lines falls below git's 50% rename similarity; the helper pairs it with the deleted file whose renamed content it equals.

**Schema and contract files stay expanded** even when the rename is all that changed: `.proto`, `.sql`, `.prisma`, `.graphql`, `.avsc`, `*.entity.ts`, and anything under `migrations/` or `schema/`. Renaming a column, table or wire field there is a schema change a reviewer must see. The helper reports how many it kept.

## Generated Files: Judgment, Not Proof

The helper only collapses what it can prove. Generated artifacts — codegen output, lockfiles, snapshots, built bundles — are usually obvious to you but not byte-provable without re-running their generator. Recognize them by their markers: an `@generated` or `DO NOT EDIT` header, generator banners ("Code generated by protoc-gen-go"), conventional paths (`*_pb2.py`, `*.pb.go`, `__snapshots__/`, `dist/`, `vendor/`), or a lockfile changing alongside its manifest (`package-lock.json` next to a `package.json` dep bump).

Two moves, by durability:

- **Recurring generated paths** don't belong in this skill at all — tell the user to mark them `linguist-generated=true` in `.gitattributes`. GitHub then collapses them for *every* reviewer on *every* PR, no script, no per-viewer state.
- **A one-off** (regenerated snapshots riding along in this PR) you may mark viewed on judgment — but say so explicitly in your report ("also collapsed 12 files under `__snapshots__/` as generated — judgment call, not proven"), so the reviewer knows which collapses carry proof and which carry your opinion.

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
# 1. Get PR node ID and file paths (first page; the helper follows endCursor past 100)
gh api graphql -f query='{ repository(owner:"OWNER",name:"REPO") { pullRequest(number:NN) { id files(first:100) { nodes { path } pageInfo { hasNextPage endCursor } } } } }'

# 2. Run the helper. It paginates the full file list (refusing to run on a
#    partial fetch), then per file: (a) auto-fixes the base and compares to head
#    (formatting-only), (b) falls back to blanking import paths and comparing
#    (import-path-only, incl. moved files via rename detection). Marks go up in
#    aliased batches of 50, and the paginated read-back must confirm every mark
#    or the helper exits nonzero. It reports counts for each class so you can
#    sanity-check.
#    Pass the project's own formatter/linter auto-fix command as the 3rd arg.
./mark-formatting-files-viewed.sh OWNER/REPO PR_NUMBER "<auto-fix-command>"  # e.g. "npx prettier --write ." or "pnpm exec biome check --write ."
#    For a concept rename, add one --rename per pair you found:
./mark-formatting-files-viewed.sh OWNER/REPO PR_NUMBER "<auto-fix-command>" --rename shopCart=basket --rename order=purchase

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
| Collapsed a whitespace change in Python/YAML/Makefile | Whitespace is semantic there. The helper's whitespace check is extension-gated to languages where it isn't; don't hand-mark whitespace diffs outside that list. |
| Collapsed a YAML file where only a comment changed | Comments are for reviewers — a comment edit is content. The helper requires comment lines to match before treating a YAML diff as canonical-only. |
| Auto-fix command broken (not installed, wrong cwd) and everything classified substantive | The helper warns when the fixer exits nonzero, and warns louder when it also modified nothing in the worktree. Heed the warning — "Formatting-only: 0" on a formatter sweep means the fixer never ran. |
| Moved file's diff classified as substantive | The moved file's base lives at its OLD path — the helper resolves it via `git diff -M` rename detection. If renames aren't detected (heavily rewritten file), it's correctly left expanded. |
| Treated a real import retarget as move noise | Blanking the specifier can't tell `./a`→`./b` (move) from `./a`→`./differentImpl` (behavior change). Spot-check PRs that mix both. |
| Expected Go import-path moves to collapse | The blank only covers JS/TS `import`/`export … from`/`require`/`import()`. Review Go moves manually. |
| Concept-rename PR and every file classified substantive | Pass the rename pairs with `--rename old=new`; the helper does not guess them |
| Passed a pair the PR did not apply everywhere (a word that also means something else) | A wrong pair only fails toward expanded unless head really says the new word; still pass only pairs the diff shows applied consistently |
| Expected a renamed `.proto` field or entity column to collapse | Kept on purpose: a renamed stored or wire name is a schema change |
| Trusted one `files(first:100)` page on a big PR | `first:100` is a page, not the PR — the first page can be all-noise alphabetically, so a non-paginating client classifies a partial list while *looking* healthy. The helper follows `pageInfo.endCursor` for the fetch and the verify, and refuses to classify when fetched ≠ `totalCount`. |

## Verification

The mutation responds with the PR ID whether or not the state actually persists. Always read back `viewerViewedState` for the marked files and confirm the count matches expectations before assuming the work is done.
