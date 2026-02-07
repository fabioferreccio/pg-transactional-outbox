# 020 — Processing and Lease Rules

> **RFC 2119 Normative Language**: The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Lease-Based Locking

### RULE-020-001: Lease Acquisition Is Mandatory

Every event claim MUST acquire a time-bounded lease via `locked_until`.

```sql
UPDATE outbox
SET 
  status = 'PROCESSING',
  locked_until = NOW() + INTERVAL '30 seconds',
  lock_token = $1
WHERE id IN (
  SELECT id FROM outbox
  WHERE status = 'PENDING'
  ORDER BY created_at
  LIMIT 100
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

**Simple `SELECT FOR UPDATE` without lease is PROHIBITED.**

### RULE-020-002: Lease Duration Configuration

Lease duration MUST be:

| Scenario | Duration | Rationale |
|----------|----------|-----------|
| Default | 30 seconds | Standard processing |
| Heavy processing | 60 seconds | Complex transformations |
| External API calls | 60–120 seconds | Network latency |

Lease duration MUST be configurable at runtime.

### RULE-020-003: Fencing Token Usage

Every claim MUST include a `lock_token` (unique per worker).

- The token MUST be validated on completion/failure updates.
- Updates without matching `lock_token` MUST be rejected.

```sql
UPDATE outbox
SET status = 'COMPLETED'
WHERE id = $1 AND lock_token = $2;  -- Fencing!
```

---

## 2. Heartbeat Mechanism

### RULE-020-010: Active Heartbeat Is Required

Workers processing long-running events MUST renew the lease actively.

```typescript
// Heartbeat every 10 seconds (< lease duration)
setInterval(() => renewLease(eventId), 10000);
```

### RULE-020-011: Heartbeat Interval Constraint

Heartbeat interval MUST satisfy:

$$heartbeat\_interval < \frac{lease\_duration}{3}$$

Example: 30s lease → heartbeat every 10s maximum.

### RULE-020-012: Heartbeat Failure Handling

If heartbeat fails (database unreachable):

1. Worker MUST stop processing immediately
2. Worker MUST NOT complete the event
3. Event will be recovered by Reaper

---

## 3. Reaper (Zombie Recovery)

### RULE-020-020: Reaper Is Mandatory

A Reaper process MUST exist and run continuously.

- Reaper recovers events stuck in `PROCESSING` with expired `locked_until`.
- Absence of Reaper is a **critical deployment blocker**.

### RULE-020-021: Reaper Query

Reaper MUST execute:

```sql
UPDATE outbox
SET 
  status = 'PENDING',
  locked_until = NULL,
  lock_token = NULL
WHERE status = 'PROCESSING'
  AND locked_until < NOW()
RETURNING id;
```

### RULE-020-022: Reaper Frequency

Reaper MUST run at intervals:

| Scenario | Interval |
|----------|----------|
| Default | 10 seconds |
| High volume | 5 seconds |
| Low volume | 30 seconds |

Interval MUST be less than typical lease duration.

### RULE-020-023: Reaper Observability

Reaper MUST emit metrics:

- `reaper.recovered.count` — Events recovered per run
- `reaper.stale.duration` — How long events were stuck
- `reaper.runs.total` — Total Reaper executions

---

## 4. Worker Lifecycle

### RULE-020-030: Graceful Shutdown

Workers MUST implement graceful shutdown:

1. Stop accepting new batches
2. Complete in-flight events (within timeout)
3. Release resources
4. Exit cleanly

### RULE-020-031: Shutdown Timeout

Graceful shutdown MUST complete within:

$$shutdown\_timeout \leq lease\_duration$$

If exceeded, events will be recovered by Reaper.

### RULE-020-032: Worker Identification

Each worker instance MUST have a unique identifier used for:

- `lock_token` generation
- Log correlation
- Metric tagging

---

## 5. Concurrency Control

### RULE-020-040: SKIP LOCKED Is Mandatory

Multiple workers MUST use `FOR UPDATE SKIP LOCKED` for parallel processing.

`FOR UPDATE` without `SKIP LOCKED` is **PROHIBITED** (causes contention).

### RULE-020-041: Concurrency Limits

Worker concurrency MUST be bounded:

| Resource | Limit |
|----------|-------|
| Parallel events per worker | Configurable (default: 10) |
| Total workers per cluster | Based on DB connection budget |
| Database connections per worker | Pooled, limited |

### RULE-020-042: Backpressure Handling

Workers MUST implement backpressure:

- Pause polling when downstream is saturated
- Resume when capacity available
- Never queue unbounded events in memory

---

## 6. Prohibitions

### RULE-020-050: No Processing Without Lease

Events MUST NOT be processed without acquiring a lease.

### RULE-020-051: No Infinite Processing

Events MUST NOT be held indefinitely.

If processing exceeds `3 × lease_duration`, it SHOULD be aborted.

### RULE-020-052: No Silent Worker Death

Worker termination MUST be:

1. Logged
2. Reported to monitoring
3. Trigger Reaper recovery

---

## References

- [Lease-based Distributed Locks](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html)
- [Fencing Tokens](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html#making-the-lock-safe-with-fencing)
