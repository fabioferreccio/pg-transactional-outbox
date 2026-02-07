/**
 * PostgreSQL Idempotency Store
 *
 * Consumer-side idempotency tracking using the inbox table.
 */

import type { Pool } from "pg";
import type {
  IdempotencyStorePort,
  IdempotencyRecord,
} from "../../core/ports/idempotency-store.port.js";

export class PostgresIdempotencyStore implements IdempotencyStorePort {
  constructor(private readonly pool: Pool) {}

  /**
   * Check if event was already processed
   */
  async isProcessed(trackingId: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      `SELECT EXISTS (
        SELECT 1 FROM inbox 
        WHERE tracking_id = $1
      ) AS processed`,
      [trackingId],
    );

    return rows[0]?.processed ?? false;
  }

  /**
   * Mark event as processed (atomically with business operation)
   * Returns true if marked, false if already existed
   */
  async markProcessed(
    trackingId: string,
    consumerId: string,
  ): Promise<boolean> {
    try {
      await this.pool.query(
        `INSERT INTO inbox (tracking_id, consumer_id, processed_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (tracking_id, consumer_id) DO NOTHING`,
        [trackingId, consumerId],
      );
      return true;
    } catch (error) {
      // Unique constraint violation means already processed
      if ((error as { code?: string }).code === "23505") {
        return false;
      }
      throw error;
    }
  }

  /**
   * Get processing record
   */
  async getRecord(trackingId: string): Promise<IdempotencyRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT tracking_id, processed_at, consumer_id
       FROM inbox
       WHERE tracking_id = $1`,
      [trackingId],
    );

    if (rows.length === 0) {
      return null;
    }

    return {
      trackingId: rows[0].tracking_id,
      processedAt: rows[0].processed_at,
      consumerId: rows[0].consumer_id,
    };
  }

  /**
   * Cleanup old records
   */
  async cleanup(olderThanDays: number): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM inbox
       WHERE processed_at < NOW() - ($1 || ' days')::INTERVAL`,
      [olderThanDays],
    );

    return result.rowCount ?? 0;
  }
}
