# 080 — Migration and Exit Strategy Rules

> **RFC 2119 Normative Language**: The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Migration Triggers

### RULE-080-001: Scale Ceiling Recognition

The PostgreSQL outbox model MUST be evaluated for migration when:

| Metric | Warning Threshold | Critical Threshold |
|--------|-------------------|-------------------|
| Events/second | 20,000 | 50,000 |
| WAL generation | 500 MB/min | 1 GB/min |
| Pending queue depth | 100,000 | 500,000 |
| Consumer count | 10 | 20 |

### RULE-080-002: Feature-Driven Triggers

Migration evaluation MUST occur when requiring:

- Fan-out to 10+ independent consumers
- Event replay beyond retention window
- Multi-region/geo-distributed consumption
- Sub-millisecond latency guarantees
- Exactly-once delivery semantics

### RULE-080-003: Architectural Reviews

Migration readiness MUST be assessed:

- Annually (minimum)
- When approaching 50% of thresholds
- After any P1 incident related to scale

---

## 2. Target Architecture

### RULE-080-010: Approved Migration Targets

Approved external broker targets:

| Broker | Use Case |
|--------|----------|
| Apache Kafka | High throughput, strong ordering |
| Apache Pulsar | Multi-tenancy, geo-replication |
| AWS Kinesis | AWS-native, managed |
| AWS SNS/SQS | Simple fan-out |
| Google Pub/Sub | GCP-native, managed |

### RULE-080-011: CDC as Default Path

Change Data Capture (CDC) via WAL tailing MUST be the default migration approach.

Recommended tools:
- Debezium (open source)
- AWS DMS (managed)
- Kafka Connect

### RULE-080-012: Outbox Table Preservation

During migration, the outbox table MUST be preserved as:

- Source of truth for atomicity
- Fallback mechanism
- Audit trail

Direct broker writes bypassing outbox are **PROHIBITED** until full migration.

---

## 3. Migration Phases

### RULE-080-020: Phased Migration Required

Migration MUST follow sequential phases:

```
Phase 1: CDC Tailing (Parallel Read)
    ↓
Phase 2: Dual Consumption (Validation)
    ↓
Phase 3: Consumer Cutover
    ↓
Phase 4: Outbox Decommissioning (Optional)
```

Skipping phases is **PROHIBITED**.

### RULE-080-021: Phase 1 — CDC Tailing

Requirements:
- Deploy Debezium/CDC connector
- Publish to broker topics without application changes
- Validate data integrity between outbox and broker
- Duration: Minimum 2 weeks

Success criteria:
- Zero data loss
- Latency < 1 second
- Ordering preserved per aggregate

### RULE-080-022: Phase 2 — Dual Consumption

Requirements:
- Run shadow consumers on broker
- Compare results with database consumers
- Log discrepancies without affecting production
- Duration: Minimum 2 weeks

Success criteria:
- < 0.01% discrepancy rate
- All edge cases documented
- Rollback tested

### RULE-080-023: Phase 3 — Consumer Cutover

Requirements:
- Gradual traffic shift (canary/blue-green)
- Per-consumer rollout
- Real-time monitoring
- Duration: 1-4 weeks per consumer

Success criteria:
- Zero increase in error rate
- Latency meets SLA
- All consumers migrated

### RULE-080-024: Phase 4 — Decommissioning (Optional)

Requirements:
- Outbox becomes buffer only (immediate delete after CDC capture)
- OR direct broker writes (only if consumers are idempotent)
- Extended monitoring period: 30 days

Success criteria:
- No database-based consumers
- CDC lag consistently < 100ms
- Rollback capability tested

---

## 4. Rollback Requirements

### RULE-080-030: Rollback at Every Phase

Rollback procedures MUST exist for each phase:

| Phase | Rollback Action |
|-------|-----------------|
| 1 | Stop CDC connector, consumers continue from DB |
| 2 | Disable broker consumers, DB consumers continue |
| 3 | Route traffic back to DB consumers |
| 4 | Re-enable CDC, restore outbox retention |

### RULE-080-031: Rollback Testing

Rollback MUST be tested:

- In staging before each phase begins
- In production during maintenance window (Phase 1-2)
- Documented with timing and steps

### RULE-080-032: Rollback Trigger Criteria

Automatic rollback MUST trigger when:

| Metric | Threshold |
|--------|-----------|
| Error rate increase | > 1% above baseline |
| Latency increase | > 2× baseline |
| Data loss detected | Any |
| Ordering violation | > 0.1% |

---

## 5. Data Integrity

### RULE-080-040: Checksum Validation

During migration, data integrity MUST be validated:

```sql
-- Compare counts
SELECT COUNT(*) FROM outbox WHERE created_at > NOW() - INTERVAL '1 hour';
-- vs Kafka topic offset delta
```

### RULE-080-041: Ordering Validation

Event ordering per aggregate MUST be verified:

- Sequence numbers preserved
- Causal ordering maintained
- No duplicate deliveries

### RULE-080-042: No Data Loss Tolerance

Data loss during migration is **PROHIBITED**.

Any detected loss:
- Triggers immediate rollback
- Requires P1 incident
- Blocks progression

---

## 6. Post-Migration

### RULE-080-050: Post-Migration Monitoring

After Phase 3 completion:

- Extended monitoring: 30 days minimum
- Comparison metrics retained: 90 days
- Rollback capability: Maintained for 90 days

### RULE-080-051: Documentation Update

Post-migration, documentation MUST be updated:

- [ ] Architecture diagrams
- [ ] Runbooks
- [ ] On-call procedures
- [ ] Capacity models

### RULE-080-052: Outbox Retention Decision

After successful migration, decide:

| Option | When to Use |
|--------|-------------|
| Keep outbox (RECOMMENDED) | Atomicity still required |
| Keep outbox (buffer only) | Minimal latency needed |
| Remove outbox | Full Saga/Choreography pattern |

---

## 7. Hybrid Operation

### RULE-080-060: Hybrid Support

The system MUST support hybrid operation indefinitely:

- Some events via outbox + CDC
- Some events direct to broker (non-transactional)
- Per-event-type routing

### RULE-080-061: Routing Configuration

Event routing MUST be configurable:

```yaml
events:
  OrderCreated:
    path: outbox  # Transactional
  AnalyticsEvent:
    path: direct  # Non-transactional OK
```

---

## 8. Prohibitions

### RULE-080-070: No Big Bang Migration

Migrating all consumers simultaneously is **PROHIBITED**.

### RULE-080-071: No Migration Without Rollback

Proceeding without tested rollback is **PROHIBITED**.

### RULE-080-072: No Atomicity Sacrifice

Removing the outbox for transactional events without alternative atomicity guarantee is **PROHIBITED**.

### RULE-080-073: No Unmonitored Migration

Migration phases without enhanced monitoring are **PROHIBITED**.

---

## References

- [Debezium Outbox Pattern](https://debezium.io/documentation/reference/transformations/outbox-event-router.html)
- [Strangler Fig Pattern](https://martinfowler.com/bliki/StranglerFigApplication.html)
- [CDC with Kafka Connect](https://kafka.apache.org/documentation/#connect)
