# Implementation Plan: Request Rate Limiting

## Task 1: Limiter middleware with tests

Implement `src/middleware/rate-limit.ts`: fixed-window counter keyed
`ratelimit:{ip}:{minuteBucket}` in the existing Redis client (`src/redis.ts`),
limit 100/minute. Over-limit requests get 429 and `Retry-After` with the seconds
remaining in the window. `/healthz` and `/readyz` bypass the middleware.

Write `src/middleware/rate-limit.test.ts` first: under-limit passes, 101st request
in a window gets 429 with correct `Retry-After`, health endpoints exempt, window
resets after 60s (fake timers).

- run: `npm test -- rate-limit`
- expect FAIL: rate-limit middleware not implemented
- implement `src/middleware/rate-limit.ts`, re-run
- expect PASS: 4 tests green

Success: `npm test -- rate-limit` passes.

## Task 2: Wire into the gateway

Register the middleware in `src/app.ts` before the router, after body parsing.

- run: `npm test`
- expect PASS: full suite green, rate-limit tests included
- smoke: `for i in $(seq 1 101); do curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/api/notes; done | tail -1`
- expect: `429`

Success: `npm test` passes and the smoke loop prints 429 on request 101.
