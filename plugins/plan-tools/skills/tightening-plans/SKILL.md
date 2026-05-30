---
name: tightening-plans
description: Use right after the writing-plans skill produces an implementation plan, or when asked to shorten, condense, tighten, or parallelize an existing implementation plan. Merges trivial tasks and annotates which tasks can run in parallel, without dropping scope or executable detail.
---

# Tightening Plans

## Overview

Implementation plans from `writing-plans` are deliberately verbose and strictly linear. This skill makes a finished, fully-detailed plan shorter and more parallel. Two moves only:

1. **Merge trivial tasks** into fewer, meaningful tasks.
2. **Annotate parallelism** — mark which tasks are independent, keeping the linear list.

**Core principle: tighten the structure, never the content.** Every file path, code block, exact test command, expected fail/pass, error code, and status code survives verbatim. You are condensing the *task list*, not summarizing the plan.

**REQUIRED SUB-SKILL:** Use andrej-karpathy-guidelines for the judgment calls — surface merge/scope decisions as explicit notes instead of deciding silently, and stay surgical.

## When to Use

- Auto-fire after `writing-plans` writes a plan, **before** the execution handoff. Tighten, then offer execution.
- On request: "make this plan shorter / tighter / more parallel."

Do NOT use to design or re-scope — that's `brainstorming`/`writing-plans`.

## Move 1: Merge Trivial Tasks

Merge adjacent tasks when ALL of these hold:

- They change the **same file** or the **same logical unit** (controller, entity, route prefix).
- They **always change together** — splitting only invites drift (entity + its migration + the `schema.sql` mirror; a GET and a PUT on the same resource).
- The merged task still has **one coherent test surface**.

Keep tasks separate when merging would hide a real boundary (cross-service, cross-layer) or produce a task too big to hold in context.

**When you merge, keep the executable skeleton.** Preserve the TDD steps (write failing test → run/expect FAIL → implement → run/expect PASS → commit) and the exact run commands. You may state the TDD loop **once** at the top and then, per task, keep file paths + each test's assertion + the implementation snippet — but never delete the run commands or expected outcomes. Merging tasks ≠ deleting steps.

## Move 2: Annotate Parallelism (reorder + annotate)

Keep the numbered, linear task list. Do **not** build a dependency graph or split into named "tracks."

- Reorder only to place independent tasks adjacent.
- Add one line under each task that has no upstream dependency: `**Parallel:** independent of Tasks N–M — can start immediately.`
- For dependent tasks: `**Depends on:** Task N.`
- If a merged task adds several independent tests, note they can be written/run together.
- Add a single summary line at the top: `**Parallelizable:** Tasks X and Y are independent; the rest is sequential.`

## Scope Is Preserved

Do not drop tasks to make the plan shorter. If a task looks like genuine overcomplication (YAGNI), or you must assume something undefined (a missing proto RPC, an unstated type), **surface it as a note or question at the point it arises** — do not silently delete or invent. Length reduction comes from merging and de-boilerplating, never from cutting work.

## Quick Reference

| Do | Don't |
|----|-------|
| Merge tasks that touch one file / always change together | Merge across services or layers |
| Keep the linear numbered list + per-task `**Parallel:**` note | Build a dependency graph or "Track A/B" restructure |
| Preserve every code block, path, run command, expected output | Strip TDD steps or replace commands with prose |
| Surface scope/assumption decisions as visible notes | Silently drop tasks or invent undefined APIs |

## Common Mistakes

- **Over-restructuring** into parallel tracks/graphs — the user wants the linear list annotated, not redrawn.
- **Gutting executability** — removing `run: ...` / expected FAIL/PASS lines. The plan must stay runnable task-by-task.
- **Silent scope cuts** — dropping a task because it "seems unnecessary" without flagging it.
- **Merging too aggressively** — one giant task is as bad as ten trivial ones; aim for tasks you can hold in context.

## After Tightening

Hand the tightened plan back and proceed to the normal `writing-plans` execution handoff (subagent-driven vs inline). The tightened plan replaces the verbose one in place.
