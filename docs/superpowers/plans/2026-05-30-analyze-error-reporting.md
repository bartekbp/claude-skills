# analyze-error-reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `gcloud-tools` sibling skill that produces a weekly-readable Cloud Error Reporting digest leading with NEW and spiking error groups, with a drill-down mode for full stacks.

**Architecture:** A zero-dependency `npx tsx analyze.ts` mints a token via `gcloud auth print-access-token`, calls the Error Reporting REST `groupStats.list` (pre-aggregated, few groups), slices `timedCounts` buckets into a current-vs-prior window, classifies each group (NEW/REAPPEARED/SPIKING/IMPROVED/RECURRING), derives logical GKE service names, trims representatives to a compact frame, and emits compact JSON. The LLM (SKILL.md) renders the report and judges severity. A `--group <id>` mode fetches full per-event stacks on demand.

**Tech Stack:** TypeScript run via `tsx` (Node 18+ global `fetch`), `node:test`, `node:util` `parseArgs`, `execFileSync` for the gcloud token. Zero runtime dependencies.

---

## File Structure

```
plugins/gcloud-tools/skills/analyze-error-reporting/
  analyze.ts                          # all logic + CLI (mirrors sibling analyze-cloud-armor)
  analyze.test.ts                     # node:test, imports pure functions
  fixtures/sample-error-groups.json   # generic groupStats export (digest tests)
  fixtures/sample-group-events.json   # generic events export (drill-down test)
  package.json
  tsconfig.json
  SKILL.md
```

All pure logic is exported from `analyze.ts` and unit-tested. `main()` only wires fetch → `buildDigest` → stdout. No config file (muting is server-side via `resolutionStatus`).

**Reference (read first):** the sibling `plugins/gcloud-tools/skills/analyze-cloud-armor/` — copy its `package.json`/`tsconfig.json` shape, its `execFileSync` error handling, and its `import.meta.url` direct-run guard.

---

### Task 1: Scaffold the skill directory

**Files:**
- Create: `plugins/gcloud-tools/skills/analyze-error-reporting/package.json`
- Create: `plugins/gcloud-tools/skills/analyze-error-reporting/tsconfig.json`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "analyze-error-reporting",
  "private": true,
  "type": "module",
  "description": "Weekly Cloud Error Reporting digest — leads with NEW and spiking error groups, with per-group drill-down.",
  "scripts": {
    "test": "tsx analyze.test.ts",
    "analyze": "tsx analyze.ts"
  },
  "devDependencies": {
    "@types/node": "^22",
    "tsx": "^4"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`** (identical to the sibling)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "types": ["node"],
    "strict": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "skipLibCheck": true
  },
  "include": ["*.ts"]
}
```

- [ ] **Step 3: Commit**

```bash
git add plugins/gcloud-tools/skills/analyze-error-reporting/package.json plugins/gcloud-tools/skills/analyze-error-reporting/tsconfig.json
git commit -m "chore(analyze-error-reporting): scaffold skill package"
```

---

### Task 2: Types + window helpers (TDD)

**Files:**
- Create: `plugins/gcloud-tools/skills/analyze-error-reporting/analyze.ts`
- Create: `plugins/gcloud-tools/skills/analyze-error-reporting/analyze.test.ts`

- [ ] **Step 1: Write the failing test** (create `analyze.test.ts`)

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseWindow,
  pickPeriod,
  pickBucket,
} from './analyze.ts';

const here = dirname(fileURLToPath(import.meta.url));

test('parseWindow understands h/d/w', () => {
  assert.equal(parseWindow('7d'), 604800);
  assert.equal(parseWindow('6h'), 21600);
  assert.equal(parseWindow('1w'), 604800);
  assert.throws(() => parseWindow('5x'));
});

test('pickPeriod picks the smallest period covering 2x the window', () => {
  assert.equal(pickPeriod(604800), 'PERIOD_30_DAYS'); // 7d -> need 14d -> 30d period
  assert.equal(pickPeriod(21600), 'PERIOD_1_DAY');     // 6h -> need 12h -> 1d period
  assert.equal(pickPeriod(3600), 'PERIOD_6_HOURS');    // 1h -> need 2h -> 6h period
  assert.throws(() => pickPeriod(20 * 86400));          // > ~15d cannot be covered
});

test('pickBucket divides the window and stays API-aligned', () => {
  assert.equal(pickBucket(604800), 86400); // 7d -> daily buckets
  assert.equal(pickBucket(21600), 3600);   // 6h -> hourly buckets
  assert.equal(pickBucket(86400), 86400);  // 1d -> daily buckets
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/gcloud-tools/skills/analyze-error-reporting && npx tsx analyze.test.ts`
Expected: FAIL — cannot find module `./analyze.ts` / exports undefined.

- [ ] **Step 3: Write minimal implementation** (create `analyze.ts`)

```ts
/**
 * analyze-error-reporting — a weekly-readable Cloud Error Reporting digest.
 *
 * Fetches the rare, fully-fetchable, pre-aggregated signal (error GROUP stats), never raw
 * error logs. From one pull it slices `timedCounts` buckets into a current vs prior window,
 * classifies each group (NEW / REAPPEARED / SPIKING / IMPROVED / RECURRING), derives the
 * logical GKE service name, and trims each representative event to a compact frame. The
 * model renders the report; full stacks are fetched on demand via --group.
 *
 * Zero runtime dependencies. Run with: npx tsx analyze.ts [options]
 * Data source: Error Reporting REST API (live) or a JSON file (--input, for testing).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

// ---------- Raw API types ----------

export interface RawTimedCount {
  count?: string;
  startTime?: string;
  endTime?: string;
}
export interface RawServiceContext {
  service?: string;
  version?: string;
  resourceType?: string;
}
export interface RawGroupStat {
  group?: { groupId?: string; name?: string; resolutionStatus?: string };
  count?: string;
  affectedUsersCount?: string;
  timedCounts?: RawTimedCount[];
  firstSeenTime?: string;
  lastSeenTime?: string;
  affectedServices?: RawServiceContext[];
  numAffectedServices?: number;
  representative?: { eventTime?: string; serviceContext?: RawServiceContext; message?: string };
}
export interface RawEvent {
  eventTime?: string;
  serviceContext?: RawServiceContext;
  message?: string;
}

// ---------- Window helpers ----------

const PERIODS: { period: string; seconds: number }[] = [
  { period: 'PERIOD_1_HOUR', seconds: 3600 },
  { period: 'PERIOD_6_HOURS', seconds: 21600 },
  { period: 'PERIOD_1_DAY', seconds: 86400 },
  { period: 'PERIOD_1_WEEK', seconds: 604800 },
  { period: 'PERIOD_30_DAYS', seconds: 2592000 },
];

/** Parse a window like "7d" / "6h" / "1w" into seconds. */
export function parseWindow(s: string): number {
  const m = /^(\d+)([hdw])$/.exec(s);
  if (!m) throw new Error(`invalid --window "${s}" — use e.g. 6h, 7d, 1w`);
  const unit: Record<string, number> = { h: 3600, d: 86400, w: 604800 };
  return Number(m[1]) * unit[m[2]];
}

/** Smallest fixed API period that covers 2x the window (current + prior). */
export function pickPeriod(windowSec: number): string {
  const need = windowSec * 2;
  const p = PERIODS.find((x) => x.seconds >= need);
  if (!p) throw new Error(`--window too large (${windowSec}s); max ~15d, since the 30d period must cover 2x the window`);
  return p.period;
}

/** Bucket duration that divides the window so buckets align to the cutoff. */
export function pickBucket(windowSec: number): number {
  for (const c of [86400, 21600, 3600]) if (windowSec % c === 0) return c;
  return 3600;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx analyze.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/gcloud-tools/skills/analyze-error-reporting/analyze.ts plugins/gcloud-tools/skills/analyze-error-reporting/analyze.test.ts
git commit -m "feat(analyze-error-reporting): window/period helpers"
```

---

### Task 3: Logical service derivation (TDD)

**Files:**
- Modify: `analyze.ts` (append), `analyze.test.ts` (append)

- [ ] **Step 1: Write the failing test** (append to `analyze.test.ts`)

```ts
import { stripPodSuffix, logicalService } from './analyze.ts';

test('stripPodSuffix recovers the workload name from a GKE pod name', () => {
  assert.equal(stripPodSuffix('checkout-service-67566c4cf7-vzdtj'), 'checkout-service');
  assert.equal(stripPodSuffix('widget-service-5d8f7c6b4a-rk2mn'), 'widget-service');
  assert.equal(stripPodSuffix('payments-worker-0'), 'payments-worker'); // statefulset ordinal
  assert.equal(stripPodSuffix('billing'), 'billing');                   // no suffix -> unchanged
});

test('logicalService derives GKE names but leaves non-GKE services as-is', () => {
  assert.equal(
    logicalService({ service: 'gke_instances', version: 'checkout-service-67566c4cf7-vzdtj', resourceType: 'k8s_container' }),
    'checkout-service',
  );
  assert.equal(
    logicalService({ service: 'web-frontend', version: '00031-abc', resourceType: 'cloud_run_revision' }),
    'web-frontend',
  );
  assert.equal(logicalService(undefined), '(unknown)');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx analyze.test.ts`
Expected: FAIL — `stripPodSuffix`/`logicalService` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `analyze.ts`)

```ts
// ---------- Logical service name ----------

/**
 * Recover the workload name from a GKE pod name. Deployment pods look like
 * `<name>-<replicaset-hash>-<pod-hash>` (pod-hash is 5 chars); StatefulSet pods look like
 * `<name>-<ordinal>`. The raw value stays available to callers; this is only for rollups.
 */
export function stripPodSuffix(name: string): string {
  const deploy = /^(.+)-[a-z0-9]{4,10}-[a-z0-9]{5}$/.exec(name);
  if (deploy) return deploy[1];
  const sts = /^(.+)-\d+$/.exec(name);
  if (sts) return sts[1];
  return name;
}

/** Logical service name for rollups. GKE reports service="gke_instances"; the real name is the pod prefix. */
export function logicalService(svc?: RawServiceContext): string {
  if (!svc) return '(unknown)';
  if (svc.service === 'gke_instances' && svc.version) return stripPodSuffix(svc.version);
  return svc.service || '(unknown)';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx analyze.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/gcloud-tools/skills/analyze-error-reporting/analyze.ts plugins/gcloud-tools/skills/analyze-error-reporting/analyze.test.ts
git commit -m "feat(analyze-error-reporting): derive logical GKE service names"
```

---

### Task 4: Representative frame extraction (TDD)

**Files:**
- Modify: `analyze.ts` (append), `analyze.test.ts` (append)

- [ ] **Step 1: Write the failing test** (append to `analyze.test.ts`)

```ts
import { extractFrame } from './analyze.ts';

test('extractFrame returns a compact kind line and the first code frame', () => {
  const java =
    'NullPointerException: cannot invoke "Order.total()"\n' +
    '\tat com.example.OrderService.placeOrder(OrderService.java:142)\n' +
    '\tat com.example.web.Handler.handle(Handler.java:33)';
  assert.deepEqual(extractFrame(java), {
    kind: 'NullPointerException: cannot invoke "Order.total()"',
    where: 'OrderService.java:142',
  });

  const go = 'panic: runtime error: index out of range [3]\n\tsearch/query.go:88 +0x1a5';
  assert.equal(extractFrame(go).where, 'search/query.go:88');

  // Python puts the exception type LAST — use it as the kind, not "Traceback ...".
  const py =
    'Traceback (most recent call last):\n' +
    '  File "app/handlers.py", line 88, in process\n' +
    '    validate(payload)\n' +
    'ValueError: bad input';
  const f = extractFrame(py);
  assert.equal(f.kind, 'ValueError: bad input');
  assert.equal(f.where, 'app/handlers.py:88');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx analyze.test.ts`
Expected: FAIL — `extractFrame` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `analyze.ts`)

```ts
// ---------- Representative frame ----------

// Patterns that locate a single code frame across common runtimes. Each returns either one
// capture group ("File.java:42") or two ("path.py" + "88") which are joined with ":".
const FRAME_PATTERNS: RegExp[] = [
  /\bat\s+[\w.$<>]+\(([^)\s]+:\d+)\)/, // Java/Kotlin: at a.b.C.m(C.java:42)
  /\bat\s+[^(]*\(([^)\s]+:\d+:\d+)\)/, // Node: at fn (/p/f.js:10:5)
  /File "([^"]+)", line (\d+)/,         // Python: File "x.py", line 5
  /(\/?[\w./\-]+\.go:\d+)/,             // Go: path/file.go:123
  /([\w./\-]+\.[a-z]{1,4}:\d+)/,        // generic file.ext:line
];

function matchFrame(line: string): string {
  for (const re of FRAME_PATTERNS) {
    const m = re.exec(line);
    if (m) return m[2] ? `${m[1]}:${m[2]}` : m[1];
  }
  return '';
}

/**
 * Reduce a representative message to a compact, triage-sized fingerprint: a `kind` (the
 * exception/first line, or the last line for Python tracebacks) and `where` (the first code
 * frame). Full stacks are never carried in the digest — fetch them via --group when needed.
 */
export function extractFrame(message: string): { kind: string; where: string } {
  const lines = (message ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return { kind: '', where: '' };

  let kind = lines[0].slice(0, 160);
  if (/^Traceback \(most recent call last\)/.test(kind)) {
    kind = lines[lines.length - 1].slice(0, 160); // Python: exception type is on the last line
  }

  let where = '';
  for (const line of lines) {
    where = matchFrame(line);
    if (where && where !== kind) break; // skip a frame that is just the kind line itself
    where = where && where !== kind ? where : '';
  }
  return { kind, where };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx analyze.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/gcloud-tools/skills/analyze-error-reporting/analyze.ts plugins/gcloud-tools/skills/analyze-error-reporting/analyze.test.ts
git commit -m "feat(analyze-error-reporting): compact representative frame extraction"
```

---

### Task 5: Window summing, classification, trend (TDD)

**Files:**
- Modify: `analyze.ts` (append), `analyze.test.ts` (append)

- [ ] **Step 1: Write the failing test** (append to `analyze.test.ts`)

```ts
import { sumWindows, classify, trendPct } from './analyze.ts';

const ASOF = Date.parse('2026-05-30T00:00:00Z');
const WIN = 604800; // 7d
const CUR_START = ASOF - WIN * 1000;

test('sumWindows splits timedCounts into current vs prior at the cutoff', () => {
  const buckets = [
    { count: '100', endTime: '2026-05-20T00:00:00Z' }, // prior window
    { count: '500', endTime: '2026-05-28T00:00:00Z' }, // current window
    { count: '5', endTime: '2026-05-10T00:00:00Z' },   // older than prior -> ignored
  ];
  assert.deepEqual(sumWindows(buckets, ASOF, WIN), { current: 500, prior: 100 });
});

test('classify labels NEW/REAPPEARED/SPIKING/IMPROVED/RECURRING', () => {
  const opts = { spikeRatio: 2, minCount: 10 };
  const newFirst = Date.parse('2026-05-26T00:00:00Z');
  const oldFirst = Date.parse('2025-01-01T00:00:00Z');
  assert.equal(classify({ current: 80, prior: 0 }, newFirst, CUR_START, opts), 'NEW');
  assert.equal(classify({ current: 80, prior: 0 }, oldFirst, CUR_START, opts), 'REAPPEARED');
  assert.equal(classify({ current: 500, prior: 100 }, oldFirst, CUR_START, opts), 'SPIKING');
  assert.equal(classify({ current: 20, prior: 200 }, oldFirst, CUR_START, opts), 'IMPROVED');
  assert.equal(classify({ current: 160, prior: 150 }, oldFirst, CUR_START, opts), 'RECURRING');
});

test('trendPct is null when prior is zero, else rounded percent change', () => {
  assert.equal(trendPct({ current: 80, prior: 0 }), null);
  assert.equal(trendPct({ current: 500, prior: 100 }), 400);
  assert.equal(trendPct({ current: 20, prior: 200 }), -90);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx analyze.test.ts`
Expected: FAIL — `sumWindows`/`classify`/`trendPct` not exported.

- [ ] **Step 3: Write minimal implementation** (append to `analyze.ts`)

```ts
// ---------- Windowing & classification ----------

export interface WindowCounts {
  current: number;
  prior: number;
}

/** Sum timedCounts into the current window (asOf-window, asOf] and the prior window before it. */
export function sumWindows(buckets: RawTimedCount[] | undefined, asOfMs: number, windowSec: number): WindowCounts {
  const currentStart = asOfMs - windowSec * 1000;
  const priorStart = asOfMs - 2 * windowSec * 1000;
  let current = 0;
  let prior = 0;
  for (const b of buckets ?? []) {
    if (!b.endTime) continue;
    const t = Date.parse(b.endTime);
    const c = Number(b.count ?? '0');
    if (t > currentStart) current += c;
    else if (t > priorStart) prior += c;
  }
  return { current, prior };
}

export type Status = 'NEW' | 'REAPPEARED' | 'SPIKING' | 'IMPROVED' | 'RECURRING';
export interface ClassifyOpts {
  spikeRatio: number;
  minCount: number;
}

/** Classify a group from its window counts and first-seen time. Order matters. */
export function classify(w: WindowCounts, firstSeenMs: number, currentStartMs: number, opts: ClassifyOpts): Status {
  if (firstSeenMs >= currentStartMs) return 'NEW';
  if (w.prior === 0 && w.current > 0) return 'REAPPEARED';
  if (w.prior >= opts.minCount && w.current <= 0.5 * w.prior) return 'IMPROVED';
  if (w.current >= opts.minCount && w.current >= opts.spikeRatio * w.prior) return 'SPIKING';
  return 'RECURRING';
}

/** Percent change current vs prior; null when prior is 0 (NEW/REAPPEARED — undefined trend). */
export function trendPct(w: WindowCounts): number | null {
  if (w.prior === 0) return null;
  return Math.round(((w.current - w.prior) / w.prior) * 100);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx analyze.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/gcloud-tools/skills/analyze-error-reporting/analyze.ts plugins/gcloud-tools/skills/analyze-error-reporting/analyze.test.ts
git commit -m "feat(analyze-error-reporting): window summing, classification, trend"
```

---

### Task 6: Digest assembly + generic fixture (TDD)

**Files:**
- Create: `fixtures/sample-error-groups.json`
- Modify: `analyze.ts` (append), `analyze.test.ts` (append)

- [ ] **Step 1: Create the generic fixture** `fixtures/sample-error-groups.json`

Five groups exercising every status + a RESOLVED group that must be filtered. Generic data only (`example.com`, neutral service names). `asOf` resolves to `2026-05-30T00:00:00Z` (latest bucket endTime).

```json
[
  {
    "group": { "groupId": "grpCheckoutNPE", "resolutionStatus": "OPEN" },
    "timedCounts": [
      { "count": "100", "startTime": "2026-05-19T00:00:00Z", "endTime": "2026-05-20T00:00:00Z" },
      { "count": "500", "startTime": "2026-05-29T00:00:00Z", "endTime": "2026-05-30T00:00:00Z" }
    ],
    "firstSeenTime": "2025-11-02T10:00:00Z",
    "lastSeenTime": "2026-05-30T00:00:00Z",
    "numAffectedServices": 3,
    "affectedServices": [
      { "service": "gke_instances", "version": "checkout-service-67566c4cf7-vzdtj", "resourceType": "k8s_container" },
      { "service": "gke_instances", "version": "checkout-service-67566c4cf7-aa1bc", "resourceType": "k8s_container" }
    ],
    "representative": {
      "eventTime": "2026-05-29T12:00:00Z",
      "serviceContext": { "service": "gke_instances", "version": "checkout-service-67566c4cf7-vzdtj", "resourceType": "k8s_container" },
      "message": "NullPointerException: cannot invoke \"Order.total()\"\n\tat com.example.OrderService.placeOrder(OrderService.java:142)\n\tat com.example.web.Handler.handle(Handler.java:33)"
    }
  },
  {
    "group": { "groupId": "grpSearchPanic", "resolutionStatus": "OPEN" },
    "timedCounts": [
      { "count": "80", "startTime": "2026-05-28T00:00:00Z", "endTime": "2026-05-29T00:00:00Z" }
    ],
    "firstSeenTime": "2026-05-26T08:30:00Z",
    "lastSeenTime": "2026-05-29T00:00:00Z",
    "numAffectedServices": 1,
    "affectedServices": [
      { "service": "gke_instances", "version": "search-api-7d9f8c6b5b-q2x9z", "resourceType": "k8s_container" }
    ],
    "representative": {
      "eventTime": "2026-05-28T09:00:00Z",
      "serviceContext": { "service": "gke_instances", "version": "search-api-7d9f8c6b5b-q2x9z", "resourceType": "k8s_container" },
      "message": "panic: runtime error: index out of range [3] with length 3\n\tsearch/query.go:88 +0x1a5\n\tsearch/handler.go:21 +0x44"
    }
  },
  {
    "group": { "groupId": "grpFrontendVal", "resolutionStatus": "ACKNOWLEDGED" },
    "timedCounts": [
      { "count": "200", "startTime": "2026-05-18T00:00:00Z", "endTime": "2026-05-19T00:00:00Z" },
      { "count": "20", "startTime": "2026-05-26T00:00:00Z", "endTime": "2026-05-27T00:00:00Z" }
    ],
    "firstSeenTime": "2025-08-01T00:00:00Z",
    "lastSeenTime": "2026-05-27T00:00:00Z",
    "numAffectedServices": 1,
    "affectedServices": [
      { "service": "web-frontend", "version": "00031-abc", "resourceType": "cloud_run_revision" }
    ],
    "representative": {
      "eventTime": "2026-05-26T10:00:00Z",
      "serviceContext": { "service": "web-frontend", "version": "00031-abc", "resourceType": "cloud_run_revision" },
      "message": "Traceback (most recent call last):\n  File \"app/handlers.py\", line 88, in process\n    validate(payload)\nValueError: invalid checkout payload"
    }
  },
  {
    "group": { "groupId": "grpPayTimeout", "resolutionStatus": "OPEN" },
    "timedCounts": [
      { "count": "150", "startTime": "2026-05-17T00:00:00Z", "endTime": "2026-05-18T00:00:00Z" },
      { "count": "160", "startTime": "2026-05-25T00:00:00Z", "endTime": "2026-05-26T00:00:00Z" }
    ],
    "firstSeenTime": "2025-03-01T00:00:00Z",
    "lastSeenTime": "2026-05-26T00:00:00Z",
    "numAffectedServices": 2,
    "affectedServices": [
      { "service": "gke_instances", "version": "payments-worker-0", "resourceType": "k8s_container" }
    ],
    "representative": {
      "eventTime": "2026-05-25T11:00:00Z",
      "serviceContext": { "service": "gke_instances", "version": "payments-worker-0", "resourceType": "k8s_container" },
      "message": "context deadline exceeded\n\tpayments/ledger.go:212 +0x88"
    }
  },
  {
    "group": { "groupId": "grpLegacyResolved", "resolutionStatus": "RESOLVED" },
    "timedCounts": [
      { "count": "999", "startTime": "2026-05-28T00:00:00Z", "endTime": "2026-05-29T00:00:00Z" }
    ],
    "firstSeenTime": "2024-01-01T00:00:00Z",
    "lastSeenTime": "2026-05-29T00:00:00Z",
    "numAffectedServices": 1,
    "affectedServices": [
      { "service": "gke_instances", "version": "legacy-service-abc12-defgh", "resourceType": "k8s_container" }
    ],
    "representative": {
      "message": "RuntimeException: deprecated path\n\tat com.example.Legacy.run(Legacy.java:9)"
    }
  }
]
```

- [ ] **Step 2: Write the failing test** (append to `analyze.test.ts`)

```ts
import { buildDigest, type RawGroupStat, type DigestOpts } from './analyze.ts';

const RAW: RawGroupStat[] = JSON.parse(readFileSync(join(here, 'fixtures/sample-error-groups.json'), 'utf8'));
const BASE_OPTS: DigestOpts = {
  windowSec: 604800,
  windowLabel: '7d',
  bucketSec: 86400,
  periodUsed: 'PERIOD_30_DAYS',
  resolutionFilter: ['OPEN', 'ACKNOWLEDGED'],
  serviceFilter: null,
  spikeRatio: 2,
  minCount: 10,
  truncated: false,
  leadCap: 15,
};
const digest = buildDigest(RAW, BASE_OPTS);

test('resolved groups are filtered out; four groups reported', () => {
  assert.equal(digest.summary.groups, 4);
  assert.ok(!digest.groups.some((g) => g.groupId === 'grpLegacyResolved'));
});

test('summary counts each status', () => {
  assert.equal(digest.summary.new, 1);      // search-api
  assert.equal(digest.summary.spiking, 1);  // checkout
  assert.equal(digest.summary.improved, 1); // web-frontend
});

test('window math: checkout current=500 prior=100', () => {
  const c = digest.groups.find((g) => g.groupId === 'grpCheckoutNPE')!;
  assert.equal(c.current, 500);
  assert.equal(c.prior, 100);
  assert.equal(c.trendPct, 400);
  assert.equal(c.status, 'SPIKING');
});

test('leads are NEW + SPIKING, sorted by current desc', () => {
  assert.deepEqual(digest.leads.map((l) => l.groupId), ['grpCheckoutNPE', 'grpSearchPanic']);
  assert.equal(digest.leads[0].status, 'SPIKING');
});

test('byService uses derived logical names, never gke_instances', () => {
  const names = digest.byService.map((s) => s.service);
  for (const n of ['checkout-service', 'search-api', 'web-frontend', 'payments-worker']) assert.ok(names.includes(n), n);
  assert.ok(!names.includes('gke_instances'));
});

test('frame carries kind + top code location only (not the whole stack)', () => {
  const c = digest.groups.find((g) => g.groupId === 'grpCheckoutNPE')!;
  assert.match(c.frame.kind, /NullPointerException/);
  assert.equal(c.frame.where, 'OrderService.java:142');
  assert.ok(!JSON.stringify(c).includes('Handler.java:33'), 'only the top frame is kept');
});

test('coverage honesty fields are populated', () => {
  assert.equal(digest.meta.coverage.complete, true);
  assert.equal(digest.meta.coverage.groupsFetched, 5);
  assert.equal(digest.meta.coverage.groupsReported, 4);
  assert.equal(digest.meta.window.label, '7d');
  assert.equal(digest.meta.bucketGranularity, '1d');
});

test('service filter narrows to one logical service (post-deploy framing)', () => {
  const d = buildDigest(RAW, { ...BASE_OPTS, serviceFilter: 'checkout-service' });
  assert.equal(d.summary.groups, 1);
  assert.equal(d.groups[0].service, 'checkout-service');
});

test('include-resolved widens the filter to show RESOLVED groups', () => {
  const d = buildDigest(RAW, { ...BASE_OPTS, resolutionFilter: ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'MUTED'] });
  assert.ok(d.groups.some((g) => g.groupId === 'grpLegacyResolved'));
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx analyze.test.ts`
Expected: FAIL — `buildDigest`/`DigestOpts` not exported.

- [ ] **Step 4: Write minimal implementation** (append to `analyze.ts`)

```ts
// ---------- Digest assembly ----------

export interface GroupRow {
  groupId: string;
  service: string; // logical
  rawService: string;
  status: Status;
  current: number;
  prior: number;
  trendPct: number | null;
  firstSeen: string;
  lastSeen: string;
  affectedServices: number;
  resolutionStatus: string;
  frame: { kind: string; where: string };
}
export interface ServiceRollup {
  service: string;
  groups: number;
  new: number;
  current: number;
  prior: number;
  trendPct: number | null;
}
export interface Digest {
  meta: {
    window: { from: string; to: string; label: string };
    priorWindow: { from: string; to: string };
    bucketGranularity: string;
    resolutionFilter: string[];
    serviceFilter: string | null;
    coverage: { groupsFetched: number; groupsReported: number; complete: boolean; periodUsed: string };
  };
  summary: {
    groups: number;
    new: number;
    spiking: number;
    improved: number;
    reappeared: number;
    totalCurrent: number;
    totalPrior: number;
  };
  byService: ServiceRollup[];
  leads: GroupRow[];
  groups: GroupRow[];
}
export interface DigestOpts {
  windowSec: number;
  windowLabel: string;
  bucketSec: number;
  periodUsed: string;
  resolutionFilter: string[]; // statuses to KEEP
  serviceFilter: string | null; // exact logical-service match, or null
  spikeRatio: number;
  minCount: number;
  truncated: boolean;
  leadCap: number;
}

function durLabel(sec: number): string {
  if (sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  return `${sec}s`;
}

export function buildDigest(raw: RawGroupStat[], opts: DigestOpts): Digest {
  // Reference time = the most recent bucket endTime across all groups (≈ now for live data).
  let asOfMs = 0;
  for (const g of raw) for (const b of g.timedCounts ?? []) if (b.endTime) asOfMs = Math.max(asOfMs, Date.parse(b.endTime));
  if (asOfMs === 0) asOfMs = Date.now();

  const currentStart = asOfMs - opts.windowSec * 1000;
  const priorStart = asOfMs - 2 * opts.windowSec * 1000;
  const keep = new Set(opts.resolutionFilter);

  const rows: GroupRow[] = [];
  for (const g of raw) {
    const resolution = g.group?.resolutionStatus ?? 'OPEN';
    if (!keep.has(resolution)) continue;
    const w = sumWindows(g.timedCounts, asOfMs, opts.windowSec);
    if (w.current === 0 && w.prior === 0) continue; // nothing in either window
    const svcCtx = g.representative?.serviceContext ?? g.affectedServices?.[0];
    const service = logicalService(svcCtx);
    if (opts.serviceFilter && service !== opts.serviceFilter) continue;
    const firstSeenMs = g.firstSeenTime ? Date.parse(g.firstSeenTime) : 0;
    rows.push({
      groupId: g.group?.groupId ?? '',
      service,
      rawService: svcCtx?.service ?? '',
      status: classify(w, firstSeenMs, currentStart, { spikeRatio: opts.spikeRatio, minCount: opts.minCount }),
      current: w.current,
      prior: w.prior,
      trendPct: trendPct(w),
      firstSeen: g.firstSeenTime ?? '',
      lastSeen: g.lastSeenTime ?? '',
      affectedServices: g.numAffectedServices ?? g.affectedServices?.length ?? 0,
      resolutionStatus: resolution,
      frame: extractFrame(g.representative?.message ?? ''),
    });
  }

  rows.sort((a, b) => b.current - a.current);

  const svcMap = new Map<string, { groups: number; new: number; current: number; prior: number }>();
  for (const r of rows) {
    const e = svcMap.get(r.service) ?? svcMap.set(r.service, { groups: 0, new: 0, current: 0, prior: 0 }).get(r.service)!;
    e.groups++;
    if (r.status === 'NEW') e.new++;
    e.current += r.current;
    e.prior += r.prior;
  }
  const byService: ServiceRollup[] = [...svcMap.entries()]
    .map(([service, v]) => ({ service, groups: v.groups, new: v.new, current: v.current, prior: v.prior, trendPct: trendPct(v) }))
    .sort((a, b) => b.current - a.current);

  const leads = rows.filter((r) => r.status === 'NEW' || r.status === 'SPIKING').slice(0, opts.leadCap);

  const iso = (ms: number) => new Date(ms).toISOString();
  return {
    meta: {
      window: { from: iso(currentStart), to: iso(asOfMs), label: opts.windowLabel },
      priorWindow: { from: iso(priorStart), to: iso(currentStart) },
      bucketGranularity: durLabel(opts.bucketSec),
      resolutionFilter: opts.resolutionFilter,
      serviceFilter: opts.serviceFilter,
      coverage: { groupsFetched: raw.length, groupsReported: rows.length, complete: !opts.truncated, periodUsed: opts.periodUsed },
    },
    summary: {
      groups: rows.length,
      new: rows.filter((r) => r.status === 'NEW').length,
      spiking: rows.filter((r) => r.status === 'SPIKING').length,
      improved: rows.filter((r) => r.status === 'IMPROVED').length,
      reappeared: rows.filter((r) => r.status === 'REAPPEARED').length,
      totalCurrent: rows.reduce((s, r) => s + r.current, 0),
      totalPrior: rows.reduce((s, r) => s + r.prior, 0),
    },
    byService,
    leads,
    groups: rows,
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx analyze.test.ts`
Expected: PASS (all digest tests).

- [ ] **Step 6: Commit**

```bash
git add plugins/gcloud-tools/skills/analyze-error-reporting/analyze.ts plugins/gcloud-tools/skills/analyze-error-reporting/analyze.test.ts plugins/gcloud-tools/skills/analyze-error-reporting/fixtures/sample-error-groups.json
git commit -m "feat(analyze-error-reporting): digest assembly + rollups with generic fixture"
```

---

### Task 7: Drill-down formatting (TDD)

**Files:**
- Create: `fixtures/sample-group-events.json`
- Modify: `analyze.ts` (append), `analyze.test.ts` (append)

- [ ] **Step 1: Create the generic events fixture** `fixtures/sample-group-events.json`

```json
[
  {
    "eventTime": "2026-05-29T12:00:00Z",
    "serviceContext": { "service": "gke_instances", "version": "checkout-service-67566c4cf7-vzdtj", "resourceType": "k8s_container" },
    "message": "NullPointerException: cannot invoke \"Order.total()\"\n\tat com.example.OrderService.placeOrder(OrderService.java:142)\n\tat com.example.web.Handler.handle(Handler.java:33)"
  },
  {
    "eventTime": "2026-05-29T12:05:00Z",
    "serviceContext": { "service": "gke_instances", "version": "checkout-service-67566c4cf7-aa1bc", "resourceType": "k8s_container" },
    "message": "NullPointerException: cannot invoke \"Order.total()\"\n\tat com.example.OrderService.placeOrder(OrderService.java:142)\n\tat com.example.web.Handler.handle(Handler.java:51)"
  }
]
```

- [ ] **Step 2: Write the failing test** (append to `analyze.test.ts`)

```ts
import { formatEvents, type RawEvent } from './analyze.ts';

test('formatEvents derives service and preserves the full message for drill-down', () => {
  const evs: RawEvent[] = JSON.parse(readFileSync(join(here, 'fixtures/sample-group-events.json'), 'utf8'));
  const out = formatEvents(evs);
  assert.equal(out.length, 2);
  assert.equal(out[0].service, 'checkout-service');
  assert.ok(out[0].message.includes('OrderService.java:142'));
  assert.ok(out[0].message.includes('Handler.java:33')); // drill-down keeps the WHOLE stack
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx tsx analyze.test.ts`
Expected: FAIL — `formatEvents` not exported.

- [ ] **Step 4: Write minimal implementation** (append to `analyze.ts`)

```ts
// ---------- Drill-down ----------

export interface ExampleEvent {
  eventTime: string;
  service: string;
  message: string; // full stack — drill-down is the one place raw stacks enter context, on request
}

export function formatEvents(events: RawEvent[]): ExampleEvent[] {
  return events.map((e) => ({
    eventTime: e.eventTime ?? '',
    service: logicalService(e.serviceContext),
    message: e.message ?? '',
  }));
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx tsx analyze.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add plugins/gcloud-tools/skills/analyze-error-reporting/analyze.ts plugins/gcloud-tools/skills/analyze-error-reporting/analyze.test.ts plugins/gcloud-tools/skills/analyze-error-reporting/fixtures/sample-group-events.json
git commit -m "feat(analyze-error-reporting): drill-down event formatting"
```

---

### Task 8: Fetch layer + CLI wiring

**Files:**
- Modify: `analyze.ts` (append fetch helpers + `main`)

No unit test — this is I/O wiring, verified by the offline `--input` run and the live dogfood in Task 10.

- [ ] **Step 1: Append the fetch layer and `main` to `analyze.ts`**

```ts
// ---------- Data source (Error Reporting REST API) ----------

const API = 'https://clouderrorreporting.googleapis.com/v1beta1';
const PAGE_SIZE = 200;
const MAX_PAGES = 25; // backstop; error groups are few — one page is typical
const EVENTS_PAGE_SIZE = 5; // a few example stacks per group for drill-down

function accessToken(): string {
  try {
    return execFileSync('gcloud', ['auth', 'print-access-token'], { encoding: 'utf8' }).trim();
  } catch (err: unknown) {
    const e = err as { code?: string; stderr?: Buffer | string; message?: string };
    if (e.code === 'ENOENT') {
      throw new Error(
        'gcloud CLI not found on PATH. Install the Google Cloud SDK ' +
          '(https://cloud.google.com/sdk/docs/install), then run `gcloud auth login`.',
      );
    }
    const stderr = e.stderr ? e.stderr.toString().trim() : '';
    throw new Error(`could not get an access token (run \`gcloud auth login\`): ${stderr || e.message || String(err)}`);
  }
}

async function apiGet(path: string, params: Record<string, string>, tok: string): Promise<any> {
  const url = `${API}/${path}?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`Error Reporting API ${res.status} on ${path}: ${body}`);
  }
  return res.json();
}

async function fetchGroupStats(
  project: string,
  period: string,
  bucketSec: number,
  tok: string,
): Promise<{ groups: RawGroupStat[]; truncated: boolean }> {
  const groups: RawGroupStat[] = [];
  let pageToken: string | undefined;
  let pages = 0;
  do {
    const params: Record<string, string> = {
      'timeRange.period': period,
      timedCountDuration: `${bucketSec}s`,
      order: 'COUNT_DESC',
      pageSize: String(PAGE_SIZE),
    };
    if (pageToken) params.pageToken = pageToken;
    const j = await apiGet(`projects/${project}/groupStats`, params, tok);
    groups.push(...((j.errorGroupStats ?? []) as RawGroupStat[]));
    pageToken = j.nextPageToken;
    pages++;
  } while (pageToken && pages < MAX_PAGES);
  return { groups, truncated: !!pageToken };
}

async function fetchEvents(project: string, groupId: string, period: string, tok: string): Promise<RawEvent[]> {
  const j = await apiGet(`projects/${project}/events`, { groupId, 'timeRange.period': period, pageSize: String(EVENTS_PAGE_SIZE) }, tok);
  return (j.errorEvents ?? []) as RawEvent[];
}

// ---------- CLI ----------

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      project: { type: 'string' },
      window: { type: 'string', default: '7d' },
      service: { type: 'string' }, // post-deploy framing: narrow to one logical service
      group: { type: 'string' }, // drill-down: full stacks for one group
      'include-resolved': { type: 'boolean', default: false },
      'spike-ratio': { type: 'string', default: '2' },
      'min-count': { type: 'string', default: '10' },
      'lead-cap': { type: 'string', default: '15' },
      input: { type: 'string' }, // offline JSON export (testing)
    },
  });

  const windowSec = parseWindow(values.window!);
  const period = pickPeriod(windowSec);
  const bucketSec = pickBucket(windowSec);

  // Drill-down mode.
  if (values.group) {
    if (!values.project) {
      process.stderr.write('error: --group requires --project\n');
      process.exit(2);
    }
    const events = await fetchEvents(values.project, values.group, period, accessToken());
    process.stdout.write(JSON.stringify({ group: values.group, examples: formatEvents(events) }, null, 2) + '\n');
    return;
  }

  // Digest mode.
  let raw: RawGroupStat[];
  let truncated = false;
  let source: string;
  if (values.input) {
    const parsed = JSON.parse(readFileSync(values.input, 'utf8'));
    raw = Array.isArray(parsed) ? (parsed as RawGroupStat[]) : ((parsed.errorGroupStats ?? []) as RawGroupStat[]);
    source = 'file';
  } else {
    if (!values.project) {
      process.stderr.write('error: --project is required (or use --input <file> for offline analysis).\n');
      process.exit(2);
    }
    const r = await fetchGroupStats(values.project, period, bucketSec, accessToken());
    raw = r.groups;
    truncated = r.truncated;
    source = 'gcloud';
  }

  const resolutionFilter = values['include-resolved']
    ? ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'MUTED']
    : ['OPEN', 'ACKNOWLEDGED'];

  const digest = buildDigest(raw, {
    windowSec,
    windowLabel: values.window!,
    bucketSec,
    periodUsed: period,
    resolutionFilter,
    serviceFilter: values.service ?? null,
    spikeRatio: Number(values['spike-ratio']),
    minCount: Number(values['min-count']),
    truncated,
    leadCap: Number(values['lead-cap']),
  });
  (digest.meta as Record<string, unknown>).source = source;
  process.stdout.write(JSON.stringify(digest, null, 2) + '\n');
}

// Run only when invoked directly, not when imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    process.stderr.write(`error: ${(err as Error)?.message ?? String(err)}\n`);
    process.exit(1);
  });
}
```

- [ ] **Step 2: Verify the test suite still passes** (imports must not trigger `main`)

Run: `npx tsx analyze.test.ts`
Expected: PASS — all prior tests green, no network call (the direct-run guard prevents `main` on import).

- [ ] **Step 3: Verify the offline digest end-to-end**

Run: `npx tsx analyze.ts --input fixtures/sample-error-groups.json`
Expected: JSON to stdout with `summary.groups: 4`, `leads` starting with `grpCheckoutNPE`, and `meta.coverage.complete: true`.

- [ ] **Step 4: Commit**

```bash
git add plugins/gcloud-tools/skills/analyze-error-reporting/analyze.ts
git commit -m "feat(analyze-error-reporting): REST fetch layer + CLI (digest, drill-down, offline)"
```

---

### Task 9: Write SKILL.md

**Files:**
- Create: `plugins/gcloud-tools/skills/analyze-error-reporting/SKILL.md`

- [ ] **Step 1: Write `SKILL.md`** (mirror the sibling's structure and tone)

````markdown
---
name: analyze-error-reporting
description: Use when you want a weekly-readable Cloud Error Reporting digest that leads with what is NEW or spiking — per error group count, trend vs the prior window, affected service, first/last seen, and a representative frame, rolled up by service. Also serves a post-deploy regression check (short window + one service). GCP-specific; requires the gcloud CLI.
---

# Analyze Error Reporting

## Overview

This skill produces a **weekly digest of Cloud Error Reporting** that leads with **what changed** — the error groups that are **NEW** or **spiking** — instead of the flat, count-sorted list a dashboard shows. Each group carries its **current-window count**, **trend vs the prior window**, **affected service**, **first/last seen**, and a **compact representative frame** (error kind + top code location). Findings roll up **by service** and **by status** (new vs recurring).

It reads only the **pre-aggregated error groups** via the Error Reporting REST API — never raw error logs. Groups are few and high-signal, so one pull is complete and cheap. A bundled zero-dependency script fetches the groups, slices their per-bucket counts into a current-vs-prior window, classifies and rolls them up, and emits compact JSON; you (the model) turn it into a ranked report and judge severity.

Full stacks are **not** in the digest (they are large and may carry PII). Fetch them on demand for one group with `--group`.

## When to Use

- A weekly "what's new or getting worse in errors" review (the primary use).
- A **post-deploy regression check**: `--window <since-deploy> --service <name>` compares the post-deploy window against the equal window before it, for one service.
- Feeding a weekly summary that combines error trends with other signals.

**Don't use when:** the project isn't on GCP / has no Error Reporting data, or you need individual-event forensics at scale (use the Logs Explorer / drill-down, not a digest).

## Prerequisites

- **Node.js** v18+ (for `npx tsx`, and for global `fetch`). `npx` ships with npm.
- **`gcloud` CLI**, authenticated with Error Reporting read access: `gcloud auth login` (the script calls `gcloud auth print-access-token`). The **Error Reporting API** must be enabled on the project.

No other install: `analyze.ts` has zero runtime dependencies and `npx` fetches `tsx` on demand.

## No config file

Unlike the sibling `analyze-cloud-armor`, this skill has **no per-project config**. Muting belongs in Error Reporting itself: the script reads each group's `resolutionStatus` and by default reports only `OPEN` and `ACKNOWLEDGED`, dropping `RESOLVED` and `MUTED`. To mute noise, resolve or mute the group in the Error Reporting UI. Pass `--include-resolved` to see everything.

## How to Run

Run from the skill's own directory (where `analyze.ts` lives), or use an absolute path.

```bash
# Weekly digest (default window 7d)
npx tsx analyze.ts --project my-project

# Custom window / thresholds
npx tsx analyze.ts --project my-project --window 14d --spike-ratio 3 --min-count 50

# Post-deploy regression check: last 6h vs the prior 6h, one service
npx tsx analyze.ts --project my-project --window 6h --service checkout-service

# Drill down into one group: full stacks from a few recent events
npx tsx analyze.ts --project my-project --group <groupId>

# Offline: analyze a saved export (also how the fixtures run)
npx tsx analyze.ts --input fixtures/sample-error-groups.json
```

Window is `Nh` / `Nd` / `Nw`, up to ~15 days (the API's 30-day period must cover twice the window). The script auto-selects the API period and bucket granularity.

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
               "firstSeen", "lastSeen", "affectedServices", "frame": { "kind", "where" } }],
  "groups": [ /* every reported group, same row shape, sorted by current desc */ ]
}
```

`leads` is the headline: **NEW + SPIKING** groups, biggest first. `frame.where` is the top code frame; `frame.kind` is the error kind. `trendPct` is `null` for NEW/REAPPEARED (no prior). Counts are bucket-granular (`meta.bucketGranularity`).

## Producing the Report

1. Run the script. If `meta.coverage.complete` is `false`, pagination hit the cap — say there may be more groups.
2. **Lead with `leads`** — the NEW and SPIKING groups. For each: status, logical service, current count, trend, first/last seen, and the `frame` (kind + where). This is the actionable headline; render it as a short table.
3. **Then `byService`** — which services carry the most error volume and the most new groups. Render sorted by `current`.
4. **Summarize `summary`** — totals and how many groups are new/spiking/improved. Note `totalCurrent` vs `totalPrior` for the overall direction.
5. **Do not dump every group.** `groups` is there for completeness; surface only what changed.
6. **To judge severity or compare against code, drill down:** rerun with `--group <groupId>` to pull a few full stacks, then reason about the cause (and, if asked, compare to the source).
7. Be honest about the window and granularity, and that `trendPct` is undefined for brand-new groups.

## Common Mistakes

- **Treating the digest as exhaustive event data.** It is group-level and bucket-granular; for individual events use `--group` or the Logs Explorer.
- **Reading `frame.kind` as the full error.** It is a trimmed one-liner for triage; the real stack is behind `--group`.
- **Muting in config.** There is none — mute/resolve in Error Reporting; the digest honors `resolutionStatus`.
- **Windows over ~15 days.** Not supported (the 30-day period must cover 2× the window); use a shorter window.

## Testing

`npx tsx analyze.test.ts` runs the analysis against generic fixtures. Run it after editing `analyze.ts`.
````

- [ ] **Step 2: Commit**

```bash
git add plugins/gcloud-tools/skills/analyze-error-reporting/SKILL.md
git commit -m "docs(analyze-error-reporting): SKILL.md"
```

---

### Task 10: Register, dogfood, NDA grep, finalize

**Files:**
- Modify: `plugins/gcloud-tools/.claude-plugin/plugin.json`
- Modify: `.claude-plugin/marketplace.json`

- [ ] **Step 1: Bump the plugin version and description** — edit `plugins/gcloud-tools/.claude-plugin/plugin.json`:
  - `"version": "0.1.0"` → `"version": "0.2.0"`
  - Replace `description` with:
    `"Skills that wrap the gcloud CLI to analyze Google Cloud operational and security signals — analyze-cloud-armor finds Cloud Armor WAF false positives, and analyze-error-reporting produces a weekly Cloud Error Reporting digest of new and spiking error groups."`

- [ ] **Step 2: Update the marketplace entry** — in `.claude-plugin/marketplace.json`, set the `gcloud-tools` plugin `description` to the same string as Step 1.

- [ ] **Step 3: NDA firewall grep — must return nothing**

Run (from repo root) a grep over the skill dir and these docs for any real customer/production
identifiers — the production project id, real service/pod names from the target cluster, and
any client- or industry-identifying words. Expected: nothing prints. If anything does, replace
it with generic data (`my-project`, `checkout-service`, …) before continuing.

- [ ] **Step 4: Full test run**

Run: `cd plugins/gcloud-tools/skills/analyze-error-reporting && npx tsx analyze.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Live dogfood** (keeps real data out of the repo — output is only read, never written into the tree)

Run: `npx tsx analyze.ts --project <your-project> --window 7d | head -60`
Expected: a valid digest; `summary`, `byService` with logical names (not `gke_instances`), `leads` populated, `meta.coverage.complete`. Spot-check one group with `--group <id>`. Do **not** save any output into the repo.

- [ ] **Step 6: Commit registration**

```bash
git add plugins/gcloud-tools/.claude-plugin/plugin.json .claude-plugin/marketplace.json
git commit -m "feat(gcloud-tools): register analyze-error-reporting; bump plugin to 0.2.0"
```

- [ ] **Step 7: Push and open the PR**

```bash
git push -u origin feat/analyze-error-reporting
gh pr create --repo bartekbp/claude-skills --base main --title "feat(gcloud-tools): add analyze-error-reporting skill" \
  --body "Adds analyze-error-reporting: a weekly Cloud Error Reporting digest leading with NEW/spiking groups, rolled up by service, with a --group drill-down. Sibling to analyze-cloud-armor. Pre-aggregated groupStats only (no raw log scans); no config file (muting via resolutionStatus); generic fixtures only. Bumps gcloud-tools to 0.2.0."
```

---

## Self-Review

**Spec coverage:**
- Weekly digest leading with NEW/spiking → Tasks 5–6 (`classify`, `leads`). ✓
- Per group: count, trend, service, first/last seen, representative frame → Task 6 `GroupRow`. ✓
- Rolled up by service + new-vs-recurring → Task 6 `byService`, `summary`. ✓
- Pre-aggregated groups only, no raw logs → Task 8 `fetchGroupStats`. ✓
- Post-deploy framing via flags → Task 8 `--window`/`--service`, Task 6 service-filter test. ✓
- Window/prior split from `timedCounts` → Task 5 `sumWindows`. ✓
- Logical GKE service derivation → Task 3. ✓
- Compact frame, full stacks via drill-down → Task 4 + Task 7. ✓
- No config file; muting via `resolutionStatus` → Task 6 filter, Task 9 docs. ✓
- Coverage honesty (window, granularity, truncation) → Task 6 `meta.coverage`. ✓
- NDA firewall / generic fixtures → Tasks 6,7 fixtures; Task 10 grep. ✓
- Registration + version bump → Task 10. ✓
- Branch → PR → merge → Task 10 push/PR. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command shows expected output. ✓

**Type consistency:** `RawGroupStat`, `RawEvent`, `RawTimedCount`, `RawServiceContext` defined in Task 2; `WindowCounts`/`Status`/`ClassifyOpts` in Task 5; `GroupRow`/`ServiceRollup`/`Digest`/`DigestOpts` in Task 6; `ExampleEvent` in Task 7. `sumWindows`, `classify`, `trendPct`, `logicalService`, `extractFrame`, `buildDigest`, `formatEvents` names are consistent across tasks and the CLI in Task 8. ✓
