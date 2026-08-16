# Event Fan-Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver every recorded event to all active subscriptions, with per-subscriber failure isolation.

**Architecture:** A fan-out service iterates active subscriptions and delivers the event to each; failures are persisted per subscriber and exposed on a read endpoint.

**Tech Stack:** Express, TypeScript, node:crypto, vitest

**Spec:** spec.md

## Global Constraints

- Delivery bodies are signed HMAC-SHA256, hex digest, sent in the `X-Webhook-Signature` header.
- A single subscriber failure must never abort the fan-out loop.

---

### Task 1: Failed-delivery persistence

**Files:**
- Create: `src/notifier/notifier.store.ts`
- Test: `src/notifier/notifier.store.test.ts`

**Interfaces:**
- Produces: `NotifierStore.recordFailure(subscriptionId: string, eventId: string, error: string): Promise<void>`, `NotifierStore.listFailures(subscriptionId: string): Promise<FailedDelivery[]>`

- [ ] **Step 1: Write the failing test**

```typescript
import { NotifierStore } from "./notifier.store";

test("records and lists a failed delivery", async () => {
  const store = new NotifierStore();
  await store.recordFailure("sub-1", "evt-1", "timeout");
  const failures = await store.listFailures("sub-1");
  expect(failures).toHaveLength(1);
  expect(failures[0].error).toBe("timeout");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- notifier.store`
Expected: FAIL with "Cannot find module './notifier.store'"

- [ ] **Step 3: Write minimal implementation**

```typescript
import { db } from "../db";

export interface FailedDelivery {
  subscriptionId: string;
  eventId: string;
  error: string;
  failedAt: Date;
}

export class NotifierStore {
  async recordFailure(subscriptionId: string, eventId: string, error: string): Promise<void> {
    await db.failed_deliveries.insert({ subscriptionId, eventId, error });
  }

  async listFailures(subscriptionId: string): Promise<FailedDelivery[]> {
    return db.failed_deliveries.findBySubscription(subscriptionId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- notifier.store`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/notifier/notifier.store.ts src/notifier/notifier.store.test.ts
git commit -m "feat: persist failed deliveries"
```

### Task 2: Fan-out service

**Files:**
- Create: `src/notifier/fanout.service.ts`
- Test: `src/notifier/fanout.service.test.ts`

**Interfaces:**
- Consumes: `NotifierStore.recordFailure` from Task 1, `WebhookRepository.listSubscriptions` from `src/webhooks/webhook.repository.ts`
- Produces: `FanoutService.fanOut(event: RecordedEvent): Promise<void>`

- [ ] **Step 1: Write the failing test**

```typescript
import { FanoutService } from "./fanout.service";

test("a failing subscriber does not block the others", async () => {
  const delivered: string[] = [];
  const service = new FanoutService(repoWithSubs(["sub-1", "sub-2"]), storeStub(), {
    deliver: async (sub, event) => {
      if (sub.id === "sub-1") throw new Error("timeout");
      delivered.push(sub.id);
    },
  });
  await service.fanOut(event("evt-1"));
  expect(delivered).toEqual(["sub-2"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- fanout.service`
Expected: FAIL with "Cannot find module './fanout.service'"

- [ ] **Step 3: Write minimal implementation**

```typescript
import { createHmac } from "node:crypto";
import { WebhookRepository } from "../webhooks/webhook.repository";
import { NotifierStore } from "./notifier.store";
import { RecordedEvent } from "../events/event.service";

function computeSignature(secret: string, payload: unknown): string {
  return createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
}

export class FanoutService {
  constructor(
    private readonly subscriptions: WebhookRepository,
    private readonly store: NotifierStore,
    private readonly transport: { deliver(sub: unknown, event: RecordedEvent): Promise<void> },
  ) {}

  async fanOut(event: RecordedEvent): Promise<void> {
    for (const sub of await this.subscriptions.listSubscriptions()) {
      try {
        await this.transport.deliver({ ...sub, signature: computeSignature(sub.secret, event.payload) }, event);
      } catch (err) {
        await this.store.recordFailure(sub.id, event.id, String(err));
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- fanout.service`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/notifier/fanout.service.ts src/notifier/fanout.service.test.ts
git commit -m "feat: fan out recorded events to subscribers"
```

### Task 3: Trigger fan-out on record

**Files:**
- Modify: `src/events/event.service.ts`
- Test: `src/events/event.service.test.ts`

**Interfaces:**
- Consumes: `FanoutService.fanOut` from Task 2
- Produces: `EventService.record` now fans out after insert; signature unchanged

- [ ] **Step 1: Write the failing test**

```typescript
test("record fans the event out", async () => {
  const fanOut = vi.fn();
  const service = new EventService({ fanOut });
  await service.record("user.created", { id: 7 });
  expect(fanOut).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- event.service`
Expected: FAIL with "expected spy to be called once"

- [ ] **Step 3: Wire the fan-out**

```typescript
export class EventService {
  constructor(private readonly fanout: FanoutService) {}

  async record(type: string, payload: unknown): Promise<RecordedEvent> {
    const event = await db.events.insert({ type, payload });
    await this.fanout.fanOut(event);
    return event;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- event.service`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/events/event.service.ts src/events/event.service.test.ts
git commit -m "feat: fan out on event record"
```

### Task 4: Failures endpoint and replay support

**Files:**
- Modify: `src/routes.ts`
- Create: `src/notifier/failures.handler.ts`
- Test: `src/notifier/failures.handler.test.ts`

**Interfaces:**
- Consumes: `NotifierStore.listFailures` from Task 1
- Produces: `GET /webhooks/:id/failures` returning `FailedDelivery[]` as JSON

- [ ] **Step 1: Write the failing test**

```typescript
test("lists failures for a subscription", async () => {
  const res = await request(app).get("/webhooks/sub-1/failures");
  expect(res.status).toBe(200);
  expect(res.body).toEqual([expect.objectContaining({ eventId: "evt-1" })]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- failures.handler`
Expected: FAIL with 404

- [ ] **Step 3: Implement handler and routes**

```typescript
export const listFailuresHandler = (store: NotifierStore) => async (req, res) => {
  res.json(await store.listFailures(req.params.id));
};
```

Register in `src/routes.ts`, and extend the existing `legacy-replay` handler to accept an
optional `eventType` body field so replayed deliveries can carry the new event types:

```typescript
router.get("/webhooks/:id/failures", listFailuresHandler(store));
router.post("/webhooks/legacy-replay", legacyReplayHandler); // now reads body.eventType
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- failures.handler`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/routes.ts src/notifier/failures.handler.ts src/notifier/failures.handler.test.ts
git commit -m "feat: expose failed deliveries"
```
