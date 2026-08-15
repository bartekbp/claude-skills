# Implementation Plan: Outbound Webhooks

## Task 1: Create the WebhookSubscription entity

Add `src/webhooks/subscription.entity.ts`: `id`, `targetUrl`, `secret`,
`createdAt`, matching the style of the other entities.

Success: `npx tsc --noEmit` passes.

## Task 2: Mirror WebhookSubscription in schema.sql

Add the `webhooks` table to `db/schema.sql` with the same four columns, plus
`migrations/0018_webhooks.sql`.

Success: migration applies cleanly on a fresh database.

## Task 3: Delivery service and tests

Implement `src/webhooks/delivery.service.ts`: on note create/delete, build the
event JSON, sign each delivery with the signPayload helper, POST it to every
subscription, and retry failures up to 3 times with 30s backoff before dropping
and logging.

Write `src/webhooks/delivery.service.test.ts` first.

- run: `npm test -- delivery.service`
- expect FAIL: DeliveryService is not defined
- implement, re-run
- expect PASS: 6 tests green

Success: `npm test -- delivery.service` passes.

## Task 4: Subscription endpoints

Add `POST /webhooks` and `DELETE /webhooks/:id` to a new
`src/webhooks/webhooks.controller.ts`, validating the target URL and returning
400 on malformed input.

Success: controller tests pass.

## Task 5: Add the signPayload helper

Create `src/webhooks/sign.ts` exporting `signPayload(body, secret)`:
HMAC-SHA256 of the body, hex-encoded, for the `X-Signature` header. Unit-test
against a known vector.

Success: `npm test -- sign` passes.
