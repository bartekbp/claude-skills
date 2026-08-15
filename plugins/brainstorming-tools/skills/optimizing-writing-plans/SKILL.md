---
name: optimizing-writing-plans
description: Use when writing-plans has just produced an implementation plan and you're about to hand off to execution — specifically the moment you're tempted to offer execution options (subagent-driven vs inline) or invoke subagent-driven-development / executing-plans. Run this first, before that handoff. Triggers: plan file just written or committed; writing-plans just finished; brainstorm → spec → plan flow just completed. Do NOT use for arbitrary or external plans, generic "make this better" requests, or once execution has started.
---

# Optimizing Writing Plans

## Overview

`writing-plans` ends with its own **Self-Review** — but that is the *author* checking their own work, blind to its own assumptions. This skill is the **independent second pass**: fresh eyes that re-review the finished plan against the spec and **apply fixes in place**, then hand off to execution.

**REQUIRED SUB-SKILL:** Use andrej-karpathy-skills:karpathy-guidelines as the reviewing lens — it names the failure modes this pass hunts for (over-engineering, unsurfaced assumptions, non-surgical scope, weak success criteria).

**Core discipline — fix vs flag:**
- **Apply directly** the safe, mechanical, unambiguous fixes (placeholders, wrong task order, trivial merges, missing run commands, parallelism annotations, adding a concrete success criterion).
- **Flag, never silently change**, anything judgment-heavy: scope changes, **cutting an over-scoped task**, architecture decisions, behavior the spec left ambiguous. These go in a **Decisions to confirm** block at the top of the plan — you are a second opinion, not the author.

**Stay a reviewer, not a re-author.** Review the plan against the spec. You MAY check the codebase to verify a path/type/convention, but surface corrections as scoped fixes with a one-line reason — do not rewrite the whole plan or invent new scope.

## Run It in a Subagent

The independence this skill promises is only real in a fresh context: the main thread just *wrote* the plan, so it shares the author's assumptions and will re-approve them. Dispatch one general-purpose subagent with `model: opus` to do the review — this is judgment work (scope calls, spec gaps, architecture risks), not mechanics, so it gets the top-tier model.

The subagent cannot see this skill. Its prompt must carry:

- the absolute paths to the **plan file** and the **spec file** — paths only, no summary of either; summarizing would smuggle the author's framing into the fresh context
- the absolute path to this skill's SKILL.md (in this skill's base directory), with the instruction to read it first and follow it exactly — the four lenses, the fix-vs-flag discipline, and the output format
- the karpathy-guidelines lens: the path to that skill's SKILL.md if you can resolve it, otherwise paste its four principles (think before coding, simplicity first, surgical changes, goal-driven execution) into the prompt
- write access expectation: the subagent edits the plan file in place, leaving **both** mandated blocks in the file — Decisions to confirm at the top, the What-I-changed note at the end (with "No changes needed." when empty) — and repeats both in its report

Relay the report to the user, then proceed to the execution handoff. If subagent dispatch is unavailable, run the review inline — it is still worth doing, just weaker as a second opinion.

## When to Use

- Right after `writing-plans` writes the plan, before it offers the execution choice. Runs once per plan.
- NOT for external/arbitrary plans, generic "improve this", or after execution has begun.

## The Four Lenses

Run all four. For each finding, decide **fix** or **flag** per the discipline above.

1. **Soundness & right-sizing** — two directions:
   - *Too little / wrong:* wrong task order (a task using something a later task creates), missing tasks, steps that won't reach the goal, risky/unstated assumptions → reorder and add obvious missing tasks; flag architecture risks.
   - *Too much (Karpathy):* tasks, abstractions, configurability, or error-handling beyond what the spec asks (YAGNI); unrelated refactors or "improvements" bundled into the feature (not surgical — they belong in their own ticket). Cutting scope is judgment-heavy → **flag in Decisions to confirm with a cut recommendation**, don't silently delete. Also: every task must end in a **verifiable success criterion** (a test or a command), never "make it work" — adding that criterion is a safe fix.
2. **Completeness vs spec** — walk every spec requirement; can you point to a task implementing it? Add a task for a clear gap; flag a gap whose intended behavior is ambiguous.
3. **Executability** — placeholders ("add appropriate validation"), TODOs, vague steps, undefined types/functions/RPCs, missing `run:` commands or expected FAIL/PASS. Fill in the concrete content the author should have written. (These are exactly the failures `writing-plans` forbids.)
4. **Brevity + parallelism** — merge over-granular trivial tasks that touch the same file / always change together (entity + migration + schema mirror; a GET + PUT on one controller). Keep real layer/service boundaries separate. Reorder independent tasks adjacent and annotate them (`**Parallel:** independent of Tasks N–M`); do NOT build a dependency graph or named tracks.

## Preserve What Works

Every file path, code block, exact run command, expected FAIL/PASS, error code, and status code that is already correct survives verbatim. Length comes down by merging and de-boilerplating, not by summarizing away executable detail.

A task that already ends in a runnable command with an expected outcome is **done** — leave it byte-untouched. Do not expand, reword, or add detail to content that has no finding against it; elaborating a correct task is re-authoring, exactly what a reviewer must not do. A review that finds nothing to fix changes nothing and says so.

## Output

1. Edit the plan in place.
2. Add a **Decisions to confirm** block at the top for every flagged judgment call (the biggest-risk one first).
3. Append a short **What I changed and why** note at the end of the **plan file** — one line per fix, grouped by lens. Not optional: with zero fixes it reads "No changes needed." Whoever executes or re-reviews the plan later must see what the second pass did without hunting for a chat transcript.
4. Then proceed to the normal `writing-plans` execution handoff (subagent-driven vs inline).

## Common Mistakes

- **Re-authoring instead of reviewing** — silently redesigning architecture, data types, or scope the author chose. Flag it; don't rewrite it.
- **Silent judgment calls** — deleting a task (even an over-scoped one) or changing behavior on a guess. If it's a scope cut or the spec is ambiguous, flag in Decisions to confirm.
- **Only adding, never trimming** — a plan can fail by doing too much. Hunt over-engineering and unrelated refactors as hard as you hunt gaps.
- **Skipping lenses** — only catching placeholders and missing the soundness/order problems. Run all four.
- **Over-merging or graphing** — collapsing real boundaries into one task, or replacing the linear list with a dependency graph. Keep the list linear, annotate parallelism.
