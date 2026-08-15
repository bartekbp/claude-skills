# simplify-pr

Does the right set of files collapse, and only that set?

Run from this directory: `npx promptfoo@latest eval --filter-providers '^skill$' -j 4 --no-cache`.
Shared setup — credentials, isolation, one-shot discipline — is in [../README.md](../README.md).

## How it works

Every test case is a **synthetic git repo** built by `cases/<id>/build.sh` into `.work/<id>`:
branch `pr` against `main`, with a repo-local formatter (`scripts/format.sh`, standing in for
prettier) whose transforms are idempotent. Noise files are authored ugly on `main` and formatted on
`pr`, so "the auto-fixer applied to base reproduces head" holds *by construction* — the labels in
`case.json` are not judgements, they are how the repo was generated.

GitHub is a **stub**: `bin/gh` answers `gh api graphql` from the local checkout, records
`markFileAsViewed` mutations to a per-call state file, and serves `viewerViewedState` back from it.
The provider prepends `bin/` to PATH, so the agent's `gh` never leaves the machine.

**The rate-limit trap is simulated.** Per-file mutation requests silently stop persisting after 3
(they still return success), exactly like real GitHub's secondary limit; batched aliased mutations
always persist. An agent that loops per-file and never reads back scores low on `collapsed` with a
long `dropped=` tail in the reason line — the trap the skill's own section warns about, made
measurable.

The grade needs no LLM judge. The provider appends the stub's persisted state to the output as a
`<gh-stub-state>` trailer, and `asserts/check.py` compares that against the label — what the
answer's prose claims is never graded, so a run that declares success over dropped marks scores
what actually persisted.

## What is measured

| Metric | Meaning |
|---|---|
| `collapsed` | of the noise files, how many ended up VIEWED — recall of the cleanup |
| `spared` | of the substantive files, how many were left alone — the guard |

Never blended in the report: marking a real change viewed hides it from review, which is strictly
worse than doing nothing. Score is `spared` alone when a case has no noise, else the mean of both;
pass means a perfect run.

## Arms

- `skill` — SKILL.md as system prompt, plus the base-directory line the Skill tool would add (the
  helper script is resolved through it).
- `control` — same repos, same prompt, generic engineer system prompt. Prices the skill: watch
  `spared` (does a bare agent hide real changes?) and whether it walks into the throttle.

## Cases

| Case | Noise / substantive | What it isolates |
|---|---|---|
| `format-sweep` | 6 / 3 | formatter sweep; a mixed format+logic file and an added file must stay expanded |
| `dir-move` | 4 / 2 | move fallout via rename detection + import-path-only importers; an importer that also adds a symbol must stay expanded |
| `mixed` | 5 / 3 | both noise classes at once; a block-style Go import change must stay expanded (documented blind spot) |
| `clean-pr` | 0 / 2 | restraint: the only way to score is to mark nothing |
| `big-pr` | 110 / 3 | 113 files, past the `files(first:100)` page size — pagination in fetch and verify, chunked mutations; a first-page-only client marks 100/110 and never sees the substantive files |
| `canonical-noise` | 3 / 3 | JSON key reorder, YAML key reorder (comments intact), TS indentation-only; traps that must stay expanded: YAML comment-only edit, Python whitespace change |

The fixture layer has an automated check: `tests/run-helper.sh` builds every case repo, runs
the skill's own helper through the stub, and asserts the persisted VIEWED set equals the
`noise` label exactly. Run it after any change to the helper, the stub, or a fixture — it is
free (no model calls), and the promptfoo eval then only has to measure skill wording.

The fixture layer is verified independently of any model: running the skill's own
`mark-formatting-files-viewed.sh` against each built repo through the stub classifies every file
exactly per label (checked 2026-08-15).

## Adding a case

1. `cases/<id>/build.sh` — source `../../fixtures/lib.sh`, author base files, commit, branch `pr`,
   apply the PR's changes (run `scripts/format.sh` for formatter noise), commit. Leave the checkout
   on `pr`. Determinism matters: pinned dates and identity come from `lib.sh`; do not use `date`,
   `$RANDOM`, or unordered globs.
2. `cases/<id>/case.json` — `id`, `notes`, `fix_cmd`, and the `noise` / `substantive` file lists
   (paths as they appear on the PR, i.e. a moved file under its *new* path).
3. Verify the label mechanically before spending a model call: build the repo, run the helper
   through `bin/gh`, and check the marked set equals `noise`.

## Caveats

- The stub only implements `gh api graphql`; any other `gh` subcommand fails with a clear message.
  A control agent that leans on `gh pr view` will see that failure — acceptable, since the viewed
  state is only reachable through GraphQL anyway.
- PATH-based interception assumes the agent's shell profile does not overwrite PATH wholesale. If
  every arm suddenly errors with real-GitHub auth failures, that is what broke.
- `git`, `jq`, `perl`, `python3` must be on PATH (the helper and the stub need them).
