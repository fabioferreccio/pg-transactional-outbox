/**
 * CDC Event Transformer (v0.8)
 *
 * Transforms CDC messages (from Debezium or logical replication)
 * into OutboxEvent entities.
 */

import { OutboxEvent } from "../../core/domain/entities/outbox-event.js";
import type { EventStatus } from "../../core/domain/value-objects/event-status.js";

/**
 * Debezium message envelope structure
 */
export interface DebeziumMessage {
  schema?: object;
  payload: {
    before?: DebeziumRow | null;
    after?: DebeziumRow | null;
    source: {
      version: string;
      connector: string;
      name: string;
      ts_ms: number;
      snapshot: string;
      db: string;
      sequence: string[];
      schema: string;
      table: string;
      txId: number;
      lsn: number;
      xmin: number | null;
    };
    op: "c" | "u" | "d" | "r"; // create, update, delete, read
    ts_ms: number;
    transaction: {
      id: string;
      total_order: number;
      data_collection_order: number;
    } | null;
  };
}

export interface DebeziumRow {
  id: string | number;
  tracking_id: string;
  aggregate_id: string;
  aggregate_type: string;
  event_type: string;
  payload: string | object;
  metadata?: string | object;
  status: string;
  retry_count: number;
  max_retries: number;
  created_at: number | string;
  processed_at?: number | string | null;
  locked_until?: number | string | null;
  lock_token?: string | number | null;
  last_error?: string | null;
  owner?: string | null;
}

/**
 * PostgreSQL logical replication message (pgoutput format)
 */
export interface LogicalReplicationMessage {
  lsn: string;
  table: string;
  operation: "INSERT" | "UPDATE" | "DELETE";
  columns: Record<string, unknown>;
  oldColumns?: Record<string, unknown>;
}

export class CDCEventTransformer {
  /**
   * Transform a Debezium message into an OutboxEvent
   */
  static fromDebeziumMessage(message: DebeziumMessage): OutboxEvent | null {
    const { payload } = message;

    // Only process INSERT operations for outbox events
    if (payload.op !== "c" && payload.op !== "r") {
      return null;
    }

    const row = payload.after;
    if (!row) {
      return null;
    }

    return this.rowToEvent(row);
  }

  /**
   * Transform a logical replication message into an OutboxEvent
   */
  static fromLogicalReplication(message: LogicalReplicationMessage): OutboxEvent | null {
    // Only process INSERT operations
    if (message.operation !== "INSERT") {
      return null;
    }

    const row = message.columns as unknown as DebeziumRow;
    return this.rowToEvent(row);
  }

  /**
   * Convert a row to an OutboxEvent
   */
  private static rowToEvent(row: DebeziumRow): OutboxEvent {
    // Parse payload if it's a string
    let payload = row.payload;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch {
        // Keep as string if not valid JSON
      }
    }

    // Parse metadata if it's a string
    let metadata = row.metadata ?? {};
    if (typeof metadata === "string") {
      try {
        metadata = JSON.parse(metadata);
      } catch {
        metadata = {};
      }
    }

    // Parse dates
    const createdAt = this.parseDate(row.created_at);
    const processedAt = row.processed_at ? this.parseDate(row.processed_at) : undefined;
    const lockedUntil = row.locked_until ? this.parseDate(row.locked_until) : undefined;

    return OutboxEvent.reconstitute({
      id: BigInt(row.id),
      trackingId: row.tracking_id,
      aggregateId: row.aggregate_id,
      aggregateType: row.aggregate_type,
      eventType: row.event_type,
      payload,
      metadata: metadata as Record<string, unknown>,
      status: row.status as EventStatus,
      retryCount: row.retry_count,
      maxRetries: row.max_retries,
      createdAt,
      processedAt,
      lockedUntil,
      lockToken: row.lock_token ? BigInt(row.lock_token) : undefined,
      lastError: row.last_error ?? undefined,
      owner: row.owner ?? undefined,
    });
  }

  /**
   * Parse date from various formats
   */
  private static parseDate(value: number | string): Date {
    if (typeof value === "number") {
      // Debezium uses microseconds since epoch
      return new Date(value / 1000);
    }
    return new Date(value);
  }

  /**
   * Check if a Debezium message is from the outbox table
   */
  static isOutboxMessage(message: DebeziumMessage, tableName = "outbox"): boolean {
    return message.payload.source.table === tableName;
  }

  /**
   * Extract routing key from event for topic routing
   */
  static getRoutingKey(event: OutboxEvent): string {
    return `${event.aggregateType}.${event.eventType}`;
  }
}
