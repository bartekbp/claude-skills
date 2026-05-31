# Cloud Armor Off-Surface Liveness Signal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When surface-scoped denies are 0, the report still proves the WAF is live by summarizing enforced denies happening *off* the legitimate surface (count, distinct IPs, top paths/countries).

**Architecture:** Add a second `gcloud` query (live) for all enforced denies with a reduced `value(url, regionCode, ip)` projection, partition client-side with the existing allowlist helpers, and report a shallow `coverage.offSurface` summary. Offline (`--input`) mode partitions the provided dataset in memory instead of shelling out. The existing on-surface analysis is untouched.

**Tech Stack:** TypeScript run via `tsx`, Node's built-in `node:test`, zero runtime dependencies, `gcloud logging read`.

**Commit policy:** Per the repo owner's preference for fewer, larger commits, do NOT commit per task. Implement and verify all tasks, then make a single commit in Task 6.

**Spec:** `docs/superpowers/specs/2026-05-31-cloud-armor-offsurface-liveness-design.md`

**Working directory for all commands:** `plugins/gcloud-tools/skills/analyze-cloud-armor/`

---

## File Structure

- **Modify** `plugins/gcloud-tools/skills/analyze-cloud-armor/analyze.ts`
  - New types: `OffSurfaceSummary`, `OffSurfaceResult`, `DenyRow`
  - New helper `surfaceMatches(host, path, cfg)`; refactor `onAllowedSurface` to use it
  - New pure functions `summarizeOffSurface(...)`, `parseOffSurfaceValues(...)`
  - New `execGcloud(args)` extracted from `readLogs`; new `readOffSurfaceSummary(...)`
  - `main()` wiring for both live and offline paths
- **Modify** `plugins/gcloud-tools/skills/analyze-cloud-armor/analyze.test.ts` — new unit tests
- **Modify** `plugins/gcloud-tools/skills/analyze-cloud-armor/fixtures/sample-armor-logs.json` — add four off-surface deny entries
- **Modify** `plugins/gcloud-tools/skills/analyze-cloud-armor/SKILL.md` — document `coverage.offSurface` and reporting guidance

---

## Task 1: Types + `surfaceMatches` helper

**Files:**
- Modify: `plugins/gcloud-tools/skills/analyze-cloud-armor/analyze.ts`

- [ ] **Step 1: Add the new exported types**

After the `Coverage` interface (around line 141), add:

```ts
/** Shallow liveness summary of enforced denies that are NOT on the allowed surface. */
export interface OffSurfaceSummary {
  denies: number; // count of off-surface enforced denies
  distinctIps: number;
  complete: boolean; // false if the fetch hit FETCH_LIMIT
  topPaths: { path: string; denies: number }[]; // top 5, most-blocked first
  topCountries: { country: string; denies: number }[]; // top 5, most-blocked first
}

/** Either a successful summary, or a recorded failure (liveness could not be determined). */
export type OffSurfaceResult = OffSurfaceSummary | { error: string };

/** Minimal projection of one enforced deny, shared by the live and offline paths. */
export interface DenyRow {
  host: string;
  path: string;
  ip: string;
  country: string; // raw regionCode, '' if absent (bucketed to '(unknown)' in the summary)
}
```

- [ ] **Step 2: Extract `surfaceMatches` and refactor `onAllowedSurface`**

Replace the existing `onAllowedSurface` (lines 217-219):

```ts
function onAllowedSurface(n: Norm, cfg: Config): boolean {
  return inAllowedDomain(n.host, cfg) && inAllowedPrefix(n.path, cfg);
}
```

with:

```ts
function surfaceMatches(host: string, path: string, cfg: Config): boolean {
  return inAllowedDomain(host, cfg) && inAllowedPrefix(path, cfg);
}

function onAllowedSurface(n: Norm, cfg: Config): boolean {
  return surfaceMatches(n.host, n.path, cfg);
}
```

- [ ] **Step 3: Verify existing tests still pass (no behavior change yet)**

Run: `npx tsx analyze.test.ts`
Expected: all existing tests PASS (the refactor is behavior-preserving).

---

## Task 2: `summarizeOffSurface` pure function

**Files:**
- Modify: `plugins/gcloud-tools/skills/analyze-cloud-armor/analyze.ts`
- Test: `plugins/gcloud-tools/skills/analyze-cloud-armor/analyze.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to the imports at the top of `analyze.test.ts` (extend the existing import from `./analyze.ts`):

```ts
import {
  aggregate,
  classifyValue,
  normalize,
  timeRange,
  summarizeOffSurface,
  parseOffSurfaceValues,
  type Config,
  type RawEntry,
  type DenyRow,
} from './analyze.ts';
```

Then append these tests:

```ts
test('off-surface summary counts only off-surface denies and tallies ips/paths/countries', () => {
  const cfg: Config = { allowedDomains: [], allowedPathPrefixes: ['/api/v2'] };
  const rows: DenyRow[] = [
    { host: 'h', path: '/api/v2/orders', ip: '1.1.1.1', country: 'PL' }, // on-surface → excluded
    { host: 'h', path: '/.env', ip: '2.2.2.2', country: 'US' },
    { host: 'h', path: '/.env', ip: '3.3.3.3', country: 'US' },
    { host: 'h', path: '/.git/config', ip: '2.2.2.2', country: '' }, // missing region
  ];
  const s = summarizeOffSurface(rows, cfg, true);
  assert.equal(s.denies, 3);
  assert.equal(s.distinctIps, 2); // 2.2.2.2 and 3.3.3.3
  assert.equal(s.complete, true);
  assert.deepEqual(s.topPaths[0], { path: '/.env', denies: 2 });
  assert.deepEqual(s.topCountries[0], { country: 'US', denies: 2 });
  assert.ok(s.topCountries.some((c) => c.country === '(unknown)' && c.denies === 1));
});

test('off-surface summary caps top lists at 5 and reports incompleteness', () => {
  const cfg: Config = { allowedDomains: [], allowedPathPrefixes: ['/api/v2'] };
  const rows: DenyRow[] = Array.from({ length: 7 }, (_, i) => ({
    host: 'h', path: `/p${i}`, ip: `9.9.9.${i}`, country: `C${i}`,
  }));
  const s = summarizeOffSurface(rows, cfg, false);
  assert.equal(s.denies, 7);
  assert.equal(s.topPaths.length, 5);
  assert.equal(s.topCountries.length, 5);
  assert.equal(s.complete, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx tsx analyze.test.ts`
Expected: FAIL — `summarizeOffSurface`/`parseOffSurfaceValues` not exported / not a function.

- [ ] **Step 3: Implement `summarizeOffSurface`**

In `analyze.ts`, in the "Aggregation" section (after `buildDenialDetail`, before `aggregate`), add:

```ts
const OFF_SURFACE_TOP_N = 5;

export function summarizeOffSurface(denyRows: DenyRow[], cfg: Config, complete: boolean): OffSurfaceSummary {
  const off = denyRows.filter((r) => !surfaceMatches(r.host, r.path, cfg));
  const ips = new Set<string>();
  const byPath = new Map<string, number>();
  const byCountry = new Map<string, number>();
  for (const r of off) {
    if (r.ip) ips.add(r.ip);
    if (r.path) byPath.set(r.path, (byPath.get(r.path) ?? 0) + 1);
    const c = r.country || '(unknown)';
    byCountry.set(c, (byCountry.get(c) ?? 0) + 1);
  }
  const topPaths = [...byPath.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, OFF_SURFACE_TOP_N)
    .map(([path, denies]) => ({ path, denies }));
  const topCountries = [...byCountry.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, OFF_SURFACE_TOP_N)
    .map(([country, denies]) => ({ country, denies }));
  return { denies: off.length, distinctIps: ips.size, complete, topPaths, topCountries };
}
```

- [ ] **Step 4: Run tests to verify the new ones pass and old ones still pass**

Run: `npx tsx analyze.test.ts`
Expected: the two off-surface tests PASS, but the `parseOffSurfaceValues`-dependent import still means Task 3's tests are absent — all *defined* tests should PASS. (If the import of `parseOffSurfaceValues` throws "not exported", proceed to Task 3 which adds it.)

> Note: because Step 1 imported `parseOffSurfaceValues` already, the file will not run until Task 3 adds that export. If you prefer strict red/green isolation, temporarily remove `parseOffSurfaceValues` from the import, run, then restore it in Task 3.

---

## Task 3: `parseOffSurfaceValues` tab parser

**Files:**
- Modify: `plugins/gcloud-tools/skills/analyze-cloud-armor/analyze.ts`
- Test: `plugins/gcloud-tools/skills/analyze-cloud-armor/analyze.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `analyze.test.ts`:

```ts
test('parseOffSurfaceValues splits tab-separated gcloud value output into rows', () => {
  const stdout = [
    'https://x.example.org/.env\tUS\t198.51.100.50',
    'https://x.example.org/.git/config\t\t198.51.100.51', // missing region renders empty
    '', // blank trailing line tolerated
  ].join('\n');
  const rows = parseOffSurfaceValues(stdout);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].host, 'x.example.org');
  assert.equal(rows[0].path, '/.env');
  assert.equal(rows[0].country, 'US');
  assert.equal(rows[0].ip, '198.51.100.50');
  assert.equal(rows[1].path, '/.git/config');
  assert.equal(rows[1].country, ''); // preserved empty; bucketed later
});

test('parseOffSurfaceValues returns no rows for empty output', () => {
  assert.deepEqual(parseOffSurfaceValues(''), []);
  assert.deepEqual(parseOffSurfaceValues('\n  \n'), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx analyze.test.ts`
Expected: FAIL — `parseOffSurfaceValues` is not exported / not a function.

- [ ] **Step 3: Implement `parseOffSurfaceValues`**

In `analyze.ts`, in the "Data sources" section (after `surfaceClause`), add:

```ts
/**
 * Parse `gcloud logging read --format='value(requestUrl, regionCode, remoteIp)'` output:
 * one tab-separated line per deny. Missing fields render as empty strings. Blank lines
 * are skipped. URL parsing reuses splitUrl, which falls back gracefully on bad URLs.
 */
export function parseOffSurfaceValues(stdout: string): DenyRow[] {
  const rows: DenyRow[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [url = '', country = '', ip = ''] = line.split('\t');
    const { host, path } = splitUrl(url);
    rows.push({ host, path, ip, country });
  }
  return rows;
}
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `npx tsx analyze.test.ts`
Expected: all tests PASS (Task 2 + Task 3 tests now green).

---

## Task 4: `execGcloud` extraction + `readOffSurfaceSummary` (live reader)

**Files:**
- Modify: `plugins/gcloud-tools/skills/analyze-cloud-armor/analyze.ts`

> This task has no unit test of its own: `readOffSurfaceSummary` is a thin composition of `execGcloud` (a side-effecting shell-out) + the already-tested `parseOffSurfaceValues` and `summarizeOffSurface`. It is exercised end-to-end in Task 5's CLI verification.

- [ ] **Step 1: Extract `execGcloud` from `readLogs`**

Replace the existing `readLogs` (lines 340-360) with:

```ts
function execGcloud(args: string[]): string {
  try {
    return execFileSync('gcloud', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  } catch (err: unknown) {
    const e = err as { code?: string; stderr?: Buffer | string; message?: string };
    if (e.code === 'ENOENT') {
      throw new Error(
        'gcloud CLI not found on PATH. Install the Google Cloud SDK ' +
          '(https://cloud.google.com/sdk/docs/install), then run `gcloud auth login`.',
      );
    }
    const stderr = e.stderr ? e.stderr.toString().trim() : '';
    throw new Error(`gcloud failed: ${stderr || e.message || String(err)}`);
  }
}

function readLogs(filter: string, project: string, window: string, limit: number): RawEntry[] {
  const out = execGcloud([
    'logging', 'read', filter, '--project', project, '--freshness', window, '--format', 'json', '--limit', String(limit),
  ]);
  return JSON.parse(out) as RawEntry[];
}
```

- [ ] **Step 2: Add `readOffSurfaceSummary`**

Immediately after `readLogs`, add:

```ts
const OFF_SURFACE_FORMAT =
  'value(httpRequest.requestUrl, jsonPayload.securityPolicyRequestData.remoteIpInfo.regionCode, httpRequest.remoteIp)';

/**
 * Fetch ALL enforced denies (no surface clause) with a reduced projection, then summarize
 * the off-surface remainder. `base` already carries BASE_FILTER + any policy clause, so the
 * --policy flag narrows this query consistently with the on-surface query.
 */
function readOffSurfaceSummary(base: string, project: string, window: string, cfg: Config): OffSurfaceSummary {
  const out = execGcloud([
    'logging', 'read', `${base} AND jsonPayload.enforcedSecurityPolicy.outcome="DENY"`,
    '--project', project, '--freshness', window, '--format', OFF_SURFACE_FORMAT, '--limit', String(FETCH_LIMIT),
  ]);
  const rows = parseOffSurfaceValues(out);
  return summarizeOffSurface(rows, cfg, rows.length < FETCH_LIMIT);
}
```

- [ ] **Step 3: Verify the suite still passes (no new tests, ensure nothing broke)**

Run: `npx tsx analyze.test.ts`
Expected: all tests PASS (`readLogs` refactor is behavior-preserving).

---

## Task 5: Wire `main()` (live + offline) and add fixture denies

**Files:**
- Modify: `plugins/gcloud-tools/skills/analyze-cloud-armor/analyze.ts`
- Modify: `plugins/gcloud-tools/skills/analyze-cloud-armor/fixtures/sample-armor-logs.json`
- Test: `plugins/gcloud-tools/skills/analyze-cloud-armor/analyze.test.ts`

- [ ] **Step 1: Add four off-surface deny entries to the fixture**

In `fixtures/sample-armor-logs.json`, add these four objects to the top-level array (before the closing `]`; ensure a comma after the previous last element):

```json
,
  {
    "timestamp": "2026-05-20T09:00:00Z",
    "httpRequest": { "requestMethod": "GET", "requestUrl": "https://api.example.com/.env", "status": 403, "userAgent": "curl/8.0", "remoteIp": "198.51.100.50" },
    "jsonPayload": { "enforcedSecurityPolicy": { "name": "edge-policy", "outcome": "DENY", "preconfiguredExprIds": ["owasp-crs-v030301-id913101-scanner"], "priority": 4000 }, "securityPolicyRequestData": { "remoteIpInfo": { "asn": 22295, "regionCode": "US" } }, "statusDetails": "denied_by_security_policy" }
  },
  {
    "timestamp": "2026-05-20T09:01:00Z",
    "httpRequest": { "requestMethod": "GET", "requestUrl": "https://api.example.com/.git/config", "status": 403, "userAgent": "curl/8.0", "remoteIp": "198.51.100.51" },
    "jsonPayload": { "enforcedSecurityPolicy": { "name": "edge-policy", "outcome": "DENY", "preconfiguredExprIds": ["owasp-crs-v030301-id913101-scanner"], "priority": 4000 }, "securityPolicyRequestData": { "remoteIpInfo": { "asn": 22295, "regionCode": "US" } }, "statusDetails": "denied_by_security_policy" }
  },
  {
    "timestamp": "2026-05-20T09:02:00Z",
    "httpRequest": { "requestMethod": "GET", "requestUrl": "https://api.example.com/.env", "status": 403, "userAgent": "python-requests/2.31", "remoteIp": "198.51.100.52" },
    "jsonPayload": { "enforcedSecurityPolicy": { "name": "edge-policy", "outcome": "DENY", "preconfiguredExprIds": ["owasp-crs-v030301-id913101-scanner"], "priority": 4000 }, "securityPolicyRequestData": { "remoteIpInfo": { "asn": 48090, "regionCode": "NL" } }, "statusDetails": "denied_by_security_policy" }
  },
  {
    "timestamp": "2026-05-20T09:03:00Z",
    "httpRequest": { "requestMethod": "POST", "requestUrl": "https://api.example.com/wp-login.php", "status": 403, "userAgent": "curl/8.0", "remoteIp": "198.51.100.50" },
    "jsonPayload": { "enforcedSecurityPolicy": { "name": "edge-policy", "outcome": "DENY", "preconfiguredExprIds": ["owasp-crs-v030301-id913101-scanner"], "priority": 4000 }, "securityPolicyRequestData": { "remoteIpInfo": { "asn": 22295, "regionCode": "US" } }, "statusDetails": "denied_by_security_policy" }
  }
```

These are off-surface (paths `/.env`, `/.git/config`, `/wp-login.php` — none under `/api/v1` or `/app`), so they must NOT change the on-surface false-positive count.

- [ ] **Step 2: Write the fixture-backed test**

Append to `analyze.test.ts`:

```ts
test('on-surface false-positive total is unchanged by off-surface deny fixtures', () => {
  // The four added scanner denies are off-surface; on-surface denies remain 7.
  assert.equal(agg.falsePositives.total, 7);
});

test('off-surface summary over the sample fixture (mirrors main() offline mapping)', () => {
  const denyRows: DenyRow[] = entries
    .map(normalize)
    .filter((n) => n.outcome === 'DENY')
    .map((n) => ({ host: n.host, path: n.path, ip: n.ip, country: n.country }));
  const s = summarizeOffSurface(denyRows, config, true);
  assert.equal(s.denies, 4); // the four scanner denies
  assert.equal(s.distinctIps, 3); // .50, .51, .52
  assert.deepEqual(s.topPaths[0], { path: '/.env', denies: 2 });
  assert.deepEqual(s.topCountries[0], { country: 'US', denies: 3 });
});
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `npx tsx analyze.test.ts`
Expected: all tests PASS, including the two new ones and the unchanged `total === 7` assertions.

- [ ] **Step 4: Wire the offline (`--input`) path in `main()`**

In `main()`, replace the offline branch (currently):

```ts
  if (values.input) {
    norms = (JSON.parse(readFileSync(values.input, 'utf8')) as RawEntry[]).map(normalize);
    coverage = { source: 'file', span: timeRange(norms), note: 'offline export — coverage is whatever the file contains' };
  } else {
```

with:

```ts
  if (values.input) {
    norms = (JSON.parse(readFileSync(values.input, 'utf8')) as RawEntry[]).map(normalize);
    const denyRows: DenyRow[] = norms
      .filter((n) => n.outcome === 'DENY')
      .map((n) => ({ host: n.host, path: n.path, ip: n.ip, country: n.country }));
    coverage = {
      source: 'file',
      span: timeRange(norms),
      note: 'offline export — coverage is whatever the file contains',
      offSurface: summarizeOffSurface(denyRows, cfg, true),
    };
  } else {
```

- [ ] **Step 5: Wire the live path in `main()`**

In the live `else` branch, replace (currently):

```ts
    norms = enforcedRaw.map(normalize);
    coverage = {
      source: 'gcloud',
      requestedWindow: values.window,
      scopedToAllowedPrefixes: surface !== '',
      enforcedDenies: { fetched: enforcedRaw.length, complete: enforcedRaw.length < FETCH_LIMIT, span: timeRange(norms) },
    };
```

with:

```ts
    norms = enforcedRaw.map(normalize);

    // Off-surface liveness: always run. A failure here must never abort the primary report.
    let offSurface: OffSurfaceResult;
    try {
      offSurface = readOffSurfaceSummary(base, values.project, values.window!, cfg);
    } catch (err: unknown) {
      const msg = (err as Error)?.message ?? String(err);
      process.stderr.write(`warning: off-surface liveness query failed: ${msg}\n`);
      offSurface = { error: msg };
    }

    coverage = {
      source: 'gcloud',
      requestedWindow: values.window,
      scopedToAllowedPrefixes: surface !== '',
      enforcedDenies: { fetched: enforcedRaw.length, complete: enforcedRaw.length < FETCH_LIMIT, span: timeRange(norms) },
      offSurface,
    };
```

- [ ] **Step 6: Verify the CLI emits `coverage.offSurface` in offline mode**

Run:
```bash
npx tsx analyze.ts --input fixtures/sample-armor-logs.json --config fixtures/test-config.json \
  | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['meta']['coverage']['offSurface'], indent=2))"
```
Expected output:
```json
{
  "denies": 4,
  "distinctIps": 3,
  "complete": true,
  "topPaths": [
    { "path": "/.env", "denies": 2 },
    ...
  ],
  "topCountries": [
    { "country": "US", "denies": 3 },
    { "country": "NL", "denies": 1 }
  ]
}
```

---

## Task 6: Update SKILL.md, typecheck, and commit

**Files:**
- Modify: `plugins/gcloud-tools/skills/analyze-cloud-armor/SKILL.md`

- [ ] **Step 1: Document `coverage.offSurface` in the Output Shape section**

In `SKILL.md`, find the Output Shape block and replace this line:

```
  "meta": { "allowlistConfigured": true, "enforcedDeniesOnSurface": N,
            "coverage": { "enforcedDenies": { "fetched": N, "complete": true, "span": {...} } } },
```

with:

```
  "meta": { "allowlistConfigured": true, "enforcedDeniesOnSurface": N,
            "coverage": { "enforcedDenies": { "fetched": N, "complete": true, "span": {...} },
                          "offSurface": { "denies": M, "distinctIps": K, "complete": true,
                                          "topPaths": [{ "path", "denies" }],
                                          "topCountries": [{ "country", "denies" }] } } },
```

- [ ] **Step 2: Add an Output Shape note explaining the field**

In `SKILL.md`, immediately after the Output Shape code block, add this paragraph:

```
`coverage.offSurface` is a deliberately shallow **liveness** summary: enforced denies that
are NOT on your declared surface (almost always scanners hitting paths you don't serve, e.g.
`/.env`, `/.git/config`). It exists so a zero on-surface result is unambiguous — `denies > 0`
here proves the WAF is alive and blocking. It is never per-rule or SQLi-analyzed; it is not an
attack dashboard. On a live run that fails to fetch it, `offSurface` is `{ "error": "..." }`.
```

- [ ] **Step 3: Add a reporting step in "Producing the Report"**

In `SKILL.md`, find this line in the "Producing the Report" list:

```
1. Run the script. If `meta.coverage.enforcedDenies.complete` is `false`, the fetch hit the cap — say there are more.
```

and insert a new item directly after it:

```
2. **Lead with liveness when on-surface denies are 0.** If `enforcedDeniesOnSurface` is 0, do not just report zeros — read `coverage.offSurface`. If `offSurface.denies > 0`, open with "0 false positives on your surface; WAF is live — N denies off-surface from K IPs (scanning <topPaths>)." If `offSurface.denies` is also 0 (or `offSurface` carries an `error`), say so explicitly: a fully silent policy may mean no traffic, logging disabled, or the query failed — flag it rather than implying all-clear.
```

(The subsequent numbered items remain; they do not need renumbering for correctness, but if you renumber, keep them sequential.)

- [ ] **Step 4: Typecheck the skill**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors. (Fix any type mismatch — e.g. ensure `OffSurfaceResult`/`DenyRow` are imported where used.)

- [ ] **Step 5: Run the full test suite one final time**

Run: `npx tsx analyze.test.ts`
Expected: all tests PASS.

- [ ] **Step 6: Single commit for the whole feature**

```bash
cd /home/bartek/private_repo/claude-skills
git add plugins/gcloud-tools/skills/analyze-cloud-armor/analyze.ts \
        plugins/gcloud-tools/skills/analyze-cloud-armor/analyze.test.ts \
        plugins/gcloud-tools/skills/analyze-cloud-armor/fixtures/sample-armor-logs.json \
        plugins/gcloud-tools/skills/analyze-cloud-armor/SKILL.md \
        docs/superpowers/plans/2026-05-31-cloud-armor-offsurface-liveness.md
git commit -m "Add off-surface liveness signal to analyze-cloud-armor"
```

Do NOT push — the repo owner asks to be consulted before any push.

---

## Self-Review Notes (author)

- **Spec coverage:** Query 2 projection + always-run (Tasks 4-5), client-side partition reusing allowlist helpers (Tasks 1-2), `coverage.offSurface` shape incl. `complete` (Tasks 2,5), `--policy` consistency via shared `base` (Task 4), `FETCH_LIMIT`/`complete` mirror (Task 4), offline in-memory partition with no shell-out (Task 5), graceful `{ error }` degradation (Task 5), tests incl. all-off-surface fixture case (Task 5), SKILL.md docs (Task 6). All spec sections map to a task.
- **Type consistency:** `OffSurfaceSummary`, `OffSurfaceResult`, `DenyRow`, `summarizeOffSurface`, `parseOffSurfaceValues`, `surfaceMatches`, `execGcloud`, `readOffSurfaceSummary`, `OFF_SURFACE_FORMAT`, `OFF_SURFACE_TOP_N` are used with identical names/signatures across tasks.
- **No placeholders:** every code/edit step shows full content; expected command output stated.
