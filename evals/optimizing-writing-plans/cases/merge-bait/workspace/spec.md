# Spec: Outbound Webhooks

Let integrations subscribe to note events in the existing Express + TypeScript
service.

## Requirements

1. `POST /webhooks` registers a subscription (target URL, secret); `DELETE /webhooks/:id`
   removes it. Stored in a new `webhooks` table.
2. On note create/delete, POST a JSON event to each subscription's URL.
3. Every delivery is signed: `X-Signature` header, HMAC-SHA256 of the body with
   the subscription's secret.
4. Failed deliveries retry up to 3 times with 30s backoff, then are dropped and
   logged.
5. Unit tests for signing and delivery.

Out of scope: delivery dashboards, event replay, per-event filtering.
