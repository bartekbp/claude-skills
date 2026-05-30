---
name: optimizing-writing-plans
description: Use immediately after the superpowers writing-plans skill produces an implementation plan (the brainstorm → spec → plan flow), before the execution handoff. An independent fresh-eyes second pass that reviews the plan against its spec and applies fixes. Do NOT use for arbitrary or external plans, generic "make this better" requests, or once execution has started.
---

# Optimizing Writing Plans

## Overview

`writing-plans` ends with its own **Self-Review** — but that is the *author* checking their own work, blind to its own assumptions. This skill is the **independent second pass**: fresh eyes that re-review the finished plan against the spec and **apply fixes in place**, then hand off to execution.

**Core discipline — fix vs flag:**
- **Apply directly** the safe, mechanical, unambiguous fixes (placeholders, wrong task order, trivial merges, missing run commands, parallelism annotations).
- **Flag, never silently change**, anything judgment-heavy: scope changes, architecture decisions, "this task seems unnecessary", behavior the spec left ambiguous. These go in a **Decisions to confirm** block at the top of the plan — you are a second opinion, not the author.

**Stay a reviewer, not a re-author.** Review the plan against the spec. You MAY check the codebase to verify a path/type/convention, but surface corrections as scoped fixes with a one-line reason — do not rewrite the whole plan or invent new scope.

## When to Use

- Right after `writing-plans` writes the plan, before it offers the execution choice. Runs once per plan.
- NOT for external/arbitrary plans, generic "improve this", or after execution has begun.

## The Four Lenses

Run all four. For each finding, decide **fix** or **flag** per the discipline above.

1. **Soundness** — wrong task order (a task using something a later task creates), missing tasks, steps that won't reach the goal, risky/unstated assumptions. Reorder and add obvious missing tasks directly; flag architecture risks and questionable scope.
2. **Completeness vs spec** — walk every spec requirement; can you point to a task implementing it? Add a task for a clear gap; flag a gap whose intended behavior is ambiguous.
3. **Executability** — placeholders ("add appropriate validation"), TODOs, vague steps, undefined types/functions/RPCs, missing `run:` commands or expected FAIL/PASS. Fill in the concrete content the author should have written. (These are exactly the failures `writing-plans` forbids.)
4. **Brevity + parallelism** — merge over-granular trivial tasks that touch the same file / always change together (entity + migration + schema mirror; a GET + PUT on one controller). Keep real layer/service boundaries separate. Reorder independent tasks adjacent and annotate them (`**Parallel:** independent of Tasks N–M`); do NOT build a dependency graph or named tracks.

## Preserve What Works

Every file path, code block, exact run command, expected FAIL/PASS, error code, and status code that is already correct survives verbatim. Length comes down by merging and de-boilerplating, not by summarizing away executable detail.

## Output

1. Edit the plan in place.
2. Add a **Decisions to confirm** block at the top for every flagged judgment call (the biggest-risk one first).
3. End with a short **What I changed and why** note — one line per fix, grouped by lens.
4. Then proceed to the normal `writing-plans` execution handoff (subagent-driven vs inline).

## Common Mistakes

- **Re-authoring instead of reviewing** — silently redesigning architecture, data types, or scope the author chose. Flag it; don't rewrite it.
- **Silent judgment calls** — deleting a task or changing behavior on a guess. If the spec is ambiguous, flag in Decisions to confirm.
- **Skipping lenses** — only catching placeholders and missing the soundness/order problems. Run all four.
- **Over-merging or graphing** — collapsing real boundaries into one task, or replacing the linear list with a dependency graph. Keep the list linear, annotate parallelism.
