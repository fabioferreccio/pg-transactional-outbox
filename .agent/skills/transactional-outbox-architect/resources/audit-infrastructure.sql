-- ============================================
-- Transactional Outbox: Audit Infrastructure
-- ============================================
-- 
-- Provides:
-- 1. pgAudit configuration for compliance
-- 2. Trigger-based JSONB audit for data changes
-- 3. Gap detection queries for sequence integrity
-- 4. Autovacuum tuning for high-throughput outbox
--
-- License: MIT
-- ============================================

-- ============================================
-- SECTION 1: pgAudit CONFIGURATION
-- ============================================
-- 
-- Enable in postgresql.conf:
-- shared_preload_libraries = 'pgaudit'
-- pgaudit.log = 'write, ddl'
-- pgaudit.log_catalog = off
-- pgaudit.log_level = 'log'
-- pgaudit.log_parameter = on

-- Create audit role
CREATE ROLE auditor NOLOGIN;

-- Grant audit permissions
GRANT SELECT ON outbox TO auditor;

-- Configure object-level auditing for outbox table
COMMENT ON TABLE outbox IS 'pgaudit.log = ''write''';

-- ============================================
-- SECTION 2: TRIGGER-BASED JSONB AUDIT
-- ============================================

-- Audit log table
CREATE TABLE IF NOT EXISTS outbox_audit_log (
  id              BIGSERIAL PRIMARY KEY,
  event_id        BIGINT NOT NULL,
  tracking_id     UUID NOT NULL,
  operation       CHAR(1) NOT NULL CHECK (operation IN ('I', 'U', 'D')),
  old_data        JSONB,
  new_data        JSONB,
  changed_fields  TEXT[],
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by      TEXT DEFAULT current_user,
  session_id      TEXT DEFAULT pg_backend_pid()::TEXT,
  application_name TEXT DEFAULT current_setting('application_name'),
  
  -- Index for fast lookups
  CONSTRAINT audit_operation_valid CHECK (
    (operation = 'I' AND old_data IS NULL) OR
    (operation = 'D' AND new_data IS NULL) OR
    (operation = 'U' AND old_data IS NOT NULL AND new_data IS NOT NULL)
  )
);

-- Indexes for audit queries
CREATE INDEX idx_audit_event_id ON outbox_audit_log (event_id);
CREATE INDEX idx_audit_tracking_id ON outbox_audit_log (tracking_id);
CREATE INDEX idx_audit_changed_at ON outbox_audit_log (changed_at);
CREATE INDEX idx_audit_operation ON outbox_audit_log (operation);

-- Audit trigger function
CREATE OR REPLACE FUNCTION fn_outbox_audit()
RETURNS TRIGGER AS $$
DECLARE
  v_old_data JSONB;
  v_new_data JSONB;
  v_changed_fields TEXT[];
  v_key TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_new_data := to_jsonb(NEW);
    
    INSERT INTO outbox_audit_log (
      event_id, tracking_id, operation, old_data, new_data, changed_fields
    ) VALUES (
      NEW.id, NEW.tracking_id, 'I', NULL, v_new_data, NULL
    );
    
    RETURN NEW;
    
  ELSIF TG_OP = 'UPDATE' THEN
    v_old_data := to_jsonb(OLD);
    v_new_data := to_jsonb(NEW);
    
    -- Detect changed fields
    SELECT array_agg(key)
    INTO v_changed_fields
    FROM (
      SELECT key FROM jsonb_each(v_old_data)
      EXCEPT
      SELECT key FROM jsonb_each(v_new_data)
      UNION
      SELECT key FROM jsonb_each(v_new_data)
      EXCEPT
      SELECT key FROM jsonb_each(v_old_data)
      UNION
      SELECT key 
      FROM jsonb_each(v_old_data) AS o
      JOIN jsonb_each(v_new_data) AS n USING (key)
      WHERE o.value IS DISTINCT FROM n.value
    ) changed;
    
    -- Only audit if something actually changed
    IF array_length(v_changed_fields, 1) > 0 THEN
      INSERT INTO outbox_audit_log (
        event_id, tracking_id, operation, old_data, new_data, changed_fields
      ) VALUES (
        NEW.id, NEW.tracking_id, 'U', v_old_data, v_new_data, v_changed_fields
      );
    END IF;
    
    RETURN NEW;
    
  ELSIF TG_OP = 'DELETE' THEN
    v_old_data := to_jsonb(OLD);
    
    INSERT INTO outbox_audit_log (
      event_id, tracking_id, operation, old_data, new_data, changed_fields
    ) VALUES (
      OLD.id, OLD.tracking_id, 'D', v_old_data, NULL, NULL
    );
    
    RETURN OLD;
  END IF;
  
  RETURN NULL;
END;
$$ LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path = public;

-- Attach trigger to outbox table
DROP TRIGGER IF EXISTS trg_outbox_audit ON outbox;
CREATE TRIGGER trg_outbox_audit
  AFTER INSERT OR UPDATE OR DELETE ON outbox
  FOR EACH ROW EXECUTE FUNCTION fn_outbox_audit();

-- ============================================
-- SECTION 3: GAP DETECTION QUERIES
-- ============================================

-- Detect gaps in ID sequence (for non-partitioned tables)
CREATE OR REPLACE FUNCTION fn_detect_outbox_gaps(
  p_start_id BIGINT DEFAULT 1,
  p_end_id BIGINT DEFAULT NULL
)
RETURNS TABLE (
  gap_start BIGINT,
  gap_end BIGINT,
  gap_size BIGINT
) AS $$
BEGIN
  RETURN QUERY
  WITH RECURSIVE boundaries AS (
    SELECT 
      id,
      LEAD(id) OVER (ORDER BY id) AS next_id
    FROM outbox
    WHERE id >= p_start_id
      AND (p_end_id IS NULL OR id <= p_end_id)
  )
  SELECT 
    b.id + 1 AS gap_start,
    b.next_id - 1 AS gap_end,
    b.next_id - b.id - 1 AS gap_size
  FROM boundaries b
  WHERE b.next_id IS NOT NULL
    AND b.next_id <> b.id + 1
  ORDER BY gap_start;
END;
$$ LANGUAGE plpgsql;

-- Detect gaps with date range (for partitioned tables)
CREATE OR REPLACE FUNCTION fn_detect_outbox_gaps_by_date(
  p_start_date TIMESTAMPTZ,
  p_end_date TIMESTAMPTZ DEFAULT NOW()
)
RETURNS TABLE (
  gap_start BIGINT,
  gap_end BIGINT,
  gap_size BIGINT,
  approximate_date TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  WITH events AS (
    SELECT 
      id,
      created_at,
      LEAD(id) OVER (ORDER BY id) AS next_id,
      LEAD(created_at) OVER (ORDER BY id) AS next_created_at
    FROM outbox
    WHERE created_at >= p_start_date
      AND created_at <= p_end_date
  )
  SELECT 
    e.id + 1 AS gap_start,
    e.next_id - 1 AS gap_end,
    e.next_id - e.id - 1 AS gap_size,
    e.created_at AS approximate_date
  FROM events e
  WHERE e.next_id IS NOT NULL
    AND e.next_id <> e.id + 1
  ORDER BY gap_start;
END;
$$ LANGUAGE plpgsql;

-- Gap summary view
CREATE OR REPLACE VIEW v_outbox_gap_summary AS
SELECT
  COUNT(*) AS total_gaps,
  SUM(gap_size) AS total_missing_ids,
  MIN(gap_start) AS first_gap_start,
  MAX(gap_end) AS last_gap_end,
  AVG(gap_size)::NUMERIC(10,2) AS avg_gap_size
FROM fn_detect_outbox_gaps_by_date(NOW() - INTERVAL '24 hours');

-- Scheduled gap audit (pg_cron job)
-- SELECT cron.schedule('outbox_gap_audit', '0 * * * *', $$
--   INSERT INTO outbox_audit_log (event_id, tracking_id, operation, new_data)
--   SELECT 
--     0, gen_random_uuid(), 'I',
--     jsonb_build_object(
--       'audit_type', 'gap_detection',
--       'gaps_found', (SELECT COUNT(*) FROM fn_detect_outbox_gaps_by_date(NOW() - INTERVAL '1 hour')),
--       'total_missing', (SELECT COALESCE(SUM(gap_size), 0) FROM fn_detect_outbox_gaps_by_date(NOW() - INTERVAL '1 hour')),
--       'checked_at', NOW()
--     )
-- $$);

-- ============================================
-- SECTION 4: AUTOVACUUM TUNING
-- ============================================

-- Aggressive autovacuum for high-churn outbox table
ALTER TABLE outbox SET (
  -- Trigger vacuum at 1% dead tuples instead of 20%
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_vacuum_threshold = 1000,
  
  -- Trigger analyze at 2% changed tuples
  autovacuum_analyze_scale_factor = 0.02,
  autovacuum_analyze_threshold = 500,
  
  -- Increase cost limit for faster vacuum
  autovacuum_vacuum_cost_limit = 2000,
  autovacuum_vacuum_cost_delay = 2,
  
  -- More aggressive freezing
  autovacuum_freeze_max_age = 100000000,
  autovacuum_freeze_table_age = 80000000,
  
  -- Parallel vacuum (PostgreSQL 13+)
  parallel_workers = 4
);

-- Same settings for audit log
ALTER TABLE outbox_audit_log SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_vacuum_threshold = 5000,
  autovacuum_analyze_scale_factor = 0.05
);

-- Function to check autovacuum health
CREATE OR REPLACE FUNCTION fn_check_outbox_vacuum_health()
RETURNS TABLE (
  table_name TEXT,
  live_tuples BIGINT,
  dead_tuples BIGINT,
  dead_ratio NUMERIC,
  last_vacuum TIMESTAMPTZ,
  last_autovacuum TIMESTAMPTZ,
  vacuum_needed BOOLEAN,
  autovacuum_running BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  SELECT
    s.relname::TEXT AS table_name,
    s.n_live_tup AS live_tuples,
    s.n_dead_tup AS dead_tuples,
    CASE WHEN s.n_live_tup + s.n_dead_tup > 0 
      THEN ROUND(100.0 * s.n_dead_tup / (s.n_live_tup + s.n_dead_tup), 2)
      ELSE 0 
    END AS dead_ratio,
    s.last_vacuum,
    s.last_autovacuum,
    s.n_dead_tup > 10000 AS vacuum_needed,
    EXISTS (
      SELECT 1 FROM pg_stat_progress_vacuum
      WHERE relid = s.relid
    ) AS autovacuum_running
  FROM pg_stat_user_tables s
  WHERE s.relname IN ('outbox', 'outbox_audit_log');
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- SECTION 5: COMPLIANCE VIEWS
-- ============================================

-- GDPR: Data subject access view
CREATE OR REPLACE VIEW v_outbox_data_subject_access AS
SELECT
  o.id,
  o.tracking_id,
  o.aggregate_id,
  o.aggregate_type,
  o.event_type,
  o.created_at,
  o.status,
  -- Redact sensitive fields in payload
  CASE 
    WHEN o.payload ? 'pii' THEN 
      jsonb_set(o.payload, '{pii}', '"[REDACTED]"'::jsonb)
    ELSE o.payload
  END AS payload_redacted
FROM outbox o;

-- SOX: Audit trail completeness
CREATE OR REPLACE VIEW v_outbox_sox_audit AS
SELECT
  DATE_TRUNC('day', a.changed_at) AS audit_date,
  a.operation,
  COUNT(*) AS operation_count,
  COUNT(DISTINCT a.changed_by) AS unique_operators,
  COUNT(DISTINCT a.session_id) AS unique_sessions
FROM outbox_audit_log a
GROUP BY DATE_TRUNC('day', a.changed_at), a.operation
ORDER BY audit_date DESC, operation;

-- HIPAA: Access log
CREATE OR REPLACE VIEW v_outbox_hipaa_access_log AS
SELECT
  a.id AS access_id,
  a.event_id,
  a.tracking_id,
  a.operation,
  a.changed_at AS access_time,
  a.changed_by AS accessor,
  a.application_name,
  -- Mask PHI in payload
  CASE 
    WHEN a.new_data ? 'phi' THEN '[PHI ACCESSED]'
    ELSE 'No PHI'
  END AS phi_flag
FROM outbox_audit_log a
WHERE a.changed_at >= NOW() - INTERVAL '90 days';

-- ============================================
-- SECTION 6: MAINTENANCE PROCEDURES
-- ============================================

-- Archive old audit logs
CREATE OR REPLACE FUNCTION fn_archive_outbox_audit(
  p_retention_days INT DEFAULT 90
)
RETURNS BIGINT AS $$
DECLARE
  v_archived BIGINT;
BEGIN
  WITH archived AS (
    DELETE FROM outbox_audit_log
    WHERE changed_at < NOW() - (p_retention_days || ' days')::INTERVAL
    RETURNING *
  )
  SELECT COUNT(*) INTO v_archived FROM archived;
  
  RETURN v_archived;
END;
$$ LANGUAGE plpgsql;

-- Verify audit integrity
CREATE OR REPLACE FUNCTION fn_verify_audit_integrity(
  p_start_date TIMESTAMPTZ,
  p_end_date TIMESTAMPTZ DEFAULT NOW()
)
RETURNS TABLE (
  event_id BIGINT,
  tracking_id UUID,
  issue_type TEXT
) AS $$
BEGIN
  -- Check for events without corresponding audit insert
  RETURN QUERY
  SELECT 
    o.id AS event_id,
    o.tracking_id,
    'Missing INSERT audit'::TEXT AS issue_type
  FROM outbox o
  LEFT JOIN outbox_audit_log a ON a.event_id = o.id AND a.operation = 'I'
  WHERE o.created_at >= p_start_date
    AND o.created_at <= p_end_date
    AND a.id IS NULL;
    
  -- Check for orphaned audit records
  RETURN QUERY
  SELECT 
    a.event_id,
    a.tracking_id,
    'Orphaned audit record'::TEXT AS issue_type
  FROM outbox_audit_log a
  LEFT JOIN outbox o ON o.id = a.event_id
  WHERE a.changed_at >= p_start_date
    AND a.changed_at <= p_end_date
    AND o.id IS NULL;
END;
$$ LANGUAGE plpgsql;
