-- ========================================
-- TRANSACTIONAL OUTBOX SCHEMA
-- Aligned with Project Principles
-- ========================================

-- ========================================
-- CORE TABLE (PARTITIONED)
-- ========================================

CREATE TABLE IF NOT EXISTS outbox (
  id              BIGSERIAL,
  tracking_id     UUID NOT NULL DEFAULT gen_random_uuid(),  -- Idempotency key
  aggregate_id    UUID NOT NULL,
  aggregate_type  TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at    TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD_LETTER')),
  retry_count     INT NOT NULL DEFAULT 0,
  max_retries     INT NOT NULL DEFAULT 5,
  locked_until    TIMESTAMPTZ,  -- Lease expiration
  lock_token      BIGINT,       -- Fencing token
  last_error      TEXT,
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- ========================================
-- INDEXES
-- ========================================

-- Worker polling: pending events ordered by time
CREATE INDEX idx_outbox_pending_worker 
ON outbox (created_at ASC)
WHERE status = 'PENDING';

-- Reaper: find stale processing records (lease expired)
CREATE INDEX idx_outbox_stale_processing 
ON outbox (locked_until)
WHERE status = 'PROCESSING';

-- Aggregate lookup (debugging/replay)
CREATE INDEX idx_outbox_aggregate 
ON outbox (aggregate_id, created_at DESC);

-- Idempotency lookup by tracking_id
CREATE UNIQUE INDEX idx_outbox_tracking_id 
ON outbox (tracking_id);

-- ========================================
-- PG_PARTMAN SETUP
-- ========================================

-- Requires: CREATE EXTENSION IF NOT EXISTS pg_partman;

SELECT partman.create_parent(
  p_parent_table := 'public.outbox',
  p_control := 'created_at',
  p_type := 'native',
  p_interval := 'daily',
  p_premake := 7,
  p_start_partition := CURRENT_DATE::text
);

-- Retention policy (30 days hot data)
UPDATE partman.part_config
SET 
  retention = '30 days',
  retention_keep_table = false,
  retention_keep_index = false
WHERE parent_table = 'public.outbox';

-- ========================================
-- WORKER CLAIM WITH LEASE
-- ========================================

-- Claim batch with lease-based locking
-- $1: batch size, $2: worker ID (lock_token), $3: lease duration (e.g., '30 seconds')
PREPARE claim_outbox_batch_with_lease (INT, BIGINT, INTERVAL) AS
UPDATE outbox
SET 
  status = 'PROCESSING',
  processed_at = NOW(),
  locked_until = NOW() + $3,
  lock_token = $2
WHERE id IN (
  SELECT id 
  FROM outbox
  WHERE status = 'PENDING'
    AND created_at < NOW() - INTERVAL '100 milliseconds'
  ORDER BY created_at ASC
  LIMIT $1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;

-- ========================================
-- HEARTBEAT (LEASE RENEWAL)
-- ========================================

-- Renew lease for event being processed
-- $1: event ID, $2: lock_token, $3: lease duration
PREPARE renew_lease (BIGINT, BIGINT, INTERVAL) AS
UPDATE outbox
SET locked_until = NOW() + $3
WHERE id = $1 
  AND lock_token = $2
  AND status = 'PROCESSING';

-- ========================================
-- REAPER (ZOMBIE RECOVERY)
-- ========================================

-- Recover stale processing events (lease expired)
-- Run periodically (e.g., every 10 seconds)
PREPARE reaper_recover_stale AS
UPDATE outbox
SET 
  status = 'PENDING',
  locked_until = NULL,
  lock_token = NULL
WHERE status = 'PROCESSING'
  AND locked_until < NOW()
RETURNING id, event_type, retry_count, 
          NOW() - locked_until AS stale_duration;

-- ========================================
-- MARK COMPLETED
-- ========================================

PREPARE mark_completed (BIGINT, BIGINT) AS
UPDATE outbox
SET 
  status = 'COMPLETED',
  processed_at = NOW(),
  locked_until = NULL
WHERE id = $1 
  AND lock_token = $2;

-- ========================================
-- MARK FAILED (WITH RETRY + DLE)
-- ========================================

PREPARE mark_failed (BIGINT, BIGINT, TEXT) AS
UPDATE outbox
SET 
  status = CASE 
    WHEN retry_count + 1 >= max_retries THEN 'DEAD_LETTER'
    ELSE 'PENDING'
  END,
  retry_count = retry_count + 1,
  last_error = $3,
  processed_at = NOW(),
  locked_until = NULL
WHERE id = $1 
  AND lock_token = $2;

-- ========================================
-- DLE REDRIVE
-- ========================================

-- Move events from DEAD_LETTER back to PENDING
-- Use after fixing root cause
-- $1: event_type filter (optional, use '%' for all)
PREPARE redrive_dle (TEXT) AS
UPDATE outbox
SET 
  status = 'PENDING',
  retry_count = 0,
  last_error = NULL,
  locked_until = NULL
WHERE status = 'DEAD_LETTER'
  AND event_type LIKE $1
RETURNING id, event_type, aggregate_id;

-- ========================================
-- IDEMPOTENCY CHECK
-- ========================================

-- Consumer should call this before processing
-- Returns TRUE if event was already processed
PREPARE check_idempotency (UUID) AS
SELECT EXISTS (
  SELECT 1 FROM outbox 
  WHERE tracking_id = $1 
    AND status = 'COMPLETED'
);

-- ========================================
-- GAP DETECTION
-- ========================================

-- Find specific missing IDs
SELECT gs.id AS missing_id
FROM generate_series(
  (SELECT MIN(id) FROM outbox),
  (SELECT MAX(id) FROM outbox)
) gs(id)
LEFT JOIN outbox o ON o.id = gs.id
WHERE o.id IS NULL
LIMIT 1000;

-- Find gap ranges (efficient for large gaps)
SELECT 
  id + 1 AS gap_start,
  next_id - 1 AS gap_end,
  next_id - id - 1 AS gap_size
FROM (
  SELECT id, LEAD(id) OVER (ORDER BY id) AS next_id
  FROM outbox
) t
WHERE next_id - id > 1
ORDER BY gap_size DESC
LIMIT 100;

-- ========================================
-- OBSERVABILITY QUERIES
-- ========================================

-- Oldest pending event (alert if > 5 minutes)
SELECT 
  EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) AS oldest_pending_seconds,
  COUNT(*) AS pending_count
FROM outbox 
WHERE status = 'PENDING';

-- Stale processing count (should be 0 if Reaper is healthy)
SELECT 
  COUNT(*) AS stale_processing_count,
  MAX(NOW() - locked_until) AS max_stale_duration
FROM outbox
WHERE status = 'PROCESSING'
  AND locked_until < NOW();

-- Processing throughput (last hour)
SELECT 
  DATE_TRUNC('minute', processed_at) AS minute,
  COUNT(*) AS completed,
  AVG(EXTRACT(EPOCH FROM (processed_at - created_at))) AS avg_latency_seconds
FROM outbox
WHERE status = 'COMPLETED'
  AND processed_at > NOW() - INTERVAL '1 hour'
GROUP BY 1
ORDER BY 1 DESC;

-- Dead Letter Event stats
SELECT 
  event_type,
  COUNT(*) AS count,
  MAX(retry_count) AS max_retries,
  array_agg(DISTINCT LEFT(last_error, 100)) AS error_samples
FROM outbox
WHERE status = 'DEAD_LETTER'
GROUP BY event_type;

-- Table bloat estimate
SELECT 
  schemaname || '.' || tablename AS table_name,
  pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) AS total_size,
  n_dead_tup AS dead_tuples,
  n_live_tup AS live_tuples,
  ROUND(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 2) AS dead_pct
FROM pg_stat_user_tables
WHERE tablename LIKE 'outbox%'
ORDER BY n_dead_tup DESC;

-- Autovacuum lag monitoring
SELECT 
  schemaname || '.' || relname AS table_name,
  n_dead_tup,
  last_autovacuum,
  autovacuum_count
FROM pg_stat_user_tables
  AND n_dead_tup > 1000;

-- ========================================
-- INBOX TABLE (Idempotency)
-- ========================================

CREATE TABLE IF NOT EXISTS inbox (
  id             BIGSERIAL PRIMARY KEY,
  tracking_id    VARCHAR(255) NOT NULL,
  consumer_id    VARCHAR(255) NOT NULL,
  processed_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tracking_id, consumer_id)
);
