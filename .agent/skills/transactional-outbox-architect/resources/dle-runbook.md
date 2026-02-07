# Dead Letter Event (DLE) Runbook

## Monitoring & Alerting

### Alert Conditions
- `count(status='DEAD_LETTER') > 10` per event_type
- Sudden spike in DLE count within 5 minutes
- Same `aggregate_id` appearing multiple times in DLE

### Query for Current State
```sql
SELECT 
  event_type,
  COUNT(*) AS count,
  MAX(created_at) AS last_occurrence,
  array_agg(DISTINCT LEFT(last_error, 100)) AS error_samples
FROM outbox
WHERE status = 'DEAD_LETTER'
GROUP BY event_type
ORDER BY count DESC;
```

---

## Root Cause Analysis (RCA) Decision Tree

```
┌─ DLE Event ─┐
       │
       ▼
┌─────────────────────────────────┐
│ Check last_error pattern        │
└─────────────────────────────────┘
       │
       ├──▶ Timeout/Connection Error
       │         │
       │         ▼
       │    INFRASTRUCTURE ISSUE
       │    → Verify network, DB health
       │    → Auto-REDRIVE after fix
       │
       ├──▶ Validation/Schema Error
       │         │
       │         ▼
       │    CONTRACT MISMATCH
       │    → Apply Upcaster
       │    → Fix producer schema
       │    → Deploy fix, then REDRIVE
       │
       └──▶ Business Rule Violation
                 │
                 ▼
            DOMAIN ERROR
            → Escalate to Product team
            → Manual correction or discard
```

---

## Redrive Procedure

### Pre-Requisites
1. ✅ Root cause identified and fixed
2. ✅ Fix deployed to all workers
3. ✅ Downstream services verified healthy

### Redrive Command

```sql
-- Redrive specific event types
UPDATE outbox
SET 
  status = 'PENDING',
  retry_count = 0,
  last_error = NULL,
  locked_until = NULL
WHERE status = 'DEAD_LETTER'
  AND event_type = 'OrderCreated';  -- Adjust filter

-- Redrive all DLE (use with caution)
UPDATE outbox
SET 
  status = 'PENDING',
  retry_count = 0,
  last_error = NULL,
  locked_until = NULL
WHERE status = 'DEAD_LETTER';
```

### Post-Redrive Verification
```sql
-- Verify events are being processed
SELECT status, COUNT(*) 
FROM outbox 
WHERE event_type = 'OrderCreated'
GROUP BY status;
```

---

## Upcasting for Schema Evolution

When payload schema changes, old events may fail. Apply transformations at read-time:

```typescript
interface Upcaster<T> {
  version: number;
  up: (payload: unknown) => T;
}

const orderUpcasters: Upcaster<OrderPayload>[] = [
  {
    version: 1,
    up: (p: any) => ({
      ...p,
      currency: p.currency ?? 'USD',  // Added in v2
      metadata: p.metadata ?? {},      // Added in v3
    })
  }
];

function applyUpcasters(payload: unknown, version: number): OrderPayload {
  let result = payload;
  for (const u of orderUpcasters.filter(u => u.version >= version)) {
    result = u.up(result);
  }
  return result as OrderPayload;
}
```

---

## Escalation Matrix

| Severity | Condition | Response Time | Escalation |
|----------|-----------|---------------|------------|
| P1 | DLE blocking revenue | 15 min | On-call SRE + Tech Lead |
| P2 | DLE > 100 events/hour | 1 hour | On-call Engineer |
| P3 | DLE < 10 events/day | Next business day | Product Owner |
