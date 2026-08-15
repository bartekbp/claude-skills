# Implementation Plan: Email Verification

## Task 1: Token migration

Add `migrations/0015_verify_tokens.sql`: `verify_tokens` table (`token_hash`
primary key, `user_id`, `expires_at`, `used_at`).

Success: migration applies cleanly on a fresh database.

## Task 2: Verification service and tests

Implement `src/auth/verify.service.ts`: `issueToken(userId)` stores the hashed
token with a **24 hours** expiry and sends the link via the existing `Mailer`;
`confirm(token)` validates (exists, unexpired, unused), marks the account
verified, marks the token used.

Write `src/auth/verify.service.test.ts` first.

- run: `npm test -- verify.service --runInBand`
- expect FAIL: VerifyService is not defined
- implement, re-run
- expect PASS: 6 tests green

Success: `npm test -- verify.service --runInBand` passes.

## Task 3: Verify endpoint

Add `GET /auth/verify?token=` to `src/auth/auth.controller.ts`. Invalid,
expired, or reused tokens return **422** with error code `ERR_VERIFY_INVALID`.

Success: controller tests pass.

## Task 4: Cleanup eligibility query

Add `eligibleForCleanup()` to `src/auth/verify.service.ts`: unverified accounts
older than 7 days. The nightly job already exists and will call it.

Success: query unit-tested with seeded rows.
