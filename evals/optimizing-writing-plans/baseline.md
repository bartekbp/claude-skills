# Baseline

## 2026-08-15 — GREEN after wording fixes

Skill arm, all 6 cases, ~$2.80 (full run $2.42 + clean-plan rerun $0.39). SKILL.md
changes under test: Output step 3 pins the What-I-changed note to the plan file and
makes it unconditional ("No changes needed."); the delegation section requires both
mandated blocks in the file and in the report; Preserve What Works gained the
observable predicate "a task already ending in a runnable command with an expected
outcome is done — byte-untouched".

| Case | score |
|---|---|
| all six | **1.00** |

- Finding 1 (changelog flakiness) fixed: `structure` 2/2 on every case, note present
  in the plan file everywhere.
- Finding 2 (embellishment) resolved — but the fix was split between skill and
  fixture: the GREEN run's remaining clean-plan diff traced to fixture blemishes
  (a leftover "sliding-window" label contradicting the corrected spec, and Task 2's
  "manual smoke" lacking a runnable command — which the skill's own lens 3 is
  *supposed* to concretize). With the fixture genuinely clean, the skill left the body
  untouched and restraint scored 1.00. Fourth fixture lesson: "clean" must mean clean
  by the skill's own standards, or the case tests the fixture, not the skill.

## 2026-08-15 — adversarial cases + output-contract criteria

Three new cases (skill arm only, $1.28) probing untested boundaries, and new criteria:
`structure` (Decisions block on top; "What I changed" note exists anywhere in the
output), `reported` (each applied fix named in the changelog), plus `not_both` /
`must_not_regex` / `min_mentions` check types. merge-bait's score is a re-grade after
replacing phrase anchors with path anchors (the reviewer legitimately reworded both
phrases while fixing the order — third anchor lesson).

| Case | skill | What it proved |
|---|---|---|
| `ambiguous-gap` | **1.00** | flagged the spec's undecided behavior without inventing an implementation; added the Parallel annotation (first time lens 4's annotation was ever exercised) |
| `quiet-contradiction` | **1.00** | caught both quiet spec contradictions (24h→1h, 422→400) surgically — canaries inside the defective tasks survived; both fixes named in the changelog |
| `merge-bait` | **1.00** | merged the entity+schema pair, kept the service/controller boundary, moved the signPayload task above its first use, changelog in-plan |

Confirmed findings on the CURRENT skill (both from re-grading the first run's outputs
under the new criteria — the adversarial cases themselves all passed):

1. **Changelog mandate doesn't reliably bind through delegation** — the first run's
   seeded-standard output has no "What I changed and why" note anywhere (plan or
   report); structure now scores it 1/2. The delegation section's report spec and the
   Output section step 3 need to be tied together explicitly.
2. **Embellishment on clean plans** (from the first run): body similarity 0.75 vs the
   0.85 floor — "Preserve What Works" does not bind against elaborating already-adequate
   success criteria.

## 2026-08-15 — first full run

claude-sonnet-5 / effort medium orchestrator; the skill arm delegates the review to an
opus subagent per the skill's own delegation section. CLI 2.1.233, 3 cases, both arms,
~$2.20 total (skill sessions ~$0.3–0.6 — the opus subagent is most of it).
seeded-standard and over-engineered numbers are re-grades of the first run's saved
outputs after two assert fixes (brittle order anchor; similarity now measured with the
skill's mandated Decisions/changelog blocks stripped); clean-plan was re-run after a
fixture correction (see below).

| Case | skill | control |
|---|---|---|
| `seeded-standard` | **1.00** | 0.33 — untouched plan: fixed 0/3, flagged 0/1 |
| `over-engineered` | **1.00** | 0.50 — flagged 0/3 |
| `clean-plan` | 0.94 (similarity 0.75, floor 0.85) | 1.00 |

Readings:

- **The skill's authority model is the whole gap.** Control reviews in prose and never
  edits the file or escalates: zero fixes, zero flags, across both seeded cases. The
  skill arm applied every safe fix (placeholder, order, missing auditTrail task — and
  merged entity+migration per lens 4), flagged every judgment call in Decisions to
  confirm, and deleted nothing.
- **Delegation verified end-to-end**: sonnet orchestrator spawned the opus subagent,
  which read SKILL.md from the announced base directory, edited plan.md in place, and
  reported Decisions + changelog.
- **One real wording finding**: on a genuinely clean plan the skill embellishes —
  it expanded already-adequate success criteria (smoke-test commands), pulling body
  similarity to 0.75 against a 0.85 floor. "Preserve What Works" does not fully bind
  against elaboration. Mild (canaries all survive; nothing semantic changed), but it is
  the restraint gap to tighten.
- **The eval audited its own author**: the first clean-plan fixture carried an
  accidental spec contradiction (sliding-window spec vs fixed-window plan) and the
  opus reviewer correctly flagged it. Fixture corrected to be genuinely clean; the
  0.94 above is from the corrected fixture.
