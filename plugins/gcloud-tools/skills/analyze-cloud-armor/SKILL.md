---
name: analyze-cloud-armor
description: Use when reviewing Google Cloud Armor or HTTPS Load Balancer logs to find WAF false positives — legitimate traffic your security policy is blocking. For tuning over-broad rules, investigating blocked users (by country/ASN), and confirming whether blocks are real customers or attackers. GCP-specific; requires the gcloud CLI.
---

# Analyze Cloud Armor

## Overview

This skill finds **Cloud Armor false positives** — legitimate traffic on *your* surface that the WAF is blocking — and gives you everything needed to verify each one: the **full URL, client IP, client country + ASN**, and the **request field that tripped the rule** (e.g. `password`). Findings roll up **by rule** and **by country** so you can tell real customers (expected markets) from attackers.

It deliberately reports only what can be measured **completely**: **enforced `DENY` events on your declared surface** (`allowedDomains` / `allowedPathPrefixes`). These are rare and fully fetchable. A bundled zero-dependency script queries the logs, scopes to your surface, enriches from the log itself, and emits compact JSON; you (the model) turn it into a ranked report.

The matched **value** is never emitted — it is frequently a real password.

## Why no false-negative detection

There is intentionally no "what should have been blocked but wasn't" section. That requires scanning **all accept traffic** — millions of requests per period on a real load balancer, unfetchable in full. Any sample is a tiny, recent, unrepresentative slice, so such findings would mislead. Enforced denies are rare and targeted, so they can be fetched completely and trusted. This skill only reports what it can prove.

## When to Use

- A user reports being wrongly blocked, or you suspect over-broad WAF rules
- Periodic false-positive review of an enforced Cloud Armor policy
- Checking whether blocks are concentrated in your real markets (likely FP) or odd geographies (likely attacks)

**Don't use when:** the project isn't on GCP / Cloud Armor, or you want attack/threat detection (this is a false-positive tuning tool, not an IDS).

## Prerequisites

This skill shells out to two external tools — check both before running:

- **Node.js** (for `npx tsx`): `node --version` should print v18+. `npx` ships with npm.
- **`gcloud` CLI**, authenticated, with log-read access: `gcloud auth login` (or a service account), and [Cloud Armor request logging](https://cloud.google.com/armor/docs/request-logging) enabled on the backend service. If `gcloud` is missing the script stops with an install link.

No other install step: `analyze.ts` has zero runtime dependencies and `npx` fetches `tsx` on demand.

## Configuration (handle this before the first run)

The analysis hinges on knowing *your* legitimate surface. This is environment-specific, so it lives in a per-project config the skill creates and reuses — never hardcode domains/paths into this directory.

Canonical cached path (per project):

```
${XDG_CONFIG_HOME:-$HOME/.config}/gcloud-tools/cloud-armor.<project>.json
```

Follow this every run:

1. **Look for the cached config** for the target project at the path above.
2. **If it exists** — show the user its `allowedPathPrefixes` / `allowedDomains` / `expectedCountries` and ask whether to reuse or update. Reuse by default; don't re-interview.
3. **If it does not exist** — interview the user, then write the file:
   - "Which URL path prefixes are valid (e.g. `/api/v2`, `/swagger`)?" → `allowedPathPrefixes`
   - "Which domains serve legitimate traffic?" → `allowedDomains` (leave `[]` to allow any domain)
   - "Which countries are your expected markets (ISO-3166 alpha-2, e.g. `GB`)?" → `expectedCountries` (optional; leave out to just see the distribution)

   Create the directory and write the JSON (schema in `armor.config.example.json`), then tell the user the path so they know it will be reused.

An unspecified dimension means "unconstrained." If only prefixes are given, any domain on those prefixes counts as the surface. With `expectedCountries` empty, the report shows the country distribution without flagging.

## How to Run

Run from the skill's own directory (where `analyze.ts` lives), or use an absolute path to `analyze.ts` — the commands below and the `fixtures/` paths are relative to it.

```bash
npx tsx analyze.ts --project my-project \
  --config "$HOME/.config/gcloud-tools/cloud-armor.my-project.json" --window 7d

# Narrow to one security policy
npx tsx analyze.ts --project my-project --config <cached-config> --policy edge-policy

# Offline: analyze a saved export (also how the fixtures run)
npx tsx analyze.ts --input fixtures/sample-armor-logs.json --config fixtures/test-config.json
```

## Output Shape

```jsonc
{
  "meta": { "allowlistConfigured": true, "enforcedDeniesOnSurface": N,
            "coverage": { "enforcedDenies": { "fetched": N, "complete": true, "span": {...} },
                          "offSurface": { "denies": M, "distinctIps": K, "complete": true,
                                          "topPaths": [{ "path", "denies" }],
                                          "topCountries": [{ "country", "denies" }] } } },
  "falsePositives": {
    "total": N,
    "classification": { "benign": N, "attackLike": M },   // benign = false positive; attackLike = verify
    "byRule":    [{ "rule", "priority", "denies", "attackLike", "distinctIps", "countries": [{ "country", "denies" }], "endpoints": [] }],
    "byCountry": [{ "country", "denies", "distinctIps", "unexpected" }],
    "attackLikeRequests": [{ "ip", "country", "asn", "url", "rules", "matchedField",
                             "signature": { "length", "classes", "sqliTokens": [] },
                             "status", "count", "unexpectedGeo" }]
  }
}
```

`attackLikeRequests` lists **only the blocks whose value contains SQLi structure** — the ones a human should eyeball before excluding. Benign denies (the false positives) are *not* listed individually; they're fully summarized by `classification`, `byRule`, and `byCountry`. Full URL (with query), client IP, and country/ASN are included so each can be investigated; the matched value never is.

`coverage.offSurface` is a deliberately shallow **liveness** summary: enforced denies that
are NOT on your declared surface (almost always scanners hitting paths you don't serve, e.g.
`/.env`, `/.git/config`). It exists so a zero on-surface result is unambiguous — `denies > 0`
here proves the WAF is alive and blocking. It is never per-rule or SQLi-analyzed; it is not an
attack dashboard. On a live run that fails to fetch it, `offSurface` is `{ "error": "..." }`.

## Producing the Report

1. Run the script. If `meta.coverage.enforcedDenies.complete` is `false`, the fetch hit the cap — say there are more.
2. **Lead with liveness when on-surface denies are 0.** If `enforcedDeniesOnSurface` is 0, do not just report zeros — read `coverage.offSurface`. If `offSurface.denies > 0`, open with "0 false positives on your surface; WAF is live — N denies off-surface from K IPs (scanning <topPaths>)." If `offSurface.denies` is also 0 (or `offSurface` carries an `error`), say so explicitly: a fully silent policy may mean no traffic, logging disabled, or the query failed — flag it rather than implying all-clear.
2. **Lead with the `byRule` table** — one row per rule with `priority`, `denies`, `distinctIps`, the `countries` it blocked, and the `endpoints` it fired on. This is the organized headline; render it as a table sorted by `denies`. `byCountry` is a quick overall geo summary beneath it.
3. **Use geography to judge intent:** blocks concentrated in `expectedCountries` are very likely false positives (real users); `unexpected: true` countries may be genuine attacks — don't recommend whitelisting those.
4. **Use `matchedField` for the smoking gun:** a SQLi rule matching the `password` field on `/auth/*` is a textbook false positive (credentials legitimately contain rule-tripping characters).
5. **Confirm it isn't a real attack with `classification`.** `benign` blocks contain no SQLi structure (just special chars — real passwords); `attackLike` blocks contain injection tokens (`sqliTokens`: `sql-comment`, `keyword`, `tautology`, …). A finding that is overwhelmingly `benign` from expected countries is a safe false positive to exclude; surface the few `attackLike` requests (by `signature`, never the raw value) for the user to eyeball before whitelisting. Per-rule `attackLike` tells you which rules are catching real attempts vs only false positives. **Never disable a rule whose blocks are mostly `attackLike`.**
6. List the **`attackLikeRequests`** (IP + country + full URL + field) so the user can eyeball the few that need verifying. Do **not** enumerate the benign denies — they're the false positives, already summarized by the rollups; listing each one is noise.
6. Recommend per rule: a scoped **rule exclusion** for the matched paths, or a **field exclusion** so the rule stops inspecting that field (e.g. the password), keeping protection elsewhere.
7. Be honest about confidence and **never print the matched value** — it can be a real credential.

## Common Mistakes

- **No allowlist configured.** Then every enforced deny — including correctly-blocked attacks on random paths — is reported. Always set the surface.
- **Claiming false negatives.** This tool cannot find "traffic that should have been blocked" (accepts are unfetchable in full). Don't infer it.
- **Whitelisting unexpected-geo blocks.** A block from outside your markets may be a real attack; check before excluding.
- **Putting environment specifics in the skill.** Domains, prefixes, expected countries, and policy names belong in the user's private config file, never in this directory.

## Testing

`npx tsx analyze.test.ts` runs the analysis against generic fixtures. Run it after editing `analyze.ts`.
