# 050 — Observability and Capacity Rules

> **RFC 2119 Normative Language**: The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Mandatory Metrics

### RULE-050-001: Core Metrics Required

The following metrics MUST be collected and exposed:

| Metric | Type | Description |
|--------|------|-------------|
| `outbox.events.pending` | Gauge | Current pending count |
| `outbox.events.processing` | Gauge | Currently being processed |
| `outbox.events.completed` | Counter | Total completed |
| `outbox.events.failed` | Counter | Total failures |
| `outbox.events.dead_letter` | Counter | Moved to DLE |
| `outbox.processing.latency` | Histogram | Time from created to completed |
| `outbox.oldest_pending.age` | Gauge | Age of oldest pending event |

### RULE-050-002: Worker Metrics Required

Worker processes MUST emit:

| Metric | Type | Description |
|--------|------|-------------|
| `worker.batches.processed` | Counter | Batches claimed |
| `worker.events.per_batch` | Histogram | Events per batch |
| `worker.heartbeats.sent` | Counter | Lease renewals |
| `worker.reaper.recovered` | Counter | Zombie events recovered |

### RULE-050-003: PostgreSQL Metrics Required

Database health MUST be monitored:

| Metric | Query/Source | Alert Threshold |
|--------|-------------|-----------------|
| Dead tuples | `pg_stat_user_tables.n_dead_tup` | > 100K |
| Table bloat | `pg_relation_size` vs live rows | > 30% |
| WAL generation | `pg_current_wal_lsn` delta | > 100MB/min |
| Autovacuum lag | `last_autovacuum` age | > 1 hour |
| Replication lag | `pg_stat_replication` | > 10 seconds |
| Connection count | `pg_stat_activity` | > 80% of max |

---

## 2. Distributed Tracing

### RULE-050-010: Trace Propagation Is Mandatory

Every event payload MUST include tracing context:

```json
{
  "payload": { ... },
  "metadata": {
    "trace_id": "abc123",
    "span_id": "def456",
    "baggage": { ... }
  }
}
```

### RULE-050-011: Trace Continuity

Consumers MUST:

1. Extract `trace_id` and `span_id` from event
2. Create child span for processing
3. Propagate context to downstream calls

### RULE-050-012: Trace Sampling

Trace sampling rate MUST be configurable:

| Environment | Default Rate |
|-------------|--------------|
| Development | 100% |
| Staging | 50% |
| Production | 10% |

High-value events (payments, orders) SHOULD be sampled at 100%.

---

## 3. Logging Standards

### RULE-050-020: Structured Logging Required

All log entries MUST be structured (JSON):

```json
{
  "timestamp": "2024-02-07T12:00:00Z",
  "level": "info",
  "message": "Event processed",
  "event_id": 12345,
  "tracking_id": "uuid",
  "event_type": "OrderCreated",
  "duration_ms": 150,
  "trace_id": "abc123"
}
```

### RULE-050-021: Correlation Fields

Every log entry MUST include:

| Field | Description |
|-------|-------------|
| `event_id` | Outbox ID |
| `tracking_id` | Idempotency key |
| `trace_id` | Distributed trace |
| `worker_id` | Processing worker |

### RULE-050-022: Error Logging

Errors MUST include:

- Full stack trace
- Event payload (sanitized)
- Retry count
- Error category

---

## 4. Alerting Rules

### RULE-050-030: Alert Hierarchy

Alerts MUST follow severity levels:

| Severity | Condition | Response Time |
|----------|-----------|---------------|
| P1 Critical | Queue blocked, data loss risk | 15 minutes |
| P2 High | Performance degradation | 1 hour |
| P3 Medium | Anomaly detected | 4 hours |
| P4 Low | Informational | Next business day |

### RULE-050-031: Required Alerts

The following alerts MUST exist:

| Alert | Condition | Severity |
|-------|-----------|----------|
| Queue Stall | Oldest pending > 5 min | P1 |
| DLE Spike | DLE count > 10 in 5 min | P2 |
| Worker Down | No heartbeats for 2 min | P2 |
| Autovacuum Starvation | Dead tuples > 500K | P2 |
| Connection Exhaustion | Connections > 90% | P2 |
| Partition Missing | No partition for tomorrow | P1 |

### RULE-050-032: Alert Fatigue Prevention

Alerts MUST:

- Have clear ownership
- Be actionable
- Include runbook link
- Be deduplicated

False-positive-prone alerts MUST be tuned or removed.

---

## 5. Capacity Planning

### RULE-050-040: Capacity Model Required

Every deployment MUST have a documented capacity model:

| Parameter | Formula |
|-----------|---------|
| IOPS | `events_per_sec × 3 / batch_size` |
| WAL/min | `events_per_sec × avg_event_size × 1.2` |
| Connections | `workers × concurrency + listeners + reserve` |
| Storage/day | `events_per_day × avg_event_size × 1.5` |

### RULE-050-041: Scale Ceiling

PostgreSQL outbox has a practical ceiling:

| Metric | Warning | Critical |
|--------|---------|----------|
| Events/second | 20,000 | 50,000 |
| WAL/minute | 500 MB | 1 GB |
| Pending queue | 100,000 | 500,000 |

Exceeding critical thresholds triggers migration evaluation.

### RULE-050-042: Growth Projections

Capacity MUST be reviewed:

- Monthly: Compare actual vs projected
- Quarterly: Update capacity model
- Annually: Full architecture review

---

## 6. Health Checks

### RULE-050-050: Liveness Check

Workers MUST expose liveness endpoint:

```
GET /health/live → 200 OK
```

Failure indicates process should be restarted.

### RULE-050-051: Readiness Check

Workers MUST expose readiness endpoint:

```
GET /health/ready → 200 OK (if can process)
                 → 503 (if cannot)
```

Failure removes worker from load balancer.

### RULE-050-052: Database Health Check

Health checks MUST verify:

1. Database connectivity
2. Outbox table accessible
3. Recent partitions exist

---

## 7. Prohibitions

### RULE-050-060: No Blind Scaling

Scaling workers without observability data is **PROHIBITED**.

### RULE-050-061: No Production Without Monitoring

Deployments without monitoring are **PROHIBITED**.

Required before production:
- [ ] All core metrics exposed
- [ ] Alerts configured
- [ ] Dashboard available
- [ ] Runbooks linked

### RULE-050-062: No Ignored Metrics

Metrics MUST be reviewed weekly.

Unused metrics SHOULD be deprecated.
Critical metric gaps MUST be addressed.

---

## References

- [RED Method](https://grafana.com/blog/2018/08/02/the-red-method-how-to-instrument-your-services/)
- [USE Method](http://www.brendangregg.com/usemethod.html)
- [OpenTelemetry](https://opentelemetry.io/)
