# Spec: Password Reset

Add password reset to the existing Express + TypeScript auth service.

## Requirements

1. `POST /auth/reset-request` — accepts an email; if the account exists, store a
   single-use reset token (random 32 bytes, 1 hour expiry) and send the reset email
   through the existing `Mailer`.
2. `POST /auth/reset-confirm` — accepts token + new password; validates the token
   (exists, unexpired, unused), updates the password hash, marks the token used.
3. Invalid or expired tokens return 400; the endpoint never reveals whether an
   email exists.
4. Unit tests for both flows.

Out of scope: rate limiting, changing the mailer, auth refactors of any kind.
