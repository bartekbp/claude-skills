# Spec: Event Fan-Out

When an event is recorded via `POST /events`, deliver it to every subscribed endpoint,
instead of subscribers polling for it.

## Requirements

1. On `EventService.record`, the event is delivered to all active subscriptions.
   Delivery is signed the same way existing outbound deliveries are signed.
2. A delivery failure to one subscriber must not block delivery to the others.
   Failed deliveries are recorded (subscription id, event id, error) in a new
   `failed_deliveries` table.
3. `GET /webhooks/:id/failures` lists the failed deliveries for one subscription.
4. Existing endpoints keep their current behaviour.
5. Unit tests for the fan-out logic.

Out of scope: retry of failed deliveries, subscriber-side filtering, UI.
