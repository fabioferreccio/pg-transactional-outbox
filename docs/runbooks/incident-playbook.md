# Incident Playbook

## Quick Reference: Symptom → Action

| Symptom | Probable Cause | Immediate Action |
|---------|---------------|------------------|
| CPU spike on DB | Index bloat or vacuum starvation | `REINDEX INDEX CONCURRENTLY`, check `pg_stat_activity` |
| Messages stuck in PROCESSING | Worker death (zombie) | Verify Reaper is running, check heartbeat logs |
| Lock contention | Long transactions | Find PID via `pg_locks`, consider `pg_terminate_backend` |
| Oldest pending > 5 min | Workers overloaded | Scale workers, check downstream services |
| DLE spike | Contract/schema mismatch | See DLE Runbook, apply upcasters |
| WAL disk full | Checkpoint lag | Increase `max_wal_size`, trigger manual checkpoint |

---

## Detailed Procedures

### 1. High CPU on Database Server

**Diagnosis**:
```sql
-- Find expensive queries
SELECT pid, now() - query_start AS duration, query
FROM pg_stat_activity
WHERE state = 'active'
ORDER BY duration DESC
LIMIT 10;

-- Check index bloat
SELECT 
  schemaname, tablename, indexname,
  pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
  idx_scan, idx_tup_read
FROM pg_stat_user_indexes
WHERE tablename LIKE 'outbox%'
ORDER BY pg_relation_size(indexrelid) DESC;
```

**Actions**:
1. `REINDEX INDEX CONCURRENTLY idx_outbox_pending_worker;`
2. Kill long-running queries if blocking
3. Review worker batch size (reduce if needed)

---

### 2. Messages Stuck in PROCESSING

**Diagnosis**:
```sql
-- Find stale processing events
SELECT 
  id, event_type, 
  NOW() - locked_until AS stale_duration,
  lock_token
FROM outbox
WHERE status = 'PROCESSING'
  AND locked_until < NOW()
ORDER BY stale_duration DESC
LIMIT 20;
```

**Actions**:
1. Verify Reaper is running: check logs for `reaper` events
2. Manual recovery if Reaper is dead:
```sql
UPDATE outbox
SET status = 'PENDING', locked_until = NULL, lock_token = NULL
WHERE status = 'PROCESSING' AND locked_until < NOW();
```
3. Investigate worker crash logs

---

### 3. Lock Contention

**Diagnosis**:
```sql
-- Find blocking sessions
SELECT 
  blocked_locks.pid AS blocked_pid,
  blocked_activity.query AS blocked_query,
  blocking_locks.pid AS blocking_pid,
  blocking_activity.query AS blocking_query
FROM pg_catalog.pg_locks blocked_locks
JOIN pg_catalog.pg_stat_activity blocked_activity 
  ON blocked_activity.pid = blocked_locks.pid
JOIN pg_catalog.pg_locks blocking_locks 
  ON blocking_locks.locktype = blocked_locks.locktype
  AND blocking_locks.relation = blocked_locks.relation
  AND blocking_locks.pid != blocked_locks.pid
JOIN pg_catalog.pg_stat_activity blocking_activity 
  ON blocking_activity.pid = blocking_locks.pid
WHERE NOT blocked_locks.granted;
```

**Actions**:
1. Wait for natural release (< 30s)
2. If critical: `SELECT pg_terminate_backend(<blocking_pid>);`
3. Review transaction isolation levels

---

### 4. WAL Disk Full

**Diagnosis**:
```sql
SELECT 
  pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0')) AS wal_size;

-- Check checkpoint status
SELECT * FROM pg_stat_bgwriter;
```

**Actions**:
1. Immediate: `CHECKPOINT;` (manual trigger)
2. Increase `max_wal_size` in postgresql.conf
3. Restart with new config
4. Archive old WAL files if archiving is enabled

---

### 5. Connection Pool Exhausted

**Diagnosis**:
```sql
SELECT 
  state, COUNT(*) 
FROM pg_stat_activity 
GROUP BY state;

SELECT 
  client_addr, COUNT(*) 
FROM pg_stat_activity 
GROUP BY client_addr
ORDER BY count DESC;
```

**Actions**:
1. Kill idle-in-transaction connections:
```sql
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE state = 'idle in transaction'
  AND query_start < NOW() - INTERVAL '5 minutes';
```
2. Scale down worker concurrency
3. Deploy PgBouncer if not present

---

## Escalation Contacts

| Level | Condition | Contact |
|-------|-----------|---------|
| L1 | Alert fired | On-call Engineer |
| L2 | > 15 min unresolved | Tech Lead |
| L3 | Data loss risk | VP Engineering |
