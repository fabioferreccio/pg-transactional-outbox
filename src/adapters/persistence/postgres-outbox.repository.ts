/**
 * PostgreSQL Outbox Repository
 *
 * Implements persistence operations for the outbox pattern.
 */

import type { Pool } from "pg";
import type {
  OutboxRepositoryPort,
  ClaimOptions,
} from "../../core/ports/outbox-repository.port.js";
import { OutboxEvent } from "../../core/domain/entities/outbox-event.js";
import type { EventStatus } from "../../core/domain/value-objects/event-status.js";

export class PostgresOutboxRepository implements OutboxRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async insert(event: OutboxEvent): Promise<OutboxEvent> {
    const result = await this.pool.query(
      `INSERT INTO outbox (
        tracking_id, aggregate_id, aggregate_type, event_type,
        payload, metadata, status, retry_count, max_retries
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, created_at`,
      [
        event.trackingId,
        event.aggregateId,
        event.aggregateType,
        event.eventType,
        JSON.stringify(event.payload),
        JSON.stringify(event.metadata),
        event.status,
        event.retryCount,
        event.maxRetries,
      ],
    );

    const row = result.rows[0];
    return OutboxEvent.reconstitute({
      ...event,
      id: BigInt(row.id),
      createdAt: row.created_at,
    });
  }

  async claimBatch(options: ClaimOptions): Promise<OutboxEvent[]> {
    const result = await this.pool.query(
      `UPDATE outbox
       SET status = 'PROCESSING',
           locked_until = NOW() + ($2 || ' seconds')::INTERVAL,
           lock_token = $3
       WHERE id IN (
         SELECT id FROM outbox
         WHERE status IN ('PENDING', 'FAILED')
           AND (locked_until IS NULL OR locked_until < NOW())
         ORDER BY created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [options.batchSize, options.leaseSeconds, options.lockToken.toString()],
    );

    return result.rows.map((row) => this.mapRowToEvent(row));
  }

  async markCompleted(eventId: bigint, lockToken: bigint): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE outbox
       SET status = 'COMPLETED', processed_at = NOW(), locked_until = NULL, lock_token = NULL
       WHERE id = $1 AND lock_token = $2`,
      [eventId.toString(), lockToken.toString()],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markFailed(
    eventId: bigint,
    lockToken: bigint,
    error: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE outbox
       SET status = 'FAILED', 
           retry_count = retry_count + 1,
           last_error = $3,
           locked_until = NULL,
           lock_token = NULL
       WHERE id = $1 AND lock_token = $2`,
      [eventId.toString(), lockToken.toString(), error],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async markDeadLetter(
    eventId: bigint,
    lockToken: bigint,
    error: string,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE outbox
       SET status = 'DEAD_LETTER', 
           last_error = $3,
           processed_at = NOW(),
           locked_until = NULL,
           lock_token = NULL
       WHERE id = $1 AND lock_token = $2`,
      [eventId.toString(), lockToken.toString(), error],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async renewLease(
    eventId: bigint,
    lockToken: bigint,
    leaseSeconds: number,
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE outbox
       SET locked_until = NOW() + ($3 || ' seconds')::INTERVAL
       WHERE id = $1 AND lock_token = $2 AND status = 'PROCESSING'`,
      [eventId.toString(), lockToken.toString(), leaseSeconds],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async recoverStaleEvents(): Promise<number> {
    const result = await this.pool.query(
      `UPDATE outbox
       SET status = 'PENDING', locked_until = NULL, lock_token = NULL
       WHERE status = 'PROCESSING' AND locked_until < NOW()`,
    );
    return result.rowCount ?? 0;
  }

  async findById(eventId: bigint): Promise<OutboxEvent | null> {
    const result = await this.pool.query(`SELECT * FROM outbox WHERE id = $1`, [
      eventId.toString(),
    ]);
    return result.rows[0] ? this.mapRowToEvent(result.rows[0]) : null;
  }

  async findByTrackingId(trackingId: string): Promise<OutboxEvent | null> {
    const result = await this.pool.query(
      `SELECT * FROM outbox WHERE tracking_id = $1`,
      [trackingId],
    );
    return result.rows[0] ? this.mapRowToEvent(result.rows[0]) : null;
  }

  async findByStatus(
    status: EventStatus,
    limit: number,
  ): Promise<OutboxEvent[]> {
    const result = await this.pool.query(
      `SELECT * FROM outbox WHERE status = $1 ORDER BY id DESC LIMIT $2`,
      [status, limit],
    );
    return result.rows.map((row) => this.mapRowToEvent(row));
  }

  async findRecent(options: {
    limit: number;
    before?: bigint;
    after?: bigint;
  }): Promise<OutboxEvent[]> {
    let query = `SELECT * FROM outbox`;
    const params: any[] = [options.limit];
    const where: string[] = [];

    if (options.after) {
      where.push(`id > $${params.length + 1}`);
      params.push(options.after.toString());
    }

    if (options.before) {
      where.push(`id < $${params.length + 1}`);
      params.push(options.before.toString());
    }

    if (where.length > 0) {
      query += ` WHERE ` + where.join(" AND ");
    }

    // If "after" (moving to newer), we sort ASC to get the immediate next ones, then reverse
    // If "before" or default (moving to older), we sort DESC
    if (options.after) {
      query += ` ORDER BY id ASC LIMIT $1`;
    } else {
      query += ` ORDER BY id DESC LIMIT $1`;
    }

    const result = await this.pool.query(query, params);
    const events = result.rows.map((row) => this.mapRowToEvent(row));

    return options.after ? events.reverse() : events;
  }

  async getOldestPendingAgeSeconds(): Promise<number> {
    const result = await this.pool.query(
      `SELECT EXTRACT(EPOCH FROM (NOW() - MIN(created_at))) as age
       FROM outbox WHERE status = 'PENDING'`,
    );
    return result.rows[0]?.age ?? 0;
  }

  async getPendingCount(): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*) as count FROM outbox WHERE status = 'PENDING'`,
    );
    return parseInt(result.rows[0]?.count ?? "0", 10);
  }

  async getDeadLetterCount(): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*) as count FROM outbox WHERE status = 'DEAD_LETTER'`,
    );
    return parseInt(result.rows[0]?.count ?? "0", 10);
  }

  async getCompletedCount(): Promise<number> {
    const result = await this.pool.query(
      `SELECT COUNT(*) as count FROM outbox WHERE status = 'COMPLETED'`,
    );
    return parseInt(result.rows[0]?.count ?? "0", 10);
  }

  async cleanup(): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM outbox WHERE status IN ('COMPLETED', 'DEAD_LETTER')`,
    );
    return result.rowCount ?? 0;
  }

  private mapRowToEvent(row: Record<string, unknown>): OutboxEvent {
    return OutboxEvent.reconstitute({
      id: BigInt(row.id as string),
      trackingId: row.tracking_id as string,
      aggregateId: row.aggregate_id as string,
      aggregateType: row.aggregate_type as string,
      eventType: row.event_type as string,
      payload: row.payload,
      metadata: row.metadata as Record<string, unknown>,
      status: row.status as EventStatus,
      retryCount: row.retry_count as number,
      maxRetries: row.max_retries as number,
      createdAt: row.created_at as Date,
      processedAt: row.processed_at as Date | undefined,
      lockedUntil: row.locked_until as Date | undefined,
      lockToken: row.lock_token ? BigInt(row.lock_token as string) : undefined,
      lastError: row.last_error as string | undefined,
    });
  }
}
