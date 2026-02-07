/**
 * Simple Migration Script
 * 
 * Sets up the outbox and inbox tables.
 */
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://outbox:outbox_secret@localhost:5432/outbox';

async function migrate() {
  console.log('🐘 Local Migration: Connecting to database...');
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  
  try {
    // 1. Create Outbox Table
    console.log('📦 Creating/Verifying outbox table...');
    await pool.query(`
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
      
      CREATE INDEX IF NOT EXISTS idx_outbox_status_locked ON outbox (status, locked_until) WHERE status IN ('PENDING', 'FAILED', 'PROCESSING');
      CREATE INDEX IF NOT EXISTS idx_outbox_tracking_id ON outbox (tracking_id);
    `);

    // 2. Create Inbox Table (Idempotency)
    console.log('📥 Creating/Verifying inbox table...');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inbox (
        id             BIGSERIAL PRIMARY KEY,
        tracking_id    VARCHAR(255) NOT NULL,
        consumer_id    VARCHAR(255) NOT NULL,
        processed_at   TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(tracking_id, consumer_id)
      );
    `);

    console.log('✅ Migration complete!');
  } catch (err) {
    console.error('❌ Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
