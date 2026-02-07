# 010 — Consumer Contract Rules

> **RFC 2119 Normative Language**: The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Idempotency Contract

### RULE-010-001: Idempotency Is Mandatory

Every consumer MUST implement idempotency.

- Consumers that cannot handle duplicate events are **PROHIBITED in production**.
- Idempotency MUST be verified before deployment via automated tests.

### RULE-010-002: Tracking ID Usage

Every event contains a `tracking_id` (UUID). Consumers MUST:

1. Check if `tracking_id` was already processed before executing side effects
2. Store processed `tracking_id` in a durable location
3. Skip processing if duplicate detected

```typescript
// REQUIRED pattern
const alreadyProcessed = await checkProcessed(event.tracking_id);
if (alreadyProcessed) {
  return; // Skip duplicate
}

await processEvent(event);
await markProcessed(event.tracking_id);
```

### RULE-010-003: External API Idempotency Keys

When calling external APIs (Stripe, payment gateways, etc.), consumers MUST:

1. Use `tracking_id` as base for idempotency key
2. Combine with fencing token when available

```typescript
const idempotencyKey = `${event.tracking_id}-${event.lock_token}`;
await stripe.charges.create({ ... }, { idempotencyKey });
```

---

## 2. Deduplication Storage

### RULE-010-010: Deduplication Table Required

Consumers SHOULD maintain a dedicated deduplication table:

```sql
CREATE TABLE processed_events (
  tracking_id UUID PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumer_id TEXT NOT NULL
);

CREATE INDEX idx_processed_events_ttl 
ON processed_events (processed_at);
```

### RULE-010-011: Deduplication Retention

Deduplication records MUST be retained for at least:

| Scenario | Minimum Retention |
|----------|-------------------|
| Standard | 7 days |
| Financial/Compliance | 30 days |
| Legal hold | Until released |

Retention policy MUST match or exceed outbox event retention.

### RULE-010-012: Atomic Processing

The event processing and deduplication record insertion MUST be atomic:

```sql
BEGIN;
INSERT INTO processed_events (tracking_id, consumer_id) 
VALUES ($1, $2) ON CONFLICT DO NOTHING;
-- If inserted, process event
-- If conflict, skip (duplicate)
COMMIT;
```

---

## 3. Consumer Responsibilities

### RULE-010-020: No Ordering Assumptions

Consumers MUST NOT assume event ordering.

- Events from different aggregates MAY arrive out of order
- Events from the SAME aggregate MAY arrive out of order during retries
- Consumers requiring strict order MUST implement application-level sequencing

### RULE-010-021: Schema Compatibility

Consumers MUST handle:

1. Unknown fields (ignore gracefully)
2. Missing optional fields (use defaults)
3. Schema version mismatches (apply upcasters)

```typescript
function processPayload(payload: unknown): OrderEvent {
  const version = (payload as any).schema_version ?? 1;
  return applyUpcasters(payload, version);
}
```

### RULE-010-022: Failure Isolation

Consumer failures MUST NOT:

- Corrupt outbox state
- Block other consumers
- Cause cascading failures

Each consumer MUST be independently restartable.

---

## 4. Prohibitions

### RULE-010-030: No Production Without Idempotency Tests

Consumers MUST NOT be deployed to production without:

1. Unit tests verifying duplicate handling
2. Integration tests with replay scenarios
3. Documentation of idempotency mechanism

### RULE-010-031: No Side Effects Before Dedup Check

Side effects (HTTP calls, database writes, file operations) MUST NOT occur before idempotency validation.

```typescript
// ❌ PROHIBITED
await chargeCustomer(event);
const isDuplicate = await checkDuplicate(event);

// ✅ REQUIRED
const isDuplicate = await checkDuplicate(event);
if (!isDuplicate) {
  await chargeCustomer(event);
}
```

### RULE-010-032: No Silent Failures

Consumer failures MUST be:

1. Logged with full context
2. Reported to monitoring systems
3. Propagated to worker for retry/DLE handling

Swallowing exceptions is **PROHIBITED**.

---

## 5. Audit Trail

### RULE-010-040: Consumer Registration

All consumers MUST be registered with:

| Field | Description |
|-------|-------------|
| `consumer_id` | Unique identifier |
| `event_types` | List of handled event types |
| `owner_team` | Responsible team |
| `idempotency_mechanism` | How duplicates are handled |

### RULE-010-041: Processing Metrics

Consumers MUST emit metrics for:

- Events processed (success/failure)
- Duplicates skipped
- Processing latency
- Retry count distribution

---

## References

- [Idempotency Patterns](https://stripe.com/docs/api/idempotent_requests)
- [At-Least-Once Delivery](https://microservices.io/patterns/communication-style/messaging.html)
