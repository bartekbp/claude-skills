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

/**
 * Bucket duration that divides the window so buckets align to the cutoff, at the window's
 * natural granularity: daily for day-scale windows, hourly for hour-scale. Finer buckets keep
 * the partial trailing "now" bucket small, so it barely skews the current-window count.
 */
export function pickBucket(windowSec: number): number {
  if (windowSec % 86400 === 0) return 86400; // day-scale → daily buckets
  return 3600; // hour-scale → hourly buckets (all windows are whole hours)
}

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

// ---------- Representative frame ----------

// Patterns that locate a single code frame across common runtimes. Each returns either one
// capture group ("File.java:42") or two ("path.py" + "88") which are joined with ":".
const FRAME_PATTERNS: RegExp[] = [
  /\bat\s+[\w.$<>]+\(([^)\s]+:\d+)\)/, // Java/Kotlin: at a.b.C.m(C.java:42)
  /\bat\s+[^(]*\(([^)\s]+:\d+:\d+)\)/, // Node: at fn (/p/f.js:10:5)
  /File "([^"]+)", line (\d+)/, // Python: File "x.py", line 5
  /(\/?[\w./\-]+\.go:\d+)/, // Go: path/file.go:123
  /([\w./\-]+\.[a-z]{1,4}:\d+)/, // generic file.ext:line
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

  const frames: string[] = [];
  for (const line of lines) {
    const m = matchFrame(line);
    if (m && m !== kind) frames.push(m);
  }
  // Prefer the first application frame over vendored/library frames — that is the line a
  // human can actually compare against the codebase. Fall back to the first frame found.
  const where = frames.find((f) => !/node_modules|site-packages|\/vendor\//.test(f)) ?? frames[0] ?? '';
  return { kind, where };
}

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

// ---------- Drill-down (dedup) ----------

/**
 * Normalize a stack so events that are "the same error" — differing only by volatile data
 * (user/entity ids, memory addresses, UUIDs, IPs, goroutine numbers) — collapse to one
 * signature. Frame file:line is preserved; only data-shaped tokens are masked.
 */
export function stackSignature(message: string): string {
  return (message ?? '')
    .replace(/"[^"]*"/g, '"X"') // quoted free-text (entity names, ids) — varies per occurrence
    .replace(/'[^']*'/g, "'X'")
    .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.,]+Z?/g, 'TS') // ISO-8601 timestamps
    .replace(/0x[0-9a-fA-F]+/g, '0xADDR')
    .replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, 'UUID')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, 'IP')
    .replace(/\bgoroutine\s+\d+\b/gi, 'goroutine N')
    .replace(/\b\d{4,}\b/g, 'N') // long numeric ids (line numbers are typically < 1000, so kept)
    .replace(/\s+/g, ' ')
    .trim();
}

export interface StackGroup {
  count: number; // how many fetched events share this stack
  services: string[]; // distinct logical services that hit it
  firstSeen: string;
  lastSeen: string;
  message: string; // a full representative stack (the longest seen) — ask the model about this
}

/** Group fetched events by normalized stack signature, most frequent first. */
export function dedupeStacks(events: RawEvent[]): StackGroup[] {
  const map = new Map<string, { count: number; services: Set<string>; times: string[]; message: string }>();
  for (const e of events) {
    const sig = stackSignature(e.message ?? '');
    const svc = logicalService(e.serviceContext);
    const t = e.eventTime ?? '';
    const cur = map.get(sig);
    if (cur) {
      cur.count++;
      cur.services.add(svc);
      if (t) cur.times.push(t);
      if ((e.message ?? '').length > cur.message.length) cur.message = e.message ?? '';
    } else {
      map.set(sig, { count: 1, services: new Set(svc ? [svc] : []), times: t ? [t] : [], message: e.message ?? '' });
    }
  }
  return [...map.values()]
    .map((v) => ({
      count: v.count,
      services: [...v.services].sort(),
      firstSeen: v.times.length ? v.times.reduce((a, b) => (a < b ? a : b)) : '',
      lastSeen: v.times.length ? v.times.reduce((a, b) => (a > b ? a : b)) : '',
      message: v.message,
    }))
    .sort((a, b) => b.count - a.count);
}

// ---------- Data source (Error Reporting REST API) ----------

const API = 'https://clouderrorreporting.googleapis.com/v1beta1';
const PAGE_SIZE = 200;
const MAX_PAGES = 25; // backstop; error groups are few — one page is typical
const EVENTS_PAGE_SIZE = 100; // events API page size for drill-down
const EVENTS_FETCH_DEFAULT = 200; // pull a healthy sample, then dedup to the distinct stacks

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

async function fetchEvents(project: string, groupId: string, period: string, tok: string, max: number): Promise<RawEvent[]> {
  const events: RawEvent[] = [];
  let pageToken: string | undefined;
  do {
    const params: Record<string, string> = {
      groupId,
      'timeRange.period': period,
      pageSize: String(Math.min(EVENTS_PAGE_SIZE, max - events.length)),
    };
    if (pageToken) params.pageToken = pageToken;
    const j = await apiGet(`projects/${project}/events`, params, tok);
    events.push(...((j.errorEvents ?? []) as RawEvent[]));
    pageToken = j.nextPageToken;
  } while (pageToken && events.length < max);
  return events;
}

// ---------- CLI ----------

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      project: { type: 'string' },
      window: { type: 'string', default: '7d' },
      service: { type: 'string' }, // post-deploy framing: narrow to one logical service
      group: { type: 'string' }, // drill-down: deduplicated stacks for one group
      events: { type: 'string', default: String(EVENTS_FETCH_DEFAULT) }, // events to sample before dedup
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
    const events = await fetchEvents(values.project, values.group, period, accessToken(), Number(values.events));
    const stacks = dedupeStacks(events);
    process.stdout.write(
      JSON.stringify({ group: values.group, sampled: events.length, distinctStacks: stacks.length, stacks }, null, 2) + '\n',
    );
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
