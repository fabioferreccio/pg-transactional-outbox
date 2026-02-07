/**
 * PostgreSQL Idempotency Store
 *
 * Consumer-side idempotency tracking using the inbox table.
 */

import type { Pool, PoolClient } from "pg";
import { SqlExecutor } from "./sql-executor.js";
import { PgSqlExecutor } from "./pg-executor.js";
import type {
  IdempotencyStorePort,
  IdempotencyRecord,
} from "../../core/ports/idempotency-store.port.js";

export class PostgresIdempotencyStore implements IdempotencyStorePort {
  private readonly executor: SqlExecutor;

  constructor(poolOrExecutor: Pool | PoolClient | SqlExecutor) {
    if (this.isSqlExecutor(poolOrExecutor)) {
      this.executor = poolOrExecutor;
    } else {
      this.executor = new PgSqlExecutor(poolOrExecutor);
    }
  }

  private isSqlExecutor(
    obj: Pool | PoolClient | SqlExecutor,
  ): obj is SqlExecutor {
    return "query" in obj && typeof (obj as SqlExecutor).query === "function";
  }

  /**
   * Check if event was already processed
   */
  async isProcessed(trackingId: string): Promise<boolean> {
    const { rows } = await this.executor.query<{ exists: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM inbox 
        WHERE tracking_id = $1
      ) AS exists`,
      [trackingId],
    );

    return rows[0]?.exists ?? false;
  }

  /**
   * Mark event as processed (atomically with business operation)
   * Returns true if marked, false if already existed
   */
  async markProcessed(
    trackingId: string,
    consumerId: string,
  ): Promise<boolean> {
    const { rowCount } = await this.executor.query(
      `INSERT INTO inbox (tracking_id, consumer_id, processed_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (tracking_id, consumer_id) DO NOTHING`,
      [trackingId, consumerId],
    );

    return (rowCount ?? 0) > 0;
  }

  /**
   * Get processing record
   */
  async getRecord(trackingId: string): Promise<IdempotencyRecord | null> {
    const { rows } = await this.executor.query<{
      tracking_id: string;
      processed_at: Date;
      consumer_id: string;
    }>(
      `SELECT tracking_id, processed_at, consumer_id
       FROM inbox
       WHERE tracking_id = $1`,
      [trackingId],
    );

    if (rows.length === 0) {
      return null;
    }

    // Map snake_case to camelCase
    const row = rows[0];
    return {
      trackingId: row.tracking_id,
      processedAt: row.processed_at,
      consumerId: row.consumer_id,
    };
  }

  /**
   * Cleanup old records
   */
  async cleanup(olderThanDays: number): Promise<number> {
    const result = await this.executor.query(
      `DELETE FROM inbox
       WHERE processed_at < NOW() - ($1 || ' days')::INTERVAL`,
      [olderThanDays],
    );

    return result.rowCount ?? 0;
  }
}
