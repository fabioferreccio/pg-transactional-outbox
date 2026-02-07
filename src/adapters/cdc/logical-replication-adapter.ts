/**
 * Logical Replication Adapter (v0.8)
 *
 * Alternative to polling using PostgreSQL logical replication.
 * This adapter connects to a replication slot and receives changes in real-time.
 *
 * NOTE: This is a simplified implementation. For production use,
 * consider using a dedicated library like pg-logical-replication.
 */

import type { OutboxEvent } from "../../core/domain/entities/outbox-event.js";
import { CDCEventTransformer, type LogicalReplicationMessage } from "./cdc-event-transformer.js";

export type EventHandler = (event: OutboxEvent) => Promise<void>;

export interface LogicalReplicationConfig {
  /** Replication slot name */
  slotName: string;
  /** Publication name */
  publicationName: string;
  /** Table to monitor */
  tableName?: string;
  /** Handler called for each new event */
  onEvent: EventHandler;
  /** Handler called on errors */
  onError?: (error: Error) => void;
  /** Reconnect on connection loss */
  autoReconnect?: boolean;
  /** Reconnect delay in milliseconds */
  reconnectDelayMs?: number;
}

export interface ReplicationStatus {
  connected: boolean;
  lastLSN?: string;
  eventsReceived: number;
  lastEventAt?: Date;
  errors: number;
}

/**
 * Logical Replication Adapter
 *
 * Provides real-time event streaming using PostgreSQL's logical replication.
 * This is more efficient than polling for high-throughput scenarios.
 *
 * @example
 * ```typescript
 * const adapter = new LogicalReplicationAdapter({
 *   slotName: 'outbox_slot',
 *   publicationName: 'outbox_publication',
 *   onEvent: async (event) => {
 *     console.log('New event:', event.eventType);
 *     await publishToKafka(event);
 *   },
 * });
 *
 * await adapter.start();
 * ```
 */
export class LogicalReplicationAdapter {
  private running = false;
  private status: ReplicationStatus = {
    connected: false,
    eventsReceived: 0,
    errors: 0,
  };

  constructor(private readonly config: LogicalReplicationConfig) {}

  /**
   * Start receiving replication events
   *
   * NOTE: This is a placeholder implementation.
   * Real implementation requires pg_logical_replication protocol handling.
   */
  async start(): Promise<void> {
    if (this.running) {
      console.warn("[LogicalReplication] Already running");
      return;
    }

    this.running = true;
    this.status.connected = true;

    console.log(
      `[LogicalReplication] Started (slot: ${this.config.slotName}, publication: ${this.config.publicationName})`,
    );

    // In a real implementation, this would:
    // 1. Connect to PostgreSQL using replication protocol
    // 2. Start streaming from the replication slot
    // 3. Parse pgoutput messages
    // 4. Transform and dispatch events

    // Placeholder: Emit a started event
    console.log("[LogicalReplication] Ready to receive events");
  }

  /**
   * Stop receiving replication events
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    this.running = false;
    this.status.connected = false;

    console.log("[LogicalReplication] Stopped");
  }

  /**
   * Process a replication message (called by the replication stream)
   */
  async processMessage(message: LogicalReplicationMessage): Promise<void> {
    try {
      // Only process messages from the outbox table
      if (message.table !== (this.config.tableName ?? "outbox")) {
        return;
      }

      // Transform to OutboxEvent
      const event = CDCEventTransformer.fromLogicalReplication(message);

      if (event) {
        await this.config.onEvent(event);

        this.status.eventsReceived++;
        this.status.lastEventAt = new Date();
        this.status.lastLSN = message.lsn;
      }
    } catch (error) {
      this.status.errors++;

      if (this.config.onError) {
        this.config.onError(error as Error);
      } else {
        console.error("[LogicalReplication] Error processing message:", error);
      }
    }
  }

  /**
   * Get current replication status
   */
  getStatus(): ReplicationStatus {
    return { ...this.status };
  }

  /**
   * Check if the adapter is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Generate SQL to create the required replication slot
   */
  static generateSetupSQL(slotName: string, publicationName: string, tableName = "outbox"): string {
    return `
-- Create publication for outbox table
CREATE PUBLICATION ${publicationName} FOR TABLE ${tableName}
  WITH (publish = 'insert');

-- Create replication slot
SELECT pg_create_logical_replication_slot('${slotName}', 'pgoutput');
`.trim();
  }

  /**
   * Generate SQL to drop the replication slot
   */
  static generateTeardownSQL(slotName: string, publicationName: string): string {
    return `
-- Drop replication slot
SELECT pg_drop_replication_slot('${slotName}');

-- Drop publication
DROP PUBLICATION IF EXISTS ${publicationName};
`.trim();
  }
}
