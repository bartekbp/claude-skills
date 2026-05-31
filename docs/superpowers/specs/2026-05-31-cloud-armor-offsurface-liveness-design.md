# Cloud Armor — Off-Surface Liveness Signal

**Date:** 2026-05-31
**Skill:** `plugins/gcloud-tools/skills/analyze-cloud-armor`
**Status:** Approved design, pending implementation plan

## Problem

When the surface-scoped enforced-deny count is `0`, the report is all zeros
(`enforcedDeniesOnSurface: 0`, empty `byRule`/`byCountry`/`attackLikeRequests`).
That zero is correct and trustworthy, but it is **ambiguous to the reader**: it
looks identical whether (a) the WAF is healthy and simply blocking nothing on our
legitimate surface, or (b) the logging pipeline is empty / misconfigured. Today the
only way to tell them apart is a manual raw `gcloud` cross-check (which is how this
gap was found: 0 on-surface denies, but 333 enforced denies off-surface in the same
window — all credential/secret scanning of `/.env`, `/.git/config`, `/.aws/credentials`).

The tool fetches denies **server-side-scoped to the surface** (`surfaceClause`), so
off-surface denies are never pulled and cannot inform the report.

## Non-Goals

- **Not** turning this into an IDS / attack dashboard. The off-surface view is a
  deliberately shallow liveness summary (count + top 5s), never per-rule or SQLi
  analysis. The tool remains a false-positive tuner.
- **No** change to the on-surface analysis — that path stays the authoritative,
  full-fidelity deep analysis it is today.

## Design (Option B — second projected query, always run)

Add a second `gcloud logging read` for **all** enforced denies (no surface clause),
rendered with a reduced field projection so the payload stays small even when a
project has tens of thousands of denies. Partition client-side using the *same*
allowlist logic, and report a shallow summary of the off-surface remainder.

The on-surface count remains sourced from the existing Query 1 (full JSON), so the
two queries never disagree on the on-surface number.

### Query 1 (unchanged)
Surface-scoped denies, full JSON, normalized and analyzed exactly as today.

### Query 2 (new)
```bash
gcloud logging read '<base> AND jsonPayload.enforcedSecurityPolicy.outcome="DENY"' \
  --project <project> --freshness <window> \
  --format='value(httpRequest.requestUrl, jsonPayload.securityPolicyRequestData.remoteIpInfo.regionCode, httpRequest.remoteIp)' \
  --limit <FETCH_LIMIT>
```
- `<base>` includes the **same `--policy` clause** as Query 1, so `--policy` narrows
  both queries consistently.
- Output is tab-separated `url \t regionCode \t ip` lines (one per deny).
- Parse each line, derive `path`/`host` from the URL, apply the **same**
  `inAllowedPrefix` / `inAllowedDomain` logic, and keep only **off-surface** rows for
  the summary.
- Capped at `FETCH_LIMIT` like Query 1; mark `complete: false` if the cap is hit.

### Summary shape

```ts
interface OffSurfaceSummary {
  denies: number;          // count of off-surface enforced denies
  distinctIps: number;
  complete: boolean;       // false if Query 2 hit FETCH_LIMIT
  topPaths: { path: string; denies: number }[];        // top 5, most-blocked first
  topCountries: { country: string; denies: number }[]; // top 5, most-blocked first
}
```

Reported under `meta.coverage`:

```jsonc
"coverage": {
  "enforcedDenies": { "fetched": 0, "complete": true, "span": {} },   // on-surface, unchanged
  "offSurface": {
    "denies": 333, "distinctIps": 43, "complete": true,
    "topPaths":     [{ "path": "/.env", "denies": 27 }, { "path": "/.git/config", "denies": 12 }],
    "topCountries": [{ "country": "US", "denies": 237 }, { "country": "GB", "denies": 43 }]
  }
}
```

### Always run

The off-surface query runs on **every** live invocation (not only when on-surface
denies are 0). Rationale: it is one cheap projected query, the context is useful even
when on-surface findings exist ("5 FPs on surface, and separately 333 attacks blocked
off-surface"), and a stable output shape is simpler to reason about and test.

Offline mode (`--input <file>`) runs **no** second query — it partitions the single
provided dataset in memory into on-surface vs off-surface for the same summary, so
fixtures and tests exercise the partition logic without shelling out.

## Components / boundaries

- **`readOffSurfaceSummary(...)`** — new function owning Query 2: shell out, parse the
  tab-separated value output, partition by surface, tally. Pure-ish: takes the base
  filter + project + window + cfg, returns `OffSurfaceSummary`. Live path only.
- **`summarizeOffSurface(norms, cfg)`** — pure in-memory tally over already-normalized
  off-surface entries. Used by the offline (`--input`) path and unit-testable directly.
  `readOffSurfaceSummary` reuses the same tally so live and offline agree.
- **`main()`** wiring — call the appropriate path (live vs `--input`), attach result to
  `coverage.offSurface`.

## Error handling

- Query 2 failing (auth, transient gcloud error) must **not** abort the report. On
  failure, set `coverage.offSurface = { error: <message> }` (a distinct shape from a
  successful summary — the report-writer treats a present `error` as "liveness could not
  be determined", which is different from the feature being absent) and emit a stderr
  warning. The on-surface analysis is the primary deliverable and must still print.
- Tab-parsing must tolerate URLs that fail to parse (reuse `splitUrl`, which already
  falls back gracefully) and missing `regionCode` (bucket as `(unknown)`, matching the
  existing on-surface convention).

## Testing

- Extend `analyze.test.ts` with `--input` fixtures that contain a mix of on-surface and
  off-surface denies; assert the off-surface summary's `denies`, `distinctIps`,
  `topPaths`, `topCountries`, and surface partitioning.
- Add a fixture where everything is off-surface (the real-world zero-on-surface case) and
  assert on-surface analysis is empty while `offSurface.denies > 0`.
- `summarizeOffSurface` gets direct unit coverage; `readOffSurfaceSummary` (shell-out) is
  exercised only via the offline equivalent — no live gcloud in tests.

## Documentation

- Update `SKILL.md` "Output Shape" and "Producing the Report" to describe
  `coverage.offSurface` and instruct leading the report with the liveness line when
  on-surface denies are 0 ("0 false positives; WAF live, N denies off-surface — scanning").
