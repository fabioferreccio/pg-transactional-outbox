-- ============================================
-- pg_logical_emit_message() Direct WAL Writing
-- ============================================
-- 
-- This technique bypasses the physical outbox table entirely,
-- writing events directly to the PostgreSQL WAL stream.
-- 
-- Benefits:
-- - Zero table bloat (no MVCC overhead)
-- - Zero lock contention on outbox table
-- - Near-zero latency to CDC
-- - No vacuum required
--
-- Requirements:
-- - PostgreSQL 9.6+ with logical replication
-- - Debezium or custom WAL decoder
-- - wal_level = logical
--
-- CAUTION: Events are not queryable! 
-- This is for ultra-high-throughput scenarios only.
-- ============================================

-- Enable logical replication (postgresql.conf)
-- wal_level = logical
-- max_replication_slots = 10
-- max_wal_senders = 10

-- ============================================
-- SECTION 1: CREATE REPLICATION SLOT
-- ============================================

-- Create a logical replication slot for CDC
SELECT pg_create_logical_replication_slot(
  'outbox_slot',
  'pgoutput'  -- or 'wal2json' for JSON output
);

-- For Debezium, use:
-- SELECT pg_create_logical_replication_slot('debezium', 'pgoutput');

-- ============================================
-- SECTION 2: EMIT MESSAGE FUNCTION
-- ============================================

-- Wrapper function for type-safe message emission
CREATE OR REPLACE FUNCTION emit_outbox_event(
  p_aggregate_id UUID,
  p_aggregate_type TEXT,
  p_event_type TEXT,
  p_payload JSONB,
  p_metadata JSONB DEFAULT '{}'::JSONB
)
RETURNS BOOLEAN AS $$
DECLARE
  v_tracking_id UUID := gen_random_uuid();
  v_message JSONB;
  v_prefix TEXT;
BEGIN
  -- Build the event message
  v_message := jsonb_build_object(
    'tracking_id', v_tracking_id,
    'aggregate_id', p_aggregate_id,
    'aggregate_type', p_aggregate_type,
    'event_type', p_event_type,
    'payload', p_payload,
    'metadata', p_metadata || jsonb_build_object(
      'emitted_at', NOW(),
      'schema_version', 1
    )
  );
  
  -- Prefix for filtering in Debezium
  v_prefix := 'outbox.' || p_aggregate_type || '.' || p_event_type;
  
  -- Emit directly to WAL
  -- transactional = true means it's part of current transaction
  PERFORM pg_logical_emit_message(
    true,        -- transactional (tied to current TX)
    v_prefix,    -- prefix for filtering
    v_message::TEXT
  );
  
  RETURN true;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- SECTION 3: USAGE EXAMPLE
-- ============================================

-- Example: Order creation with WAL-based event emission
CREATE OR REPLACE FUNCTION create_order(
  p_customer_id UUID,
  p_items JSONB,
  p_total NUMERIC
)
RETURNS UUID AS $$
DECLARE
  v_order_id UUID := gen_random_uuid();
BEGIN
  -- Insert the order
  INSERT INTO orders (id, customer_id, items, total, status)
  VALUES (v_order_id, p_customer_id, p_items, p_total, 'created');
  
  -- Emit event directly to WAL (no outbox table!)
  PERFORM emit_outbox_event(
    v_order_id,
    'Order',
    'OrderCreated',
    jsonb_build_object(
      'order_id', v_order_id,
      'customer_id', p_customer_id,
      'items', p_items,
      'total', p_total
    ),
    jsonb_build_object(
      'trace_id', current_setting('app.trace_id', true),
      'user_id', current_setting('app.user_id', true)
    )
  );
  
  RETURN v_order_id;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- SECTION 4: DEBEZIUM CONFIGURATION
-- ============================================

/*
Debezium connector configuration (JSON):

{
  "name": "outbox-connector",
  "config": {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
    "database.hostname": "postgres",
    "database.port": "5432",
    "database.user": "debezium",
    "database.password": "${secrets:db-password}",
    "database.dbname": "app",
    "database.server.name": "outbox",
    "slot.name": "outbox_slot",
    "plugin.name": "pgoutput",
    
    // Capture logical messages
    "include.unknown.datatypes": true,
    "provide.transaction.metadata": true,
    
    // Message filtering
    "message.prefix.include.list": "outbox.*",
    
    // Transforms
    "transforms": "outbox",
    "transforms.outbox.type": "io.debezium.transforms.ByLogicalTableRouter",
    "transforms.outbox.topic.regex": "outbox\\.(.+)\\.(.+)",
    "transforms.outbox.topic.replacement": "events.$1.$2"
  }
}
*/

-- ============================================
-- SECTION 5: HYBRID APPROACH (TABLE + WAL)
-- ============================================

-- For systems requiring queryable events + WAL performance
-- Use a thin audit table with WAL emission

CREATE OR REPLACE FUNCTION emit_outbox_event_hybrid(
  p_aggregate_id UUID,
  p_aggregate_type TEXT,
  p_event_type TEXT,
  p_payload JSONB,
  p_metadata JSONB DEFAULT '{}'::JSONB
)
RETURNS UUID AS $$
DECLARE
  v_tracking_id UUID := gen_random_uuid();
  v_message JSONB;
  v_prefix TEXT;
BEGIN
  -- Build message
  v_message := jsonb_build_object(
    'tracking_id', v_tracking_id,
    'aggregate_id', p_aggregate_id,
    'aggregate_type', p_aggregate_type,
    'event_type', p_event_type,
    'payload', p_payload,
    'metadata', p_metadata || jsonb_build_object(
      'emitted_at', NOW()
    )
  );
  
  -- 1. Write to thin audit table (minimal data for queries)
  INSERT INTO outbox_audit (
    tracking_id, 
    aggregate_id, 
    aggregate_type, 
    event_type, 
    created_at
  ) VALUES (
    v_tracking_id,
    p_aggregate_id,
    p_aggregate_type,
    p_event_type,
    NOW()
  );
  
  -- 2. Write full payload to WAL
  v_prefix := 'outbox.' || p_aggregate_type || '.' || p_event_type;
  PERFORM pg_logical_emit_message(true, v_prefix, v_message::TEXT);
  
  RETURN v_tracking_id;
END;
$$ LANGUAGE plpgsql;

-- Thin audit table (no payload = minimal bloat)
CREATE TABLE IF NOT EXISTS outbox_audit (
  tracking_id UUID PRIMARY KEY,
  aggregate_id UUID NOT NULL,
  aggregate_type TEXT NOT NULL,
  event_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
) PARTITION BY RANGE (created_at);

-- Minimal indexes
CREATE INDEX idx_outbox_audit_aggregate 
ON outbox_audit (aggregate_id, created_at);

CREATE INDEX idx_outbox_audit_type 
ON outbox_audit (event_type, created_at);

-- ============================================
-- SECTION 6: MONITORING WAL EMISSION
-- ============================================

-- View current replication slots
CREATE OR REPLACE VIEW v_replication_slot_status AS
SELECT
  slot_name,
  plugin,
  slot_type,
  active,
  active_pid,
  restart_lsn,
  confirmed_flush_lsn,
  pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS lag_bytes,
  pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS lag_pretty
FROM pg_replication_slots
WHERE slot_type = 'logical';

-- Monitor WAL message throughput
-- This requires a custom decoder or Debezium metrics

-- ============================================
-- SECTION 7: CLEANUP AND MAINTENANCE
-- ============================================

-- Drop unused replication slots (CAUTION!)
-- SELECT pg_drop_replication_slot('outbox_slot');

-- Monitor slot lag to prevent WAL bloat
CREATE OR REPLACE FUNCTION fn_check_replication_health()
RETURNS TABLE (
  slot_name NAME,
  is_active BOOLEAN,
  lag_bytes BIGINT,
  lag_warning BOOLEAN,
  lag_critical BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.slot_name,
    s.active AS is_active,
    pg_wal_lsn_diff(pg_current_wal_lsn(), s.restart_lsn) AS lag_bytes,
    pg_wal_lsn_diff(pg_current_wal_lsn(), s.restart_lsn) > 104857600 AS lag_warning,  -- 100MB
    pg_wal_lsn_diff(pg_current_wal_lsn(), s.restart_lsn) > 1073741824 AS lag_critical  -- 1GB
  FROM pg_replication_slots s
  WHERE s.slot_type = 'logical';
END;
$$ LANGUAGE plpgsql;
