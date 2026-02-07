# 000 — Core Outbox Rules

> **RFC 2119 Normative Language**: The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Fundamental Identity

### RULE-000-001: This Is NOT a Message Broker

This project is a **Transactional Outbox Framework**. It is NOT a generic message queue, pub/sub system, or FIFO pipeline.

- The PRIMARY purpose is **atomicity between business state and event emission**.
- Throughput is SECONDARY to consistency.
- PostgreSQL is the **orchestrator**, not a transport substitute.

### RULE-000-002: Atomicity Is Non-Negotiable

Every domain event MUST be persisted in the **SAME database transaction** as the business state change.

```sql
BEGIN;
UPDATE orders SET status = 'confirmed' WHERE id = $1;
INSERT INTO outbox (aggregate_id, event_type, payload) VALUES ($1, 'OrderConfirmed', $2);
COMMIT;
```

**Violations**:
- ❌ Publishing events after COMMIT
- ❌ Using async callbacks to emit events
- ❌ Relying on application-level retry to emit events

### RULE-000-003: Delivery Guarantee

The system provides **at-least-once** delivery.

- Consumers MUST handle duplicates (see `010-consumer-contract-rules.md`).
- The framework does NOT guarantee ordering across events.
- Exactly-once semantics are the CONSUMER's responsibility.

---

## 2. Schema Requirements

### RULE-000-010: Mandatory Event Metadata

Every outbox record MUST contain:

| Column | Type | Requirement |
|--------|------|-------------|
| `id` | BIGSERIAL | Auto-generated sequence |
| `tracking_id` | UUID | Unique, immutable idempotency key |
| `aggregate_id` | UUID | Business entity identifier |
| `aggregate_type` | TEXT | Entity type (e.g., `Order`, `Payment`) |
| `event_type` | TEXT | Event name (e.g., `OrderCreated`) |
| `payload` | JSONB | Event data |
| `created_at` | TIMESTAMPTZ | Insertion timestamp |
| `status` | TEXT | Lifecycle state |

### RULE-000-011: Status Lifecycle

The `status` column MUST use ONLY the following values:

| Status | Meaning |
|--------|---------|
| `PENDING` | Awaiting processing |
| `PROCESSING` | Claimed by a worker |
| `COMPLETED` | Successfully processed |
| `FAILED` | Temporary failure, will retry |
| `DEAD_LETTER` | Permanent failure, requires intervention |

Any other status value is **PROHIBITED**.

### RULE-000-012: Payload Schema Versioning

Every event payload MUST include a `schema_version` field.

```json
{
  "schema_version": 2,
  "order_id": "abc-123",
  "total": 99.99
}
```

- Schema changes MUST be backward-compatible OR use upcasters.
- Breaking changes without version increment are **PROHIBITED**.

---

## 3. Prohibitions

### RULE-000-020: No Generic Queue Usage

The outbox table MUST NOT be used as a general-purpose task queue.

**Prohibited patterns**:
- ❌ Storing non-domain events (e.g., scheduled jobs)
- ❌ Using outbox for request/response patterns
- ❌ Treating outbox as a cache or buffer

### RULE-000-021: No Direct External Publish

Events MUST NOT be published directly to external systems (Kafka, SNS, HTTP) from application code.

All external publishing MUST flow through:
1. Outbox table (transactional write)
2. Worker/CDC process (async propagation)

### RULE-000-022: No Untracked Deletions

Events MUST NOT be deleted without:
- Partition-based retention policy, OR
- Audited archival process

Ad-hoc `DELETE` statements on the outbox are **PROHIBITED**.

---

## 4. Audit and Governance

### RULE-000-030: Schema Changes Require Review

Any modification to the outbox schema MUST:
1. Be documented in a migration file
2. Be reviewed by a database architect
3. Include rollback procedure

### RULE-000-031: Configuration Is Explicit

All runtime configuration (batch size, lease duration, retry limits) MUST be:
- Declared in environment variables or config files
- Never hardcoded in application code
- Documented with default values

---

## References

- [Transactional Outbox Pattern](https://microservices.io/patterns/data/transactional-outbox.html)
- [RFC 2119 - Key words for use in RFCs](https://www.ietf.org/rfc/rfc2119.txt)
