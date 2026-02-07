-- ========================================
-- TRANSACTIONAL OUTBOX SCHEMA (SIMPLE)
-- Standard table without partitioning
-- ========================================

CREATE TABLE IF NOT EXISTS outbox (
  id              BIGSERIAL PRIMARY KEY,
  tracking_id     UUID NOT NULL,
  aggregate_id    UUID NOT NULL,
  aggregate_type  TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  payload         JSONB NOT NULL,
  metadata        JSONB NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'PENDING',
  retry_count     INT NOT NULL DEFAULT 0,
  max_retries     INT NOT NULL DEFAULT 5,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at    TIMESTAMPTZ,
  locked_until    TIMESTAMPTZ,
  lock_token      BIGINT,
  last_error      TEXT
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_outbox_status_locked ON outbox (status, locked_until) WHERE status IN ('PENDING', 'FAILED', 'PROCESSING');
CREATE INDEX IF NOT EXISTS idx_outbox_tracking_id ON outbox (tracking_id);
CREATE INDEX IF NOT EXISTS idx_outbox_created_at ON outbox (created_at);

-- Inbox table for idempotency
CREATE TABLE IF NOT EXISTS inbox (
  id             BIGSERIAL PRIMARY KEY,
  tracking_id    VARCHAR(255) NOT NULL,
  consumer_id    VARCHAR(255) NOT NULL,
  processed_at   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(tracking_id, consumer_id)
);
