# Baseline

## 2026-08-15 — sonnet re-baseline, skill vs skill-no-helper

Arms moved to claude-sonnet-5 / effort medium (opus scored 1.00 everywhere and could no
longer discriminate). 6 cases (canonical-noise added), fixtures now carry a bare `origin`.
CLI 2.1.233, helper with whitespace + canonical JSON/YAML detection and the formatter
sentinel (uncommitted working tree). 12 sessions, $4.14. Control arm not yet re-run on
sonnet.

| Case | skill | skill-no-helper |
|---|---|---|
| `format-sweep` | 1.00 | 1.00 |
| `dir-move` | 1.00 | 1.00 |
| `mixed` | 1.00 | 1.00 |
| `clean-pr` | 1.00 | 1.00 |
| `big-pr` | 1.00 | **1.00** — hand-rolled the whole flow: paginated fetch, batches of 100+10, zero dropped |
| `canonical-noise` | 1.00 | **0.50** — collapsed 0/3 (missed the JSON key-reorder, YAML reorder, whitespace-only files); spared=1.0, marked nothing wrong |

Readings:

- **First real wording finding.** Without the helper, the prose carries the formatter,
  import-path, batching, pagination, and verification behavior — but NOT the newer
  whitespace/canonical classes, even though their tests (`diff -wB`, `jq -S`) are stated
  inline. The agent classified those three files as substantive and stopped. Conservative
  failure (nothing wrongly hidden), but the sections don't bind when the script is absent.
- Throttle still unpriced: both arms batched everywhere, `dropped=0` across the run.
- Skill-arm quirks worth ignoring for now: big-pr emitted a stray 1-alias mutation before
  its chunks, format-sweep marked its files twice (idempotent).
- Sonnet at effort medium is fully capable of driving this skill — supports keeping
  sonnet as the workhorse baseline tier.

## 2026-08-15 — pagination fix + big-pr case

Skill arm, 5 cases (big-pr added: 113 files, past the files(first:100) page size).
claude-opus-5 / effort medium orchestrator delegating to a Sonnet subagent, CLI 2.1.233,
helper with paginated fetch/verify + 50-alias mutation chunks (uncommitted working tree).
5 sessions, $1.18 total.

| Case | score | turns | cost | batches |
|---|---|---|---|---|
| `big-pr` | 1.00 | 2 | $0.29 | 50, 50, 10 |
| `format-sweep` | 1.00 | 3 | $0.20 | 6 |
| `dir-move` | 1.00 | 2 | $0.29 | 4 |
| `mixed` | 1.00 | 2 | $0.20 | 5 |
| `clean-pr` | 1.00 | 2 | $0.21 | — |

All 110 big-pr noise files collapsed across three chunked mutations, zero dropped,
substantive tail correctly left expanded. Pre-fix helper on the same fixture marked
100/110 and reported "Substantive: 0" while looking healthy (recorded during the
script's RED run, not via the model eval).

## 2026-08-15 — skill delegates to a Sonnet subagent

Skill arm only (control unaffected — it never reads SKILL.md). claude-opus-5 / effort
medium orchestrator, CLI 2.1.233, SKILL.md with the new "Run It in a Subagent" section
(uncommitted working tree at time of run). 4 sessions, 42s, ~$0.89 total.

| Case | score | turns | cost |
|---|---|---|---|
| `format-sweep` | 1.00 | 2 | $0.19 |
| `dir-move` | 1.00 | 2 | $0.24 |
| `mixed` | 1.00 | 2 | $0.23 |
| `clean-pr` | 1.00 | 2 | $0.23 |

- Delegation happened: parent transcripts are 2 turns (one Task dispatch + the relayed
  report) vs 7–16 turns inline in the first full run, and every answer carries exactly
  the report shape the section prescribes (classification counts + verified VIEWED
  count). Cost per session dropped ~40% (~$0.37 → ~$0.22) with the mechanical work on
  the sonnet worker.
- No metric regression: 4/4 perfect, batched mutations, `dropped=0`, restraint intact
  on `clean-pr`.

## 2026-08-15 — first full run (inline skill, pre-delegation)

claude-opus-5 / effort medium, both arms, CLI 2.1.233, skill at `a6575aa`
(`plugins/pr-tools` unchanged since). 8 sessions, `-j 4`, 3m02s, $3.61 total.

| Case | skill | control |
|---|---|---|
| `format-sweep` | **1.00** | **1.00** — found the GraphQL viewed route unaided, batched 6/6 |
| `dir-move` | **1.00** | 0.50 — collapsed 0/4, issued no mutation |
| `mixed` | **1.00** | 0.50 — collapsed 0/5, issued no mutation |
| `clean-pr` | **1.00** | **1.00** |

Reading, metrics apart:

- `spared` = 1.0 on **every** run of both arms. Neither arm ever marked a substantive file viewed.
  The guard has no headroom at this difficulty; a harder case (e.g. an import retarget) is what
  would move it.
- `collapsed`: the skill's whole edge is the move/import cases. A bare Opus knows the
  formatter-noise trick; it does not reach for per-file "Viewed" state when the noise is move
  fallout — on `dir-move` and `mixed` the control instead **rewrote the `pr` branch** (amended the
  noise into the base) and marked nothing. History-rewriting is a defensible real-world answer but
  not what was asked, and it scores as the miss it is.
- Throttle: never triggered. Both arms batched whenever they issued mutations at all
  (`aliases=[6]`, `dropped=0`). The rate-limit trap section goes unpriced at this difficulty.
- The skill arm is also cheaper and shorter: 7–16 turns / ~$0.37 avg vs 12–21 turns / ~$0.54 avg
  for the control.

Harness note: this run exposed that arms shared `.work/<id>` checkouts, and the control's branch
rewrite mutated them mid-run (no visible damage — the skill arm's scores predate the rewrite).
Fixed immediately after: the provider now copies the repo per call. The fix does not touch prompt
or vars, so this baseline remains comparable to future runs.

## Earlier

Plumbing smoke (not a baseline — override run, 2026-08-15, CLI 2.1.x): `skill` arm on
`format-sweep` and `clean-pr` under `SKILL_EVAL_MODEL=claude-haiku-4-5-20251001`, effort low: both
perfect. Evidence the harness measures what it claims, not a number to compare against.
