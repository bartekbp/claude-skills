# Spec: Email Verification

Add email verification to the existing Express + TypeScript auth service.

## Requirements

1. On signup, store a single-use verification token and email a link through the
   existing `Mailer`. Tokens expire after **1 hour**.
2. `GET /auth/verify?token=` marks the account verified; invalid, expired, or
   reused tokens return **400** with error code `ERR_VERIFY_INVALID`.
3. Unverified accounts older than 7 days are eligible for cleanup by the
   existing nightly job (add the eligibility query only; the job itself exists).
4. Unit tests for the verification flow.

Out of scope: resending emails, changing the mailer, admin overrides.
