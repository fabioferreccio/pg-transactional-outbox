/**
 * Outbox Repository Integration Tests
 * 
 * Requires PostgreSQL to be running with test schema.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Pool } from 'pg';
import { PostgresOutboxRepository } from '../../src/adapters/persistence/postgres-outbox.repository.js';
import { OutboxEvent } from '../../src/core/domain/entities/outbox-event.js';

describe('PostgresOutboxRepository (Integration)', () => {
  let pool: Pool;
  let repository: PostgresOutboxRepository;

  beforeAll(async () => {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL ?? 'postgresql://outbox:outbox_secret@localhost:5432/outbox_test',
    });
    
    repository = new PostgresOutboxRepository(pool);
    
    // Run schema setup
    await pool.query(`
      CREATE TABLE IF NOT EXISTS outbox (
        id BIGSERIAL PRIMARY KEY,
        tracking_id UUID NOT NULL,
        aggregate_id UUID NOT NULL,
        aggregate_type TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload JSONB NOT NULL,
        metadata JSONB NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'PENDING',
        retry_count INT NOT NULL DEFAULT 0,
        max_retries INT NOT NULL DEFAULT 5,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,
        locked_until TIMESTAMPTZ,
        lock_token BIGINT,
        last_error TEXT
      )
    `);
  });

  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS outbox CASCADE');
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE outbox');
  });

  // TODO: Implement actual integration tests when repository is complete
  
  it('should insert and retrieve an event', async () => {
    const event = OutboxEvent.create({
      trackingId: crypto.randomUUID(),
      aggregateId: crypto.randomUUID(),
      aggregateType: 'Order',
      eventType: 'OrderCreated',
      payload: { test: true },
    });

    const inserted = await repository.insert(event);
    expect(inserted.id).toBeDefined();

    const found = await repository.findByTrackingId(event.trackingId);
    expect(found).not.toBeNull();
    expect(found?.aggregateType).toBe('Order');
  });

  it('should claim batch with lease', async () => {
    // Insert test events
    await pool.query(`
      INSERT INTO outbox (tracking_id, aggregate_id, aggregate_type, event_type, payload, status)
      VALUES 
        (gen_random_uuid(), gen_random_uuid(), 'Order', 'OrderCreated', '{}', 'PENDING'),
        (gen_random_uuid(), gen_random_uuid(), 'Order', 'OrderUpdated', '{}', 'PENDING')
    `);

    const claimed = await repository.claimBatch({
      batchSize: 10,
      leaseSeconds: 30,
      lockToken: BigInt(Date.now()),
    });

    expect(claimed.length).toBe(2);
    expect(claimed[0]?.status).toBe('PROCESSING');
  });

  it('should recover stale events', async () => {
    // Insert stale event
    await pool.query(`
      INSERT INTO outbox (tracking_id, aggregate_id, aggregate_type, event_type, payload, status, locked_until)
      VALUES (gen_random_uuid(), gen_random_uuid(), 'Order', 'OrderCreated', '{}', 'PROCESSING', NOW() - INTERVAL '1 minute')
    `);

    const recovered = await repository.recoverStaleEvents();
    expect(recovered).toBe(1);
  });
});
