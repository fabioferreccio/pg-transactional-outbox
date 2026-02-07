# 030 — Partitioning and Retention Rules

> **RFC 2119 Normative Language**: The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in RFC 2119.

---

## 1. Partitioning Requirements

### RULE-030-001: Partitioning Is Mandatory

The outbox table MUST be partitioned.

- Non-partitioned outbox tables are **PROHIBITED in production**.
- Partitioning MUST be by time (`created_at`).

```sql
CREATE TABLE outbox (
  ...
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
```

### RULE-030-002: Partition Interval

Partition interval MUST be based on event volume:

| Daily Volume | Interval |
|--------------|----------|
| < 100K events | Weekly |
| 100K–1M events | Daily |
| > 1M events | Hourly |

### RULE-030-003: Partition Pre-Creation

Future partitions MUST be pre-created:

| Interval | Pre-create |
|----------|------------|
| Weekly | 4 weeks ahead |
| Daily | 7 days ahead |
| Hourly | 48 hours ahead |

Missing future partitions is a **critical operational failure**.

### RULE-030-004: pg_partman Automation

Partition management SHOULD use pg_partman:

```sql
SELECT partman.create_parent(
  p_parent_table := 'public.outbox',
  p_control := 'created_at',
  p_type := 'native',
  p_interval := 'daily',
  p_premake := 7
);
```

---

## 2. Retention Policy

### RULE-030-010: Explicit Retention Is Mandatory

Every outbox deployment MUST have an explicit retention policy.

- Implicit "keep forever" is **PROHIBITED**.
- Retention MUST be documented and enforced automatically.

### RULE-030-011: Retention Tiers

Data MUST flow through defined retention tiers:

| Tier | Duration | Storage | Purpose |
|------|----------|---------|---------|
| Hot | 7–30 days | Active partitions | Normal operations |
| Warm | 30–90 days | Archived partitions | Debugging, replay |
| Cold | 90 days–7 years | S3/Object storage | Compliance, audit |
| Purge | > Retention limit | Deleted | Legal requirement |

### RULE-030-012: Partition Drop Is Preferred

Old data removal MUST use partition drop, not DELETE:

```sql
-- ✅ CORRECT: Fast metadata operation
ALTER TABLE outbox DETACH PARTITION outbox_2024_01_01;
DROP TABLE outbox_2024_01_01;

-- ❌ PROHIBITED: Slow, bloats table, triggers vacuum
DELETE FROM outbox WHERE created_at < '2024-01-01';
```

### RULE-030-013: Retention Automation

Retention MUST be automated via:

1. pg_partman retention settings
2. pg_cron or external scheduler
3. Background worker in application

Manual retention management is **PROHIBITED**.

---

## 3. Archive Requirements

### RULE-030-020: Cold Storage Format

Archived partitions MUST be stored in:

| Format | Use Case |
|--------|----------|
| Parquet | Analytics, long-term |
| JSONL | Debugging, replay |
| pg_dump | Disaster recovery |

### RULE-030-021: Archive Integrity

Archived data MUST include:

1. SHA-256 hash of content
2. Row count verification
3. Timestamp of archive operation

```json
{
  "partition": "outbox_2024_01_01",
  "rows": 1234567,
  "sha256": "abc123...",
  "archived_at": "2024-02-01T00:00:00Z"
}
```

### RULE-030-022: Archive Accessibility

Archived data MUST be retrievable within:

| Tier | SLA |
|------|-----|
| Warm | 1 hour |
| Cold | 24 hours |

---

## 4. Pruning and Cleanup

### RULE-030-030: Partition Pruning Verification

Query plans MUST show partition pruning:

```sql
EXPLAIN SELECT * FROM outbox 
WHERE created_at > NOW() - INTERVAL '1 day';

-- Must show: Partitions: outbox_2024_02_07
-- Not: Partitions: ALL
```

Queries scanning all partitions in production are **PROHIBITED**.

### RULE-030-031: Empty Partition Cleanup

Empty partitions older than retention period MUST be dropped.

### RULE-030-032: Index Maintenance

Indexes on partitioned tables MUST be:

1. Created on parent (auto-inherited)
2. Monitored for bloat per partition
3. Rebuilt if bloat exceeds 30%

---

## 5. Prohibitions

### RULE-030-040: No Infinite Log

Treating the outbox as an infinite event log is **PROHIBITED**.

For event sourcing with infinite retention, use a separate Event Store.

### RULE-030-041: No Manual Deletions

Ad-hoc DELETE statements are **PROHIBITED**.

All data removal MUST go through:
1. Partition drop
2. Automated retention job
3. Audited purge process

### RULE-030-042: No Unmonitored Growth

Table size MUST be monitored.

Alert thresholds:
- Warning: > 80% of expected capacity
- Critical: > 95% of expected capacity

---

## References

- [pg_partman Documentation](https://github.com/pgpartman/pg_partman)
- [PostgreSQL Table Partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)
