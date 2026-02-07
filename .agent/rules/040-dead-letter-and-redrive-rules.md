# 040 — Dead Letter and Redrive Rules

> **RFC 2119 Normative Language**: The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Dead Letter Event (DLE) Definition

### RULE-040-001: DLE Isolation Is Mandatory

Events that fail processing after exhausting retries MUST be moved to `DEAD_LETTER` status.

- DLE events MUST NOT block the main processing queue.
- DLE events MUST be isolated for investigation and remediation.

### RULE-040-002: Maximum Retry Threshold

Every event MUST have a `max_retries` limit:

| Scenario | Default | Rationale |
|----------|---------|-----------|
| Transient failures | 5 | Network, timeout |
| Business logic | 3 | Validation, rules |
| External API | 5 | Rate limits, availability |

Events exceeding `max_retries` MUST transition to `DEAD_LETTER`.

### RULE-040-003: DLE Metadata

DLE events MUST retain:

| Field | Description |
|-------|-------------|
| `last_error` | Most recent error message |
| `retry_count` | Total attempts |
| `processed_at` | Last attempt timestamp |
| Original payload | Unchanged from creation |

---

## 2. Retry Strategy

### RULE-040-010: Exponential Backoff Is Mandatory

Retry attempts MUST use exponential backoff:

$$delay = baseDelay \times 2^{attempt}$$

### RULE-040-011: Jitter Is Required

Backoff MUST include random jitter to prevent thundering herd:

$$jitter = random(0, delay \times 0.1)$$
$$total\_delay = delay + jitter$$

### RULE-040-012: Maximum Delay Cap

Backoff delay MUST be capped:

| Scenario | Max Delay |
|----------|-----------|
| Default | 30 seconds |
| External APIs | 5 minutes |

### RULE-040-013: Immediate Retry Prohibition

Immediate retry (delay = 0) after failure is **PROHIBITED**.

Minimum delay: 100ms.

---

## 3. DLE Monitoring

### RULE-040-020: DLE Alerting Is Mandatory

Alerts MUST fire when:

| Condition | Severity |
|-----------|----------|
| Any new DLE | Info |
| DLE count > 10 per event_type | Warning |
| DLE spike (> 10x baseline in 5min) | Critical |
| Same aggregate_id appears 3+ times | Critical |

### RULE-040-021: DLE Visibility

DLE events MUST be visible via:

1. Monitoring dashboard
2. Query interface
3. Alerting system

DLE events MUST NOT be hidden or auto-deleted.

---

## 4. Root Cause Analysis (RCA)

### RULE-040-030: RCA Before Redrive

Redrive of DLE events without RCA is **PROHIBITED**.

RCA MUST identify:
1. Error category (infrastructure, contract, business)
2. Root cause
3. Remediation applied

### RULE-040-031: RCA Documentation

RCA MUST be documented with:

```markdown
## DLE Incident: [Event Type]
- **Date**: YYYY-MM-DD
- **Count**: N events
- **Error**: [Error message pattern]
- **Root Cause**: [Description]
- **Fix Applied**: [PR/Deployment reference]
- **Redrive Date**: YYYY-MM-DD
```

### RULE-040-032: Error Classification

Errors MUST be classified:

| Category | Action |
|----------|--------|
| Infrastructure | Fix infra → Auto-redrive |
| Contract/Schema | Fix producer/consumer → Redrive |
| Business Rule | Escalate to product → Manual decision |
| Poison Pill | Archive and discard |

---

## 5. Redrive Procedure

### RULE-040-040: Controlled Redrive

Redrive MUST be controlled:

```sql
-- Redrive specific event types only
UPDATE outbox
SET status = 'PENDING', retry_count = 0, last_error = NULL
WHERE status = 'DEAD_LETTER'
  AND event_type = 'OrderCreated';  -- Scoped!
```

Mass redrive without filters is **PROHIBITED**.

### RULE-040-041: Redrive Rate Limiting

Redrive MUST be rate-limited to prevent downstream overload:

| Scenario | Rate |
|----------|------|
| Default | 100 events/minute |
| Critical | 1000 events/minute |

### RULE-040-042: Post-Redrive Verification

After redrive:

1. Monitor processing success rate
2. Verify no new DLE for same events
3. Close RCA incident

---

## 6. Schema Evolution (Upcasting)

### RULE-040-050: Upcasters for Schema Changes

When payload schema changes, upcasters MUST be implemented:

```typescript
const upcasters = [
  { version: 1, up: (p) => ({ ...p, currency: p.currency ?? 'USD' }) },
  { version: 2, up: (p) => ({ ...p, metadata: p.metadata ?? {} }) }
];
```

### RULE-040-051: Backward Compatibility Window

Schema changes MUST maintain backward compatibility for:

| Scenario | Window |
|----------|--------|
| Hot data | Current retention (30 days) |
| With replay | Cold archive retention |

### RULE-040-052: Breaking Changes

Breaking schema changes MUST:

1. Increment `schema_version`
2. Deploy upcasters before new schema
3. Never remove fields in hot window

---

## 7. Prohibitions

### RULE-040-060: No Silent DLE

DLE events MUST NOT be ignored.

Every DLE MUST trigger:
- Alert
- Log entry
- Dashboard visibility

### RULE-040-061: No Auto-Delete of DLE

DLE events MUST NOT be auto-deleted.

Retention of DLE:
- Minimum: 90 days
- Legal hold: Until released

### RULE-040-062: No Redrive Without Fix

Redrive without deployed fix is **PROHIBITED**.

This creates infinite DLE loops.

---

## References

- [Dead Letter Queue Pattern](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)
- [Exponential Backoff](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
