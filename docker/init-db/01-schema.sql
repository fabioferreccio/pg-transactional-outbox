-- ============================================
-- Transactional Outbox: Database Initialization
-- ============================================
-- 
-- This script is executed automatically by PostgreSQL
-- when the container starts for the first time.
--
-- License: MIT
-- ============================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";

-- ============================================
-- OUTBOX TABLE (Partitioned from Day 0)
-- ============================================

CREATE TABLE outbox (
  id              BIGSERIAL,
  tracking_id     UUID NOT NULL DEFAULT gen_random_uuid(),
  aggregate_id    UUID NOT NULL,
  aggregate_type  TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  metadata        JSONB NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD_LETTER')),
  retry_count     INT NOT NULL DEFAULT 0,
  max_retries     INT NOT NULL DEFAULT 5,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at    TIMESTAMPTZ,
  locked_until    TIMESTAMPTZ,
  lock_token      BIGINT,
  last_error      TEXT,
  
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);

-- Create initial partitions (current month + next month)
DO $$
DECLARE
  current_start DATE := DATE_TRUNC('month', CURRENT_DATE);
  next_start DATE := DATE_TRUNC('month', CURRENT_DATE + INTERVAL '1 month');
  next_next_start DATE := DATE_TRUNC('month', CURRENT_DATE + INTERVAL '2 months');
BEGIN
  EXECUTE format(
    'CREATE TABLE outbox_%s PARTITION OF outbox FOR VALUES FROM (%L) TO (%L)',
    TO_CHAR(current_start, 'YYYY_MM'),
    current_start,
    next_start
  );
  
  EXECUTE format(
    'CREATE TABLE outbox_%s PARTITION OF outbox FOR VALUES FROM (%L) TO (%L)',
    TO_CHAR(next_start, 'YYYY_MM'),
    next_start,
    next_next_start
  );
END $$;

-- Indexes for hot path queries
CREATE INDEX idx_outbox_status_created 
ON outbox (status, created_at) 
WHERE status IN ('PENDING', 'FAILED');

CREATE INDEX idx_outbox_processing_lease 
ON outbox (locked_until) 
WHERE status = 'PROCESSING';

CREATE INDEX idx_outbox_aggregate 
ON outbox (aggregate_id, aggregate_type, created_at);

CREATE INDEX idx_outbox_tracking 
ON outbox (tracking_id);

-- Autovacuum tuning for high-churn table
ALTER TABLE outbox SET (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_vacuum_threshold = 1000,
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_vacuum_cost_limit = 2000,
  autovacuum_vacuum_cost_delay = 2
);

-- ============================================
-- INBOX TABLE (Consumer Idempotency)
-- ============================================

CREATE TABLE inbox (
  tracking_id     UUID PRIMARY KEY,
  consumer_id     TEXT NOT NULL,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- Index for cleanup
  CONSTRAINT inbox_unique UNIQUE (tracking_id, consumer_id)
);

CREATE INDEX idx_inbox_processed ON inbox (processed_at);

-- ============================================
-- DEAD LETTER TABLE (Poison Messages)
-- ============================================

CREATE TABLE dead_letter (
  id              BIGSERIAL PRIMARY KEY,
  original_id     BIGINT NOT NULL,
  tracking_id     UUID NOT NULL,
  aggregate_id    UUID NOT NULL,
  aggregate_type  TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  metadata        JSONB NOT NULL,
  retry_count     INT NOT NULL,
  error_history   JSONB NOT NULL DEFAULT '[]',
  moved_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  redriven_at     TIMESTAMPTZ,
  rca_notes       TEXT
);

CREATE INDEX idx_dle_tracking ON dead_letter (tracking_id);
CREATE INDEX idx_dle_moved ON dead_letter (moved_at);

-- ============================================
-- HELPER FUNCTIONS
-- ============================================

-- Claim batch with lease
CREATE OR REPLACE FUNCTION fn_claim_outbox_batch(
  p_batch_size INT,
  p_lease_seconds INT,
  p_lock_token BIGINT
)
RETURNS SETOF outbox AS $$
BEGIN
  RETURN QUERY
  UPDATE outbox
  SET 
    status = 'PROCESSING',
    locked_until = NOW() + (p_lease_seconds || ' seconds')::INTERVAL,
    lock_token = p_lock_token
  WHERE id IN (
    SELECT id
    FROM outbox
    WHERE status IN ('PENDING', 'FAILED')
      AND (locked_until IS NULL OR locked_until < NOW())
    ORDER BY created_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  RETURNING *;
END;
$$ LANGUAGE plpgsql;

-- Reaper: recover stale events
CREATE OR REPLACE FUNCTION fn_reap_stale_events()
RETURNS INT AS $$
DECLARE
  recovered INT;
BEGIN
  WITH recovered_events AS (
    UPDATE outbox
    SET 
      status = 'PENDING',
      locked_until = NULL,
      lock_token = NULL
    WHERE status = 'PROCESSING'
      AND locked_until < NOW()
    RETURNING id
  )
  SELECT COUNT(*) INTO recovered FROM recovered_events;
  
  RETURN recovered;
END;
$$ LANGUAGE plpgsql;

-- Move to dead letter
CREATE OR REPLACE FUNCTION fn_move_to_dead_letter(
  p_event_id BIGINT,
  p_lock_token BIGINT,
  p_error TEXT
)
RETURNS BOOLEAN AS $$
DECLARE
  v_event outbox;
BEGIN
  -- Get and lock the event
  SELECT * INTO v_event
  FROM outbox
  WHERE id = p_event_id AND lock_token = p_lock_token
  FOR UPDATE;
  
  IF v_event.id IS NULL THEN
    RETURN FALSE;
  END IF;
  
  -- Insert into dead letter
  INSERT INTO dead_letter (
    original_id, tracking_id, aggregate_id, aggregate_type,
    event_type, payload, metadata, retry_count, error_history
  ) VALUES (
    v_event.id, v_event.tracking_id, v_event.aggregate_id,
    v_event.aggregate_type, v_event.event_type, v_event.payload,
    v_event.metadata, v_event.retry_count,
    jsonb_build_array(jsonb_build_object(
      'error', p_error,
      'timestamp', NOW()
    ))
  );
  
  -- Update outbox status
  UPDATE outbox
  SET status = 'DEAD_LETTER', processed_at = NOW()
  WHERE id = p_event_id;
  
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- GRANTS
-- ============================================

-- Create application role
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'outbox_app') THEN
    CREATE ROLE outbox_app WITH LOGIN PASSWORD 'outbox_app_secret';
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE ON outbox TO outbox_app;
GRANT USAGE, SELECT ON SEQUENCE outbox_id_seq TO outbox_app;
GRANT SELECT, INSERT ON inbox TO outbox_app;
GRANT SELECT, INSERT ON dead_letter TO outbox_app;
GRANT USAGE, SELECT ON SEQUENCE dead_letter_id_seq TO outbox_app;

RAISE NOTICE 'Database initialization complete!';
