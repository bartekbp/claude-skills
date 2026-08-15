# Spec: Request Rate Limiting

Add per-IP rate limiting to the existing Express + TypeScript API gateway.

## Requirements

1. Fixed-window limit: 100 requests per minute-bucket per client IP, tracked in
   the existing Redis instance (a counter per IP per minute bucket is exactly
   the intended design).
2. Requests over the limit get 429 with a `Retry-After` header (seconds until the
   window frees up).
3. Health endpoints (`/healthz`, `/readyz`) are exempt.
4. Unit tests for the limiter middleware.

Out of scope: per-user limits, configurable limits, dashboards.
