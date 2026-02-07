# Capacity Model

## PostgreSQL Tuning for High-Throughput Outbox

### Autovacuum Formula

The autovacuum trigger threshold is:

$$V_{threshold} = autovacuum\_vacuum\_threshold + (autovacuum\_vacuum\_scale\_factor \times T_{live\_rows})$$

**Default**: `50 + (0.2 × live_rows)` = 20% dead tuples before vacuum.

**For high-churn outbox tables**, reduce scale factor:

```sql
ALTER TABLE outbox SET (
  autovacuum_vacuum_scale_factor = 0.01,  -- 1% instead of 20%
  autovacuum_vacuum_threshold = 100,
  autovacuum_analyze_scale_factor = 0.005
);
```

---

### WAL Traffic Estimation

| Operation Type | WAL Multiplier | Notes |
|----------------|----------------|-------|
| INSERT (LOGGED) | ~1.2x row size | Full row + index entries |
| UPDATE | ~2x row size | Old + new tuple |
| DELETE | ~0.3x row size | TID only |
| UNLOGGED table | 0x | No WAL, no replication |

**Rule of Thumb**: Outbox tables generate **~30x more WAL** than business tables with same row count due to rapid INSERT/UPDATE/DELETE cycles.

### Configuration

```sql
-- postgresql.conf
max_wal_size = 4GB          -- Minimum 2GB for outbox workloads
min_wal_size = 1GB
wal_buffers = 64MB
checkpoint_timeout = 5min
checkpoint_completion_target = 0.9
```

---

### Connection Budget

| Component | Connections | Notes |
|-----------|-------------|-------|
| Worker pool | `concurrency` × workers | e.g., 10 × 4 = 40 |
| LISTEN/NOTIFY | 1 per listener | Persistent connection |
| Reaper | 1 per instance | Shared with worker |
| Application | Varies | Use PgBouncer |
| Admin/Monitoring | 5-10 | Reserved |

**Formula**:
$$max\_connections \geq (workers \times concurrency) + listeners + admin\_reserve + 20\%$$

**PgBouncer** recommended in `transaction` mode for web apps, `session` mode for workers with LISTEN.

---

### Disk I/O Budget

**IOPS Formula** (per second):
$$IOPS = \frac{events/sec \times 3}{batch\_size}$$

Where `3` = INSERT + UPDATE (processing) + UPDATE (complete).

**Example**: 10,000 events/sec with batch=100:
$$IOPS = \frac{10000 \times 3}{100} = 300 \text{ IOPS}$$

**Throughput**:
$$Throughput (MB/s) = \frac{IOPS \times 8KB}{1024} = 2.3 \text{ MB/s}$$

---

### Memory Sizing

| Parameter | Base | Per Active Partition |
|-----------|------|---------------------|
| `shared_buffers` | 25% RAM | +256MB for hot partitions |
| `work_mem` | 64MB | Per sort operation |
| `maintenance_work_mem` | 512MB | For VACUUM/REINDEX |
| `effective_cache_size` | 75% RAM | Query planner hint |

---

## Scale Ceiling

> [!CAUTION]
> PostgreSQL as outbox has a practical ceiling of **20,000–50,000 events/second**.

### Signs You're Approaching the Limit

| Metric | Warning Threshold | Critical Threshold |
|--------|-------------------|-------------------|
| Oldest pending event | > 30 seconds | > 5 minutes |
| WAL generation rate | > 100 MB/min | > 500 MB/min |
| Autovacuum lag | > 100K dead tuples | > 1M dead tuples |
| Connection wait time | > 100ms | > 1 second |

### Migration Trigger Criteria

Consider migrating to dedicated broker (Kafka) when ANY of:
- Sustained throughput > 20K events/sec
- Fan-out to > 10 consumers
- Need for event replay > 30 days
- Geographic distribution required
