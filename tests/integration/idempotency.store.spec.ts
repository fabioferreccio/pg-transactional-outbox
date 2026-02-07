/**
 * Integration Tests - PostgresIdempotencyStore
 *
 * Requires PostgreSQL running with inbox table.
 * Run with: npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";
import { PostgresIdempotencyStore } from "../../src/adapters/persistence/postgres-idempotency.store.js";

// Skip if no DATABASE_URL is set
const DATABASE_URL = process.env.DATABASE_URL;
const shouldSkip = !DATABASE_URL;

describe.skipIf(shouldSkip)("PostgresIdempotencyStore Integration", () => {
  let pool: Pool;
  let store: PostgresIdempotencyStore;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });

    // Create inbox table if not exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inbox (
        id BIGSERIAL PRIMARY KEY,
        tracking_id VARCHAR(255) NOT NULL,
        consumer_id VARCHAR(255) NOT NULL,
        processed_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(tracking_id, consumer_id)
      )
    `);

    store = new PostgresIdempotencyStore(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM inbox");
  });

  describe("isProcessed", () => {
    it("should return false for unprocessed tracking_id", async () => {
      const result = await store.isProcessed("unknown-tracking-id");
      expect(result).toBe(false);
    });

    it("should return true for processed tracking_id", async () => {
      await store.markProcessed("known-id", "consumer-1");
      const result = await store.isProcessed("known-id");
      expect(result).toBe(true);
    });
  });

  describe("markProcessed", () => {
    it("should mark event as processed", async () => {
      const result = await store.markProcessed("new-event", "consumer-1");
      expect(result).toBe(true);

      const record = await store.getRecord("new-event");
      expect(record).not.toBeNull();
      expect(record?.trackingId).toBe("new-event");
      expect(record?.consumerId).toBe("consumer-1");
    });

    it("should return true on duplicate (idempotent)", async () => {
      await store.markProcessed("dup-event", "consumer-1");
      const result = await store.markProcessed("dup-event", "consumer-1");
      expect(result).toBe(true);
    });

    it("should allow same tracking_id for different consumers", async () => {
      await store.markProcessed("shared-event", "consumer-1");
      const result = await store.markProcessed("shared-event", "consumer-2");
      expect(result).toBe(true);
    });
  });

  describe("getRecord", () => {
    it("should return null for non-existent record", async () => {
      const record = await store.getRecord("non-existent");
      expect(record).toBeNull();
    });

    it("should return record with all fields", async () => {
      await store.markProcessed("test-event", "test-consumer");
      const record = await store.getRecord("test-event");

      expect(record).not.toBeNull();
      expect(record?.trackingId).toBe("test-event");
      expect(record?.consumerId).toBe("test-consumer");
      expect(record?.processedAt).toBeInstanceOf(Date);
    });
  });

  describe("cleanup", () => {
    it("should delete old records", async () => {
      // Insert an old record
      await pool.query(`
        INSERT INTO inbox (tracking_id, consumer_id, processed_at)
        VALUES ('old-event', 'consumer', NOW() - INTERVAL '10 days')
      `);

      // Insert a new record
      await store.markProcessed("new-event", "consumer");

      // Cleanup records older than 7 days
      const deleted = await store.cleanup(7);

      expect(deleted).toBe(1);

      // Verify old record is gone
      const oldRecord = await store.getRecord("old-event");
      expect(oldRecord).toBeNull();

      // Verify new record is still there
      const newRecord = await store.getRecord("new-event");
      expect(newRecord).not.toBeNull();
    });
  });
});
