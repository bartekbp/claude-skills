# analyze-error-reporting — Design

A weekly-readable Cloud Error Reporting digest that leads with what is **NEW** or
**spiking** — the signal dashboards bury. A sibling skill to `analyze-cloud-armor` in the
`gcloud-tools` plugin, built on the same pattern: a thin zero-dependency `npx tsx` script
fetches a rare, fully-fetchable, pre-aggregated signal, compresses it to compact JSON, and
the LLM does the judgment.

## Goal & wedge

Primary wedge: **weekly new-error digest**. Secondary, same engine: **post-deploy
regression check** via flags (short window + service filter). Both reduce to one operation:
compare a **current window** against an equal-length **prior window** and classify each
error group.

End goal (out of scope here): this skill plus `analyze-cloud-armor` become inputs to a
separate weekly orchestrator.

## Why a script (not LLM-direct over the raw API)

Measured on a real project: one pull of 30 days of `groupStats` with daily buckets returned
**155 groups, ~965 KB, ≈241K tokens** of raw JSON — including ~206 KB of raw stacktraces
(max 7.5 KB each) and `affectedServices` arrays up to 160 entries per group. Feeding that
straight to the model every run is the "raw data floods context" failure mode.

The script is deliberately thin — fetch + bucket-sum + trim — and earns its place by:

1. **Window/trend arithmetic** — slicing daily/hourly `timedCounts` buckets into
   current-vs-prior and computing trend% across ~150 groups, exactly and cheaply.
2. **Compression** — trims 160-entry service arrays to a count + top few, and the 7.5 KB
   representative message to a compact frame. ~965 KB → ~15 KB.
3. **Determinism + tests** — classification thresholds and GKE pod-suffix stripping are
   unit-tested against generic fixtures.

The LLM still does all judgment: which errors are critical, and (via drill-down) comparing
stacks to code. For a tiny project (~5 groups) the script would be unnecessary; real
projects are not tiny.

## Data source

Native `gcloud beta error-reporting` exposes only `events report`/`delete` (no read), so the
script mints a token (`gcloud auth print-access-token`) and calls the **Error Reporting REST
API** directly. It never scans raw error logs.

- **Digest:** `GET projects/<p>/groupStats?timeRange.period=…&timedCountDuration=…&order=COUNT_DESC&pageSize=…`,
  paginated. Error groups are few and high-signal (the WAF-denies analogue). One pull yields,
  per group: `count` (whole-period), `timedCounts[]` (per-bucket), `firstSeenTime`,
  `lastSeenTime`, `affectedServices[]` + `numAffectedServices`, `group.resolutionStatus`, and
  a `representative` event.
- **Drill-down (`--group <id>`):** `GET projects/<p>/events?groupId=…&pageSize=<small>` →
  full stack + a few example events for one group, for judging severity / comparing to code.
- **Offline (`--input <file>`):** analyze a saved JSON export — how fixtures and tests run.

## Windows, trend, classification

API `timeRange.period` is a fixed enum (`PERIOD_1_HOUR`, `_6_HOURS`, `_1_DAY`, `_1_WEEK`,
`_30_DAYS`). To support arbitrary windows, the script requests the **smallest enclosing
period that covers 2× the window**, with a bucket (`timedCountDuration`) fine enough to align
to the cutoff, then sums `timedCounts` buckets on each side of `now - window`:

- Weekly digest: `--window 7d` → `PERIOD_30_DAYS`, daily buckets (86400s); last 7 buckets =
  current, prior 7 = prior.
- Post-deploy: `--window 6h` → `PERIOD_1_DAY`, hourly buckets (3600s); last 6 vs prior 6.

The whole-period `count` field is **not** used for window math — only bucket sums are, so the
reported numbers match the stated window and granularity.

Per-group classification (thresholds are flags with defaults; **no config file**):

- **NEW** — `firstSeenTime` falls within the current window.
- **REAPPEARED** — old `firstSeenTime`, but prior-window count is 0.
- **SPIKING** — `current ≥ spikeRatio × prior` (default `spikeRatio = 2`) AND
  `current ≥ minCount` (default floor, e.g. 10), and not NEW.
- **IMPROVED** — `current ≤ 0.5 × prior` (and `prior ≥ minCount`).
- **RECURRING** — otherwise.

## Muting — server-side, no config file

There is **no per-project config file**. Muting belongs in Error Reporting itself: the API
returns `group.resolutionStatus`, so the script filters client-side, by default keeping
`OPEN` and `ACKNOWLEDGED` and dropping `RESOLVED` and `MUTED`. A flag can widen this. This
overrides the original "config interview + cache" idea from the sibling skill — Error
Reporting already holds the mute state, so duplicating it locally would only drift.

## Service rollup

GKE groups report `serviceContext.service = "gke_instances"` with the real workload name as a
prefix of the pod name in `version` (e.g. `checkout-service-67566c4cf7-vzdtj`). The script
derives the **logical service** by stripping the trailing replicaset-hash + pod-hash segments
(`checkout-service-67566c4cf7-vzdtj` → `checkout-service`) and rolls up by that. The raw
`service`/`version` is kept available. Non-GKE resource types use `service` as-is.

## Output shape (digest)

Compact JSON — organized, leads with what changed, never an exhaustive raw dump:

```jsonc
{
  "meta": {
    "window":      { "from": "…", "to": "…", "label": "7d" },
    "priorWindow": { "from": "…", "to": "…" },
    "bucketGranularity": "1d",
    "resolutionFilter": ["OPEN", "ACKNOWLEDGED"],
    "serviceFilter": null,
    "coverage": { "groupsFetched": 155, "complete": true, "periodUsed": "PERIOD_30_DAYS" }
  },
  "summary": { "groups": 155, "new": 4, "spiking": 7, "improved": 9,
               "totalCurrent": 1234567, "totalPrior": 987654 },
  "byService": [
    { "service": "checkout-service", "groups": 12, "new": 1,
      "current": 50000, "prior": 21000, "trendPct": 138 }
  ],
  "leads": [
    { "groupId": "…", "status": "NEW",
      "service": "checkout-service",
      "current": 8123, "prior": 0, "trendPct": null,
      "firstSeen": "…", "lastSeen": "…", "affectedServices": 3,
      "frame": { "kind": "NullPointerException", "where": "OrderService.java:142 / placeOrder" } }
  ],
  "groups": [ /* every group, same row shape, sorted by current desc */ ]
}
```

- `leads` is the headline: top **NEW** + top **SPIKING** groups, capped (e.g. top 15).
- `frame` is a **compact** representative — `kind` (first/exception line, trimmed) + `where`
  (top code frame parsed from the stack). Enough to triage; full stacks live behind
  `--group`. `trendPct` is `null` when prior is 0 (NEW/REAPPEARED — infinite trend).
- `groups` is the full per-group list (compact rows, no raw stacks) for completeness.

## Drill-down output (`--group <id>`)

```jsonc
{
  "group": { "groupId": "…", "service": "checkout-service",
             "current": 8123, "prior": 0, "status": "NEW",
             "firstSeen": "…", "lastSeen": "…",
             "affectedServices": [ /* top few, + total count */ ] },
  "examples": [ { "eventTime": "…", "service": "…", "message": "<full stack>" } ]  // pageSize-bounded
}
```

This is the one place full stacks enter context, on explicit request, for one group — so the
LLM can assess severity and compare against code.

## Coverage honesty

`meta.coverage` always reports: window + prior window, bucket granularity, period used,
resolution filter, service filter, group count, and whether pagination was truncated
(`complete: false` when a `nextPageToken` remained at the page cap). The report states that
counts are bucket-granular.

## Safety / NDA firewall

- **Zero** real customer or production data anywhere in the repo. All fixtures and committed
  files use generic data only: `example.com`, `my-project`, neutral service names
  (`checkout-service`, `search-api`, `web-frontend`). Grep before commit.
- Runtime output on the user's own machine includes real stacks **by design** — that is the
  tool's value, and is outside the repo.

## Files

```
plugins/gcloud-tools/skills/analyze-error-reporting/
  SKILL.md
  analyze.ts                       # zero-dep fetch + bucket-sum + trim
  analyze.test.ts                  # node:test against fixtures
  fixtures/sample-error-groups.json   # generic groupStats export
  fixtures/sample-group-events.json   # generic events export (drill-down)
  package.json
  tsconfig.json
```

No `*.config.example.json` (no config file).

## Registration

- Add the skill to the `gcloud-tools` plugin.
- Bump `plugins/gcloud-tools/.claude-plugin/plugin.json` version `0.1.0` → `0.2.0` and update
  its `description` to mention error-reporting.
- Update the `gcloud-tools` entry in root `.claude-plugin/marketplace.json` description.

## Process

- TDD via `superpowers:writing-skills` (generic fixtures → failing test → script → green).
- Dogfood against the real target project (gcloud already authed); keep all real data and the
  project id out of the repo.
- Ship via branch → PR to `bartekbp/claude-skills` → merge (like PR #2). No direct pushes to
  `main`.

## Out of scope (v1)

- No false-negative / "errors that should exist but don't" inference.
- No config file, no local mute state.
- No alerting / scheduling — the separate weekly orchestrator owns that.
