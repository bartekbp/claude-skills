# optimizing-writing-plans

Does the review fix the mechanical, flag the judgment calls, and leave the rest alone?

Run from this directory: `npx promptfoo@latest eval -j 3 --no-cache` (6 sessions).
Shared setup is in [../README.md](../README.md).

## How it works

Each case is an authored **spec + plan pair with seeded defects** — labels true by
construction, like simplify-pr's fixtures. Every defect carries a grep-checkable
signature in `case.json`: a string that must vanish (placeholder), appear (missing
requirement), reorder (task using a table created later), or appear twice (a judgment
call that must survive in the plan AND be raised in a Decisions to confirm block).
`case.json` lives outside `workspace/`, so the agent never sees the answer key.

The provider runs the arm with `allow_edits` and captures the edited `plan.md` as a
trailer; `asserts/check.py` grades the artifact, never the prose. No LLM judge.

| Metric | Meaning |
|---|---|
| `fixed` | seeded safe-fix defects repaired as prescribed |
| `flagged` | seeded judgment defects raised in Decisions to confirm **while still present** — a silently deleted task fails this even though the "problem" is gone |
| `preserved` | canary strings (paths, run commands, FAIL/PASS lines) surviving verbatim |
| `restraint` | clean case only: difflib similarity to the original body, with the skill's mandated Decisions/changelog blocks stripped first |
| `structure` | output contract: Decisions block above the first task (when flags exist); a "What I changed" note anywhere in the output (when fixes exist) |
| `reported` | each applied fix named in the changelog, via per-check `report_hints` |

Fixed/preserved checks scan the plan body with mandated blocks stripped (the changelog
legitimately quotes old values); flagged checks scan the full document. Extra check
types: `not_both` (a pair that must merge), `must_not_regex` (an undecided behavior the
plan must not implement), `min_mentions` (for defects seeded in the spec, not the plan).

## Cases

| Case | Tests |
|---|---|
| `seeded-standard` | one defect per lens: placeholder, task-order inversion, missing spec requirement (auditTrail), speculative abstraction to flag-not-delete |
| `over-engineered` | discipline: three Karpathy violations (unrelated rename sweep, speculative backend, impossible-error handling) — all must be flagged, none silently cut |
| `clean-plan` | restraint: nothing wrong; scored on canaries + similarity |
| `ambiguous-gap` | spec marks a behavior undecided — flag it, do NOT invent an implementation; plus the Parallel annotation |
| `quiet-contradiction` | plan contradicts spec values (expiry, status code) without omitting anything; canaries inside the defective tasks force surgical fixes |
| `merge-bait` | lens 4 both directions (must-merge pair, must-not-merge layer boundary) + a body-level order inversion |

## Lessons already priced in

- Anchor strings must survive *correct* edits: the first order anchor was a full task
  heading, which the reviewer legitimately destroyed by merging two tasks.
- Similarity must exempt the skill's mandated output blocks, or the format reads as padding.
- "Clean" fixtures need review themselves — the first clean plan contradicted its spec
  (sliding vs fixed window) and the opus reviewer caught the fixture author.

## Adding a case

Author `workspace/{spec.md, plan.md, src stubs}` + `case.json` signatures. Seed each
flag-keyword exactly once in the plan (the flagged check counts occurrences). Verify
signatures against a hand-written "perfect review" before spending a model call.
