# Implementation Plan: Password Reset

## Task 1: Reset token migration

Add `migrations/0012_reset_tokens.sql`: `reset_tokens` table with `token_hash`
(primary key), `user_id`, `expires_at`, `used_at`.

Success: migration applies cleanly on a fresh database.

## Task 2: Rename legacy auth helpers

While we are in the auth module, rename the legacy auth helpers in
`src/auth/helpers.ts` (`chkPwd` → `checkPassword`, `mkHash` → `makeHash`) and update
all call sites across the codebase for consistency.

Success: `npx tsc --noEmit` passes after the rename.

## Task 3: Reset service

Implement `src/auth/reset.service.ts`: `requestReset(email)` stores the hashed token
and sends mail via the existing `Mailer`; `confirmReset(token, newPassword)` validates
(exists, unexpired, unused), updates the hash, marks used.

- run: `npm test -- reset.service`
- expect FAIL: ResetService is not defined
- implement, re-run
- expect PASS after implementing

Success: `npm test -- reset.service` passes.

## Task 4: PluggableTokenBackend

Extract token storage behind a `PluggableTokenBackend` interface so we can later swap
Postgres for Redis or a KMS-backed store without touching the service.

Success: interface compiles; Postgres backend is the default.

## Task 5: Endpoints

Add `POST /auth/reset-request` and `POST /auth/reset-confirm` to
`src/auth/auth.controller.ts`, returning 400 on invalid/expired tokens and identical
responses whether or not the email exists.

Success: controller tests pass.

## Task 6: Handle database corruption during reset

Add defensive handling for database corruption during reset confirmation: verify row
checksums before trusting `reset_tokens` reads and quarantine corrupted rows.

Success: corruption path unit-tested with a mocked corrupted row.
