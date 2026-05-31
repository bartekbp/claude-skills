import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
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

const here = dirname(fileURLToPath(import.meta.url));
const entries: RawEntry[] = JSON.parse(readFileSync(join(here, 'fixtures/sample-armor-logs.json'), 'utf8'));
const config: Config = JSON.parse(readFileSync(join(here, 'fixtures/test-config.json'), 'utf8'));

const agg = aggregate(entries.map(normalize), config);

test('false positives = enforced denies on the allowed surface only', () => {
  // O'Brien SQLi deny (1) + six XSS denies (6) inside /api/v1 = 7; off-surface traffic ignored.
  assert.equal(agg.falsePositives.total, 7);
});

test('false positives roll up by rule with priority, countries, and endpoints', () => {
  const xss = agg.falsePositives.byRule.find((r) => r.rule.includes('941100-xss'));
  const sqli = agg.falsePositives.byRule.find((r) => r.rule.includes('942100-sqli'));
  assert.ok(xss);
  assert.equal(xss!.denies, 6);
  assert.equal(xss!.distinctIps, 6);
  assert.equal(xss!.priority, 1100);
  assert.deepEqual(xss!.countries, [{ country: 'RU', denies: 6 }]);
  assert.equal(xss!.endpoints.length, 6);
  assert.ok(xss!.endpoints.every((p) => p.startsWith('/api/v1/')));
  assert.ok(sqli && sqli.denies === 1 && sqli.priority === 1000);
  assert.deepEqual(sqli!.endpoints, ['/api/v1/orders']);
});

test('classifyValue flags SQLi structure but treats special-char passwords as benign', () => {
  assert.deepEqual(classifyValue('@@12#').sqliTokens, []); // real password → benign
  assert.ok(classifyValue("a'--").sqliTokens.includes('sql-comment')); // injection structure
  assert.ok(classifyValue("1' OR '1'='1").sqliTokens.length > 0);
  assert.equal(classifyValue('@@12#').classes, 'D+Sym'); // digits + symbols, no letters
});

test('matched values are classified; only attack-like blocks are listed (benign denies are summarized)', () => {
  // fixtures: one benign password deny (@@12#) + six XSS denies with "a'--" (sql-comment)
  assert.deepEqual(agg.falsePositives.classification, { benign: 1, attackLike: 6 });
  const sqli = agg.falsePositives.byRule.find((r) => r.rule.includes('942100-sqli'));
  const xss = agg.falsePositives.byRule.find((r) => r.rule.includes('941100-xss'));
  assert.equal(sqli!.attackLike, 0); // password deny is benign → false positive
  assert.equal(xss!.attackLike, 6); // injection structure → verify, don't whitelist
  // The exhaustive deny list is gone — only attack-like blocks remain to eyeball.
  assert.equal(agg.falsePositives.attackLikeRequests.length, 6);
  assert.ok(agg.falsePositives.attackLikeRequests.every((r) => r.attackLike));
  assert.ok(
    !agg.falsePositives.attackLikeRequests.some((r) => r.ip === '203.0.113.10'),
    'benign password deny must NOT be listed',
  );
});

test('attack-like requests carry full URL (with query), country, ASN, field — never the raw value', () => {
  const r = agg.falsePositives.attackLikeRequests.find((x) => x.ip === '203.0.113.21');
  assert.ok(r, 'expected the attack-like XSS deny');
  assert.match(r!.url, /\/api\/v1\/alpha\?q=/); // full URL incl. query string preserved
  assert.equal(r!.country, 'RU');
  assert.equal(r!.asn, 12345);
  assert.equal(r!.matchedField, 'arg_q');
  assert.ok(r!.signature.sqliTokens.includes('sql-comment'));
  assert.ok(!('matchedValue' in r!), 'raw matched value must never be emitted');
  assert.ok(!('matchedFieldValue' in r!));
});

test('blocked requests carry client country, ASN, and the matched field (never its value)', () => {
  const r = agg.falsePositives.attackLikeRequests.find((x) => x.ip === '203.0.113.21');
  assert.ok(r);
  assert.equal(r!.unexpectedGeo, true); // RU is outside expectedCountries (["PL"])
});

test('by-country rollup flags blocks from outside expected countries', () => {
  const pl = agg.falsePositives.byCountry.find((c) => c.country === 'PL');
  const ru = agg.falsePositives.byCountry.find((c) => c.country === 'RU');
  assert.ok(pl && pl.unexpected === false);
  assert.ok(ru && ru.denies === 6 && ru.unexpected === true);
});

test('off-surface and accept-only traffic is never reported (we cannot fetch all accepts)', () => {
  const reported = new Set([
    ...agg.falsePositives.attackLikeRequests.map((r) => r.ip),
    ...agg.falsePositives.byCountry.flatMap((c) => c.country),
  ]);
  assert.ok(!reported.has('198.51.100.9'), 'scanner (accept) IP must not appear');
  assert.ok(!reported.has('198.51.100.7'), 'sqlmap-UA accept IP must not appear');
});

test('prefix-only config: domain unconstrained, deny inside the prefix is a false positive', () => {
  const prefixOnly: Config = { allowedDomains: [], allowedPathPrefixes: ['/api/v2'] };
  const norms = [
    normalize({
      httpRequest: { requestUrl: 'https://anything.example.org/api/v2/orders?q=1', status: 403, remoteIp: '203.0.113.99' },
      jsonPayload: { enforcedSecurityPolicy: { outcome: 'DENY', preconfiguredExprIds: ['rule-x'] } },
    }),
    // accept outside the prefix → must NOT be reported
    normalize({
      httpRequest: { requestUrl: 'https://anything.example.org/legacy/login', status: 200, remoteIp: '203.0.113.98' },
      jsonPayload: { enforcedSecurityPolicy: { outcome: 'ACCEPT' } },
    }),
  ];
  const out = aggregate(norms, prefixOnly);
  assert.equal(out.falsePositives.total, 1);
  assert.equal(out.falsePositives.byRule[0].rule, 'rule-x');
});

test('timeRange reports the min and max timestamps actually covered', () => {
  const ns = [
    normalize({ timestamp: '2026-05-02T00:00:00Z', httpRequest: { requestUrl: 'https://x/y', status: 200, remoteIp: '1.1.1.1' }, jsonPayload: { enforcedSecurityPolicy: { outcome: 'ACCEPT' } } }),
    normalize({ timestamp: '2026-05-01T00:00:00Z', httpRequest: { requestUrl: 'https://x/y', status: 200, remoteIp: '1.1.1.1' }, jsonPayload: { enforcedSecurityPolicy: { outcome: 'ACCEPT' } } }),
  ];
  const r = timeRange(ns);
  assert.equal(r.from, '2026-05-01T00:00:00Z');
  assert.equal(r.to, '2026-05-02T00:00:00Z');
});

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
