import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseWindow,
  pickPeriod,
  pickBucket,
  numArg,
  stripPodSuffix,
  logicalService,
  extractFrame,
  sumWindows,
  classify,
  trendPct,
  buildDigest,
  stackSignature,
  dedupeStacks,
  compactStacks,
  type RawGroupStat,
  type RawEvent,
  type DigestOpts,
} from './analyze.ts';

const here = dirname(fileURLToPath(import.meta.url));

// ---------- window helpers ----------

test('parseWindow understands h/d/w', () => {
  assert.equal(parseWindow('7d'), 604800);
  assert.equal(parseWindow('6h'), 21600);
  assert.equal(parseWindow('1w'), 604800);
  assert.throws(() => parseWindow('5x'));
});

test('pickPeriod picks the smallest period covering 2x the window', () => {
  assert.equal(pickPeriod(604800), 'PERIOD_30_DAYS'); // 7d -> need 14d -> 30d period
  assert.equal(pickPeriod(21600), 'PERIOD_1_DAY'); // 6h -> need 12h -> 1d period
  assert.equal(pickPeriod(3600), 'PERIOD_6_HOURS'); // 1h -> need 2h -> 6h period
  assert.throws(() => pickPeriod(20 * 86400)); // > ~15d cannot be covered
});

test('pickBucket divides the window and stays API-aligned', () => {
  assert.equal(pickBucket(604800), 86400); // 7d -> daily buckets
  assert.equal(pickBucket(21600), 3600); // 6h -> hourly buckets
  assert.equal(pickBucket(86400), 86400); // 1d -> daily buckets
});

// ---------- logical service ----------

test('stripPodSuffix recovers the workload name from a GKE pod name', () => {
  assert.equal(stripPodSuffix('checkout-service-67566c4cf7-vzdtj'), 'checkout-service');
  assert.equal(stripPodSuffix('widget-service-5d8f7c6b4a-rk2mn'), 'widget-service');
  assert.equal(stripPodSuffix('payments-worker-0'), 'payments-worker'); // statefulset ordinal
  assert.equal(stripPodSuffix('billing'), 'billing'); // no suffix -> unchanged
});

test('logicalService derives GKE names but leaves non-GKE services as-is', () => {
  assert.equal(
    logicalService({ service: 'gke_instances', version: 'checkout-service-67566c4cf7-vzdtj', resourceType: 'k8s_container' }),
    'checkout-service',
  );
  assert.equal(logicalService({ service: 'web-frontend', version: '00031-abc', resourceType: 'cloud_run_revision' }), 'web-frontend');
  assert.equal(logicalService(undefined), '(unknown)');
});

// ---------- representative frame ----------

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

  // Prefer the application frame over a vendored node_modules frame.
  const node =
    'BusinessError: thing failed\n' +
    '    at Client.x (/app/node_modules/grpc/client.js:161:32)\n' +
    '    at OrderController.handle (/app/dist/order.controller.js:42:19)';
  assert.equal(extractFrame(node).where, '/app/dist/order.controller.js:42:19');
});

// ---------- windowing & classification ----------

const ASOF = Date.parse('2026-05-30T00:00:00Z');
const WIN = 604800; // 7d
const CUR_START = ASOF - WIN * 1000;

test('sumWindows splits timedCounts into current vs prior at the cutoff', () => {
  const buckets = [
    { count: '100', endTime: '2026-05-20T00:00:00Z' }, // prior window
    { count: '500', endTime: '2026-05-28T00:00:00Z' }, // current window
    { count: '5', endTime: '2026-05-10T00:00:00Z' }, // older than prior -> ignored
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

// ---------- digest assembly ----------

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
  assert.equal(digest.summary.new, 1); // search-api
  assert.equal(digest.summary.spiking, 1); // checkout
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
  assert.deepEqual(
    digest.leads.map((l) => l.groupId),
    ['grpCheckoutNPE', 'grpSearchPanic'],
  );
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

// ---------- drill-down dedup ----------

test('stackSignature masks volatile ids/addresses so duplicate stacks collapse', () => {
  const a = stackSignature('User not found userId=10001\n\tat X.find(X.java:88)');
  const b = stackSignature('User not found userId=20002\n\tat X.find(X.java:88)');
  assert.equal(a, b); // differ only by a user id -> same signature
  assert.ok(stackSignature('panic at 0x1a2b3c4d').includes('0xADDR'));
  assert.ok(stackSignature('client 10.1.2.3 failed').includes('IP'));
  // free-text data inside quotes is masked, so "same error, different entity" collapses
  assert.equal(
    stackSignature('Item not found for cart "Cart A", itemId 778899'),
    stackSignature('Item not found for cart "Cart B", itemId 112233'),
  );
});

test('dedupeStacks collapses near-identical stacks and ranks by frequency', () => {
  const evs: RawEvent[] = JSON.parse(readFileSync(join(here, 'fixtures/sample-dedup-events.json'), 'utf8'));
  const stacks = dedupeStacks(evs);
  assert.equal(stacks.length, 2); // 3 near-identical "User not found" + 1 distinct timeout
  assert.equal(stacks[0].count, 3);
  assert.deepEqual(stacks[0].services, ['checkout-service', 'payments-worker']); // distinct services that hit it
  assert.equal(stacks[0].firstSeen, '2026-05-30T10:00:00Z');
  assert.equal(stacks[0].lastSeen, '2026-05-30T10:05:00Z');
  assert.ok(stacks[0].message.includes('BusinessError')); // full representative stack kept
  assert.equal(stacks[1].count, 1);
  assert.ok(stacks[1].message.includes('TimeoutError'));
});

// ---------- review hardening: validation, boundaries, fallbacks ----------

test('numArg rejects bad flags instead of silently yielding NaN', () => {
  assert.equal(numArg('spike-ratio', '2'), 2);
  assert.equal(numArg('spike-ratio', '2.5'), 2.5);
  assert.equal(numArg('events', '50', { int: true, min: 1 }), 50);
  assert.throws(() => numArg('spike-ratio', '2x')); // NaN
  assert.throws(() => numArg('min-count', '-1', { min: 0 })); // below min
  assert.throws(() => numArg('events', '2.5', { int: true })); // non-integer
  assert.throws(() => numArg('events', '0', { int: true, min: 1 })); // below min
});

test('classify boundary conditions and status precedence', () => {
  const opts = { spikeRatio: 2, minCount: 10 };
  const old = Date.parse('2025-01-01T00:00:00Z');
  assert.equal(classify({ current: 100, prior: 200 }, old, CUR_START, opts), 'IMPROVED'); // current == 0.5*prior
  assert.equal(classify({ current: 200, prior: 100 }, old, CUR_START, opts), 'SPIKING'); // current == spikeRatio*prior
  assert.equal(classify({ current: 8, prior: 1 }, old, CUR_START, opts), 'RECURRING'); // spike below minCount floor
  assert.equal(classify({ current: 2, prior: 8 }, old, CUR_START, opts), 'RECURRING'); // improvement, prior below floor
  assert.equal(classify({ current: 500, prior: 100 }, Date.parse('2026-05-26T00:00:00Z'), CUR_START, opts), 'NEW'); // NEW beats SPIKE
  assert.equal(classify({ current: 500, prior: 0 }, old, CUR_START, opts), 'REAPPEARED'); // REAPPEARED beats SPIKE
  assert.equal(classify({ current: 0, prior: 0 }, old, CUR_START, opts), 'RECURRING'); // both zero, not REAPPEARED
});

test('sumWindows skips malformed bucket timestamps instead of mis-binning', () => {
  const b = [
    { count: '5', endTime: 'not-a-date' },
    { count: '50', endTime: '2026-05-28T00:00:00Z' },
  ];
  assert.deepEqual(sumWindows(b, ASOF, WIN), { current: 50, prior: 0 });
});

test('buildDigest falls back to ~now when no bucket carries a usable timestamp', () => {
  const noBuckets: RawGroupStat[] = [{ group: { groupId: 'g', resolutionStatus: 'OPEN' }, timedCounts: [], firstSeenTime: '2025-01-01T00:00:00Z' }];
  const d = buildDigest(noBuckets, BASE_OPTS);
  assert.ok(Date.parse(d.meta.window.to) > Date.parse('2026-01-01T00:00:00Z'), 'window.to is recent, not 1970');
});

test('stackSignature keeps genuinely different errors distinct', () => {
  assert.notEqual(
    stackSignature('NullPointerException\n\tat X.run(X.java:88)'),
    stackSignature('IllegalStateException\n\tat X.run(X.java:88)'),
  ); // different exception types
  assert.notEqual(stackSignature('at X.run(X.java:88)'), stackSignature('at X.run(X.java:99)')); // line numbers <1000 preserved
});

test('extractFrame handles empty, frame-less, and all-vendored messages', () => {
  assert.deepEqual(extractFrame(''), { kind: '', where: '' });
  assert.equal(extractFrame('SomeError: just a message, no stack').where, ''); // no parseable frame
  const vendored = 'TypeError: x\n    at f (/app/node_modules/foo/bar.js:1:2)\n    at g (/app/node_modules/baz/qux.js:3:4)';
  assert.equal(extractFrame(vendored).where, '/app/node_modules/foo/bar.js:1:2'); // all vendored → first frame, not ''
});

test('dedupeStacks keeps the longest message as the representative', () => {
  // Same signature (the id is masked), but the second message is longer — it should win.
  const evs: RawEvent[] = [
    { eventTime: '2026-05-30T10:00:00Z', serviceContext: { service: 'svc' }, message: 'BusinessError: x id=1000' },
    { eventTime: '2026-05-30T10:01:00Z', serviceContext: { service: 'svc' }, message: 'BusinessError: x id=200000999' },
  ];
  const out = dedupeStacks(evs);
  assert.equal(out.length, 1);
  assert.equal(out[0].count, 2);
  assert.ok(out[0].message.includes('200000999'));
});

test('compactStacks handles an empty sample without dividing by zero', () => {
  assert.deepEqual(compactStacks([], 2), { sampled: 0, distinct: 0, top: [] });
});

test('compactStacks returns the top-N distinct stacks with share% and a compact frame', () => {
  const evs: RawEvent[] = JSON.parse(readFileSync(join(here, 'fixtures/sample-dedup-events.json'), 'utf8'));
  const r = compactStacks(evs, 2);
  assert.equal(r.sampled, 4);
  assert.equal(r.distinct, 2);
  assert.equal(r.top.length, 2);
  assert.equal(r.top[0].count, 3);
  assert.equal(r.top[0].sharePct, 75); // 3 of 4
  assert.match(r.top[0].kind, /User not found/);
  assert.equal(r.top[0].where, 'UserService.java:88'); // top app frame, not the whole stack
  assert.equal(r.top[1].count, 1);
  assert.match(r.top[1].kind, /TimeoutError/);
  // topN caps the list even when more distinct stacks exist
  assert.equal(compactStacks(evs, 1).top.length, 1);
});
