---
name: analyze-error-reporting
description: Use when you want a weekly-readable Cloud Error Reporting digest that leads with what is NEW or spiking — per error group count, trend vs the prior window, affected service, first/last seen, and a representative frame, rolled up by service. Also serves a post-deploy regression check (short window + one service). GCP-specific; requires the gcloud CLI.
---

# Analyze Error Reporting

## Overview

This skill produces a **weekly digest of Cloud Error Reporting** that leads with **what changed** — the error groups that are **NEW** or **spiking** — instead of the flat, count-sorted list a dashboard shows. Each group carries its **current-window count**, **trend vs the prior window**, **affected service**, **first/last seen**, and a **compact representative frame** (error kind + top application code location). Findings roll up **by service** and **by status** (new vs recurring).

It reads only the **pre-aggregated error groups** via the Error Reporting REST API — never raw error logs. Groups are few and high-signal, so one pull is complete and cheap. A bundled zero-dependency script fetches the groups, slices their per-bucket counts into a current-vs-prior window, classifies and rolls them up, and emits compact JSON; you (the model) turn it into a ranked report and judge severity.

Full stacks are **not** in the digest (they are large and may carry sensitive data). Fetch them on demand for one group with `--group`, which samples recent events and returns the **deduplicated distinct stacks** (ranked by frequency) so you can reason about the different failure modes without wading through hundreds of near-identical copies.

## When to Use

- A weekly "what's new or getting worse in errors" review (the primary use).
- A **post-deploy regression check**: `--window <since-deploy> --service <name>` compares the post-deploy window against the equal window before it, for one service.
- Feeding a weekly summary that combines error trends with other signals.

**Don't use when:** the project isn't on GCP / has no Error Reporting data, or you need individual-event forensics at scale (use the Logs Explorer / drill-down, not a digest).

## Prerequisites

This skill shells out to external tools — check before running:

- **Node.js** v18+ (for `npx tsx`, and for the global `fetch` it relies on): `node --version`. `npx` ships with npm.
- **`gcloud` CLI**, authenticated with Error Reporting read access: `gcloud auth login` (the script calls `gcloud auth print-access-token`). The **Error Reporting API** must be enabled on the project. If `gcloud` is missing the script stops with an install link.

No other install: `analyze.ts` has zero runtime dependencies and `npx` fetches `tsx` on demand.

## No config file

Unlike the sibling `analyze-cloud-armor`, this skill has **no per-project config**. Muting belongs in Error Reporting itself: the script reads each group's `resolutionStatus` and by default reports only `OPEN` and `ACKNOWLEDGED`, dropping `RESOLVED` and `MUTED`. To silence known noise, resolve or mute the group in the Error Reporting UI. Pass `--include-resolved` to see everything.

## How to Run

Run from the skill's own directory (where `analyze.ts` lives), or use an absolute path.

```bash
# Weekly digest (default window 7d)
npx tsx analyze.ts --project my-project

# Custom window / thresholds (--lead-cap limits how many NEW/SPIKING groups become headline leads, default 15)
npx tsx analyze.ts --project my-project --window 14d --spike-ratio 3 --min-count 50 --lead-cap 25

# Control the per-lead distinct-stack enrichment (default: top 2 from a 60-event sample; 0 disables)
npx tsx analyze.ts --project my-project --lead-stacks 3 --lead-sample 100

# Post-deploy regression check: last 6h vs the prior 6h, one service
npx tsx analyze.ts --project my-project --window 6h --service checkout-service

# Drill down into one group: sample recent events, return deduplicated distinct stacks
npx tsx analyze.ts --project my-project --group <groupId>
npx tsx analyze.ts --project my-project --group <groupId> --events 500   # sample more before dedup

# Offline: analyze a saved export (also how the fixtures run)
npx tsx analyze.ts --input fixtures/sample-error-groups.json
```

Window is `Nh` / `Nd` / `Nw`, up to ~15 days (the API's 30-day period must cover twice the window). The script auto-selects the API period and bucket granularity (daily for day-scale windows, hourly for hour-scale).

## Output Shape (digest)

```jsonc
{
  "meta": { "window": { "from", "to", "label" }, "priorWindow": { "from", "to" },
            "bucketGranularity": "1d", "resolutionFilter": ["OPEN","ACKNOWLEDGED"],
            "serviceFilter": null, "source": "gcloud",
            "coverage": { "groupsFetched": N, "groupsReported": M, "complete": true, "periodUsed": "PERIOD_30_DAYS" } },
  "summary": { "groups", "new", "spiking", "improved", "reappeared", "totalCurrent", "totalPrior" },
  "byService": [{ "service", "groups", "new", "current", "prior", "trendPct" }],
  "leads":  [{ "groupId", "status", "service", "current", "prior", "trendPct",
               "firstSeen", "lastSeen", "affectedServices", "frame": { "kind", "where" },
               "stacks": { "sampled": 60, "distinct": 10,
                           "top": [{ "count", "sharePct", "kind", "where" }] } }],
  "groups": [ /* every reported group, same row shape (no `stacks`), sorted by current desc */ ]
}
```

`leads` is the headline: **NEW + SPIKING** groups, biggest first. `frame.where` is the top application code frame (vendored `node_modules`/library frames are skipped); `frame.kind` is the error kind. `trendPct` is `null` for NEW/REAPPEARED (no prior). Counts are bucket-granular (`meta.bucketGranularity`).

Each lead also carries a **`stacks`** block (live runs only): it samples recent events for that group and deduplicates them, so you see how mixed the Error Reporting "group" really is. `stacks.distinct` is the number of distinct stacks in the sample, and `stacks.top` is the most common one or two (`count`, `sharePct`, `kind`, `where`). A high `distinct` with a low top `sharePct` means the group is a coarse bucket of unrelated errors (e.g. everything caught at one gRPC frame), so the group's own `frame` may not represent what's actually firing. Tune with `--lead-stacks N` (distinct stacks per lead, default 2; `0` disables) and `--lead-sample N` (events sampled per lead, default 60). Offline (`--input`) runs omit `stacks`.

## Output Shape (drill-down, `--group`)

```jsonc
{
  "group": "<groupId>",
  "sampled": 200,          // recent events pulled (cap with --events)
  "distinctStacks": 13,    // after dedup
  "stacks": [
    { "count": 100, "services": ["checkout-service"],
      "firstSeen": "…", "lastSeen": "…",
      "message": "<one full representative stack for this failure mode>" }
  ]
}
```

`stacks` is ranked by `count` (most frequent failure mode first). Stacks that differ only by volatile data — entity/user ids, quoted free-text (names), timestamps, memory addresses, UUIDs, IPs — are collapsed into one; genuinely different errors stay separate. Each `message` is a full stack you can read and ask about (e.g. "compare this to the code").

Status meanings: **NEW** (first seen within the window), **REAPPEARED** (old group, zero in the prior window), **SPIKING** (current ≥ `spike-ratio`× prior and ≥ `min-count`), **IMPROVED** (current ≤ half of prior), **RECURRING** (steady).

## Producing the Report

1. Run the script. If `meta.coverage.complete` is `false`, pagination hit the cap — say there may be more groups.
2. **Lead with `leads`** — the NEW and SPIKING groups. **Render each lead as its own block, NOT a table row** (stack traces do not fit in table cells). Per the readable layout below, show the **groupId**, **logical service**, **current count + trend**, the **distinct-stack count**, and the **most common one-to-three stacks**. **Check `stacks.distinct`**: if it is 1 (or the top stack's `sharePct` is high) the group is one real error — trust its `frame`; if `distinct` is high and `sharePct` low, flag it as a **mixed bucket** and use `stacks.top` (not `frame`) for what is actually firing.
3. **Then `byService`** — which services carry the most error volume and the most new groups. Render sorted by `current`.
4. **Summarize `summary`** — totals and how many groups are new/spiking/improved. Note `totalCurrent` vs `totalPrior` for the overall direction.
5. **Do not dump every group.** `groups` is there for completeness; surface only what changed.
6. **To judge severity or compare against code, drill down:** rerun with `--group <groupId>` to get the deduplicated distinct stacks (ranked by frequency) with **full** stack messages, then render those as the per-stack traces in the layout below. Bump `--events` to widen the sample.
7. Be honest about the window and granularity, and that `trendPct` is undefined for brand-new groups.

### Readable layout (use this, not tables)

Render each lead/group as a block. The compact `stacks.top` (kind + `where`) comes straight from the digest; the **full stack traces** come from `--group <groupId>` (its `stacks[].message`). Shorten noisy vendored frames — collapse `/app/node_modules/.pnpm/<pkg>/node_modules/` and `/app/node_modules/` to `…/` — and keep ~3–6 frames per stack.

Mark each block by **whether it needs your attention**:

- 🟥 **needs ack** — a genuine code defect or anomaly to act on: technical error kinds (`TypeError`/null deref, `QueryFailedError` / constraint / type errors, `SystemError`, panics, unhandled rejections), a `NEW` group, or an unexpected spike of something that is not a routine rejection.
- 🟩 **looks OK** — expected/benign and no action needed: business & validation rejections (`… not found`, `jwt expired`, `401 Unauthorized`, "must be at least…"), or noise that is flat or improving.

Judge the colour on **actionability, not shape** — a single-cause group can be perfectly benign (🟩), and a mixed bucket can still hide a 🟥 defect. Still report `distinct`: when it is high and the top `sharePct` is low, the labelled `frame` is misleading, so list the top distinct kinds rather than trusting `frame`.

```
🟥 <groupId> · <service> · <current> errors (<trend>%)   ← needs ack: real defect / anomaly
   distinct stacks in sample of <sampled>: <distinct>
   [1] <share>% (×<count>)  <error kind>
          at <app frame>   (file:line)
          at <next frame>  …/<pkg>/<file>:<line>
          … (+N more frames)
   [2] <share>% (×<count>)  <error kind>
          at <app frame> …

🟩 <groupId> · <service> · <current> errors (<trend>%)   ← looks OK: expected/benign
   distinct stacks in sample of <sampled>: <distinct>
   [1] <share>% (×<count>)  <error kind>
          at <app frame>   (file:line)
          … (+N more frames)
```

Lead with the 🟥 groups (the ones needing acknowledgement); summarise the 🟩 expected/benign ones briefly so the reader can scan past them.

## Common Mistakes

- **Treating the digest as exhaustive event data.** It is group-level and bucket-granular; for individual events use `--group` or the Logs Explorer.
- **Reading `frame.kind` as the full error.** It is a trimmed one-liner for triage; the real stack is behind `--group`.
- **Muting in config.** There is none — mute/resolve in Error Reporting; the digest honors `resolutionStatus`.
- **Windows over ~15 days.** Not supported (the 30-day period must cover 2× the window); use a shorter window.

## Testing

`npx tsx analyze.test.ts` runs the analysis against generic fixtures. Run it after editing `analyze.ts`.
