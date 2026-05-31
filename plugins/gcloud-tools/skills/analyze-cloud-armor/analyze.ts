/**
 * analyze-cloud-armor — find Cloud Armor / HTTPS Load Balancer WAF false positives.
 *
 * Scope is deliberately narrow to what can be fetched COMPLETELY. Accept traffic (and
 * broadly-matched preview blocks) are far too high-volume to pull in full, so we do NOT
 * try to infer "traffic that should have been blocked" from a sample. We fetch the one
 * rare, fully-retrievable signal on your declared surface (allowedDomains /
 * allowedPathPrefixes):
 *
 *   falsePositives — enforced DENY events on the allowed surface (blocked-but-legit)
 *
 * The headline view is per-rule: rule id + priority + denies + distinct IPs + which
 * countries were blocked + which endpoints. Each blocked value is classified attack-like
 * vs benign (does it contain SQLi structure?) so you can confirm the blocks are real
 * users, not an actual attack. The matched *value* itself is NEVER emitted — only its
 * length, character classes, and which SQLi tokens it contained. Geo (country/ASN) and
 * the matched field name come straight from the log — no third-party services.
 *
 * Zero runtime dependencies. Run with: npx tsx analyze.ts [options]
 * Data source: `gcloud logging read` (live) or a JSON file (--input, for testing).
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

// ---------- Types ----------

interface SecurityPolicy {
  name?: string;
  outcome?: string; // ACCEPT | DENY
  preconfiguredExprIds?: string[];
  priority?: number;
  matchedFieldName?: string; // e.g. "password" — which request field tripped the rule
  matchedFieldType?: string; // e.g. "ARG_VALUES"
  matchedFieldValue?: string; // the substring that matched — classified, NEVER emitted raw
}

export interface RawEntry {
  insertId?: string;
  timestamp?: string;
  httpRequest?: {
    requestMethod?: string;
    requestUrl?: string;
    status?: number;
    userAgent?: string;
    remoteIp?: string;
  };
  jsonPayload?: {
    enforcedSecurityPolicy?: SecurityPolicy;
    previewSecurityPolicy?: SecurityPolicy;
    statusDetails?: string;
    securityPolicyRequestData?: { remoteIpInfo?: { asn?: number; regionCode?: string } };
  };
}

export interface Config {
  allowedDomains: string[];
  allowedPathPrefixes: string[];
  expectedCountries?: string[]; // ISO-3166 alpha-2 (e.g. "GB"); blocks outside these are flagged
}

/** A privacy-safe fingerprint of the matched value — never the value itself. */
export interface ValueSignature {
  length: number;
  classes: string; // which character classes are present: L(etters) / D(igits) / Sym(bols)
  sqliTokens: string[]; // SQLi structures found (empty = looks benign, e.g. a real password)
}

export interface Norm {
  ts: string;
  ip: string;
  method: string;
  host: string;
  path: string;
  url: string; // full request URL, query string included
  status: number;
  outcome: string; // ACCEPT | DENY (enforced)
  rules: string[]; // enforced preconfigured rule ids
  priority: number | null; // enforced rule priority
  country: string; // remoteIpInfo.regionCode (ISO-3166 alpha-2), '' if absent
  asn: number | null; // remoteIpInfo.asn
  matchedField: string; // which request field tripped the rule, e.g. "password"
  signature: ValueSignature; // safe fingerprint of the matched value
  attackLike: boolean; // matched value contains SQLi structure (vs just special chars)
}

export interface CountryCount {
  country: string;
  denies: number;
}

export interface RuleRollup {
  rule: string;
  priority: number | null;
  denies: number;
  attackLike: number; // of those denies, how many matched values look like a real attack
  distinctIps: number;
  countries: CountryCount[]; // where this rule blocked, most-blocked first
  endpoints: string[]; // distinct request paths this rule blocked (no query string)
}

export interface CountryRollup {
  country: string;
  denies: number;
  distinctIps: number;
  unexpected: boolean | null; // null = not evaluated (no expectedCountries configured)
}

export interface BlockedRequest {
  ip: string;
  country: string;
  asn: number | null;
  url: string;
  rules: string[];
  matchedField: string; // never the matched *value* — that can be a real password
  attackLike: boolean;
  signature: ValueSignature;
  status: number;
  count: number;
  unexpectedGeo: boolean | null; // null = not evaluated (no expectedCountries configured)
}

export interface DenialDetail {
  total: number;
  classification: { benign: number; attackLike: number }; // benign = false positive, attackLike = verify
  byRule: RuleRollup[];
  byCountry: CountryRollup[];
  // Only the blocks that need a human eyeball. Benign denies (the false positives) are
  // fully summarized by classification + byRule + byCountry; we don't list each one.
  attackLikeRequests: BlockedRequest[];
}

export interface Aggregates {
  meta: { allowlistConfigured: boolean; enforcedDeniesOnSurface: number };
  falsePositives: DenialDetail; // enforced denies on the allowed surface
}

export interface Coverage {
  from?: string;
  to?: string;
}

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

// ---------- Matched-value classification ----------

// SQLi structures that distinguish an actual injection payload from a benign value
// (e.g. a real password that merely contains symbols). The raw value is classified and
// then discarded — only these token names ever leave this process.
const SQLI_TOKENS: [string, RegExp][] = [
  ['sql-comment', /--|\/\*/],
  ['tautology', /\b\d+\s*=\s*\d+\b/],
  ['keyword', /\b(union|select|insert|update|delete|drop|concat|information_schema|table|database|from|where)\b/i],
  ['timing', /\b(sleep|benchmark|waitfor|pg_sleep)\b/i],
  ['stacked', /;\s*\w/],
  ['hex', /0x[0-9a-f]{4,}/i],
  ['quote-bool', /['"]\s*(or|and)\s/i],
];

export function classifyValue(value: string): ValueSignature {
  const classes = [/[a-z]/i.test(value) && 'L', /[0-9]/.test(value) && 'D', /[^a-z0-9]/i.test(value) && 'Sym']
    .filter(Boolean)
    .join('+');
  const sqliTokens = SQLI_TOKENS.filter(([, re]) => re.test(value)).map(([name]) => name);
  return { length: value.length, classes, sqliTokens };
}

// ---------- Normalization ----------

function splitUrl(url?: string): { host: string; path: string } {
  if (!url) return { host: '', path: '' };
  try {
    const u = new URL(url);
    return { host: u.host, path: u.pathname };
  } catch {
    const q = url.indexOf('?');
    return { host: '', path: q >= 0 ? url.slice(0, q) : url };
  }
}

export function normalize(e: RawEntry): Norm {
  const { host, path } = splitUrl(e.httpRequest?.requestUrl);
  const enf = e.jsonPayload?.enforcedSecurityPolicy ?? {};
  const geo = e.jsonPayload?.securityPolicyRequestData?.remoteIpInfo;
  const signature = classifyValue(enf.matchedFieldValue ?? '');
  return {
    ts: e.timestamp ?? '',
    ip: e.httpRequest?.remoteIp ?? '',
    method: e.httpRequest?.requestMethod ?? '',
    host,
    path,
    url: e.httpRequest?.requestUrl ?? '',
    status: e.httpRequest?.status ?? 0,
    outcome: (enf.outcome ?? 'ACCEPT').toUpperCase(),
    rules: enf.preconfiguredExprIds ?? [],
    priority: enf.priority ?? null,
    country: geo?.regionCode ?? '',
    asn: geo?.asn ?? null,
    matchedField: enf.matchedFieldName ?? '',
    signature,
    attackLike: signature.sqliTokens.length > 0,
  };
}

// ---------- Allowlist helpers ----------

function inAllowedDomain(host: string, cfg: Config): boolean {
  // An unspecified dimension is unconstrained: "any domain" when no domains are listed.
  if (cfg.allowedDomains.length === 0) return true;
  return cfg.allowedDomains.some((d) => host === d || host.endsWith('.' + d));
}

function inAllowedPrefix(path: string, cfg: Config): boolean {
  // An unspecified dimension is unconstrained: "any path" when no prefixes are listed.
  if (cfg.allowedPathPrefixes.length === 0) return true;
  return cfg.allowedPathPrefixes.some((p) => path === p || path.startsWith(p.endsWith('/') ? p : p + '/'));
}

function surfaceMatches(host: string, path: string, cfg: Config): boolean {
  return inAllowedDomain(host, cfg) && inAllowedPrefix(path, cfg);
}

function onAllowedSurface(n: Norm, cfg: Config): boolean {
  return surfaceMatches(n.host, n.path, cfg);
}

// ---------- Aggregation ----------

interface RuleAcc {
  priority: number | null;
  denies: number;
  attackLike: number;
  ips: Set<string>;
  countries: Map<string, number>;
  endpoints: Set<string>;
}

function buildDenialDetail(items: Norm[], cfg: Config): DenialDetail {
  const expected = new Set((cfg.expectedCountries ?? []).map((c) => c.toUpperCase()));
  // null when no expected countries are configured — "not evaluated", not "confirmed in-market".
  const isUnexpected = (country: string): boolean | null =>
    expected.size === 0 ? null : country !== '' && !expected.has(country.toUpperCase());

  const byRule = new Map<string, RuleAcc>();
  for (const n of items) {
    const c = n.country || '(unknown)';
    for (const r of n.rules.length ? n.rules : ['(custom/none)']) {
      const e =
        byRule.get(r) ??
        byRule.set(r, { priority: null, denies: 0, attackLike: 0, ips: new Set(), countries: new Map(), endpoints: new Set() }).get(r)!;
      if (e.priority === null && n.priority !== null) e.priority = n.priority;
      e.denies++;
      if (n.attackLike) e.attackLike++;
      e.ips.add(n.ip);
      e.countries.set(c, (e.countries.get(c) ?? 0) + 1);
      if (n.path) e.endpoints.add(n.path);
    }
  }

  const byCountry = new Map<string, { denies: number; ips: Set<string> }>();
  for (const n of items) {
    const c = n.country || '(unknown)';
    const e = byCountry.get(c) ?? byCountry.set(c, { denies: 0, ips: new Set() }).get(c)!;
    e.denies++;
    e.ips.add(n.ip);
  }

  const reqs = new Map<string, BlockedRequest>();
  for (const n of items) {
    const key = `${n.ip} ${n.url} ${n.rules.join(',')}`;
    const e = reqs.get(key);
    if (e) {
      e.count++;
      // Prefer an attack-like signature for the example, so the riskiest one is visible.
      if (n.attackLike && !e.attackLike) {
        e.attackLike = true;
        e.signature = n.signature;
      }
    } else {
      reqs.set(key, {
        ip: n.ip,
        country: n.country,
        asn: n.asn,
        url: n.url,
        rules: n.rules,
        matchedField: n.matchedField,
        attackLike: n.attackLike,
        signature: n.signature,
        status: n.status,
        count: 1,
        unexpectedGeo: isUnexpected(n.country),
      });
    }
  }

  return {
    total: items.length,
    classification: {
      benign: items.filter((n) => !n.attackLike).length,
      attackLike: items.filter((n) => n.attackLike).length,
    },
    byRule: [...byRule.entries()]
      .map(([rule, v]) => ({
        rule,
        priority: v.priority,
        denies: v.denies,
        attackLike: v.attackLike,
        distinctIps: v.ips.size,
        countries: [...v.countries.entries()].map(([country, denies]) => ({ country, denies })).sort((a, b) => b.denies - a.denies),
        endpoints: [...v.endpoints].sort(),
      }))
      .sort((a, b) => b.denies - a.denies),
    byCountry: [...byCountry.entries()]
      .map(([country, v]) => ({ country, denies: v.denies, distinctIps: v.ips.size, unexpected: isUnexpected(country) }))
      .sort((a, b) => b.denies - a.denies),
    attackLikeRequests: [...reqs.values()].filter((r) => r.attackLike).sort((a, b) => b.count - a.count),
  };
}

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

export function aggregate(norms: Norm[], cfg: Config): Aggregates {
  const allowlistConfigured = cfg.allowedDomains.length > 0 || cfg.allowedPathPrefixes.length > 0;
  const onSurface = (n: Norm) => !allowlistConfigured || onAllowedSurface(n, cfg);
  const enforced = norms.filter((n) => n.outcome === 'DENY' && onSurface(n));
  return {
    meta: { allowlistConfigured, enforcedDeniesOnSurface: enforced.length },
    falsePositives: buildDenialDetail(enforced, cfg),
  };
}

export function timeRange(norms: Norm[]): Coverage {
  let from: string | undefined;
  let to: string | undefined;
  for (const n of norms) {
    if (!n.ts) continue;
    if (from === undefined || n.ts < from) from = n.ts;
    if (to === undefined || n.ts > to) to = n.ts;
  }
  return { from, to };
}

// ---------- Data sources ----------

const BASE_FILTER = 'resource.type="http_load_balancer" AND jsonPayload.enforcedSecurityPolicy.name:*';
const FETCH_LIMIT = 100000; // enforced denies are rare; fetch them (near-)completely

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

function policyClause(policy: string | undefined): string {
  return policy ? ` AND jsonPayload.enforcedSecurityPolicy.name="${policy}"` : '';
}

/**
 * Server-side prefilter: restrict to requests whose URL hits an allowed path prefix.
 * Coarse substring match (precise check still happens in `inAllowedPrefix`), but it
 * keeps the fetch to false-positive candidates. Empty when no prefixes are configured.
 */
function surfaceClause(cfg: Config): string {
  const terms = cfg.allowedPathPrefixes.map((p) => `httpRequest.requestUrl:"${p}"`);
  return terms.length ? ` AND (${terms.join(' OR ')})` : '';
}

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

// ---------- CLI ----------

function loadConfig(path: string | undefined): Config {
  const base: Config = { allowedDomains: [], allowedPathPrefixes: [] };
  if (!path) return base;
  return { ...base, ...(JSON.parse(readFileSync(path, 'utf8')) as Config) };
}

function main(): void {
  const { values } = parseArgs({
    options: {
      project: { type: 'string' },
      window: { type: 'string', default: '7d' },
      policy: { type: 'string' },
      config: { type: 'string' },
      input: { type: 'string' },
    },
  });

  const cfg = loadConfig(values.config);
  if (cfg.allowedDomains.length === 0 && cfg.allowedPathPrefixes.length === 0) {
    process.stderr.write(
      'warning: no allowlist configured — every enforced deny is treated as a candidate.\n' +
        'Set allowedDomains / allowedPathPrefixes (see armor.config.example.json) so the report\n' +
        'reflects denies on YOUR surface, not attack traffic that was correctly blocked.\n',
    );
  }

  let norms: Norm[];
  let coverage: Record<string, unknown>;

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
    if (!values.project) {
      process.stderr.write('error: --project is required (or use --input <file> for offline analysis).\n');
      process.exit(2);
    }
    const base = BASE_FILTER + policyClause(values.policy);
    const surface = surfaceClause(cfg);

    // Enforced denies on the surface are rare and fully fetchable — the one signal we can trust.
    // (Accepts and broad preview-blocks are too high-volume to fetch completely, so we don't.)
    const enforcedRaw = readLogs(
      `${base} AND jsonPayload.enforcedSecurityPolicy.outcome="DENY"${surface}`,
      values.project,
      values.window!,
      FETCH_LIMIT,
    );
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
  }

  const agg = aggregate(norms, cfg);
  const out = { meta: { ...agg.meta, coverage }, falsePositives: agg.falsePositives };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

// Run only when invoked directly, not when imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err: unknown) {
    process.stderr.write(`error: ${(err as Error)?.message ?? String(err)}\n`);
    process.exit(1);
  }
}
