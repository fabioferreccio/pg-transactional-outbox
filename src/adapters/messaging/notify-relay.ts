/**
 * pg_notify Relay
 *
 * High-throughput relay using PostgreSQL LISTEN/NOTIFY.
 * Suitable for 10,000 - 50,000 events/sec.
 */

import type { Pool, PoolClient } from "pg";
import type { OutboxRepositoryPort } from "../../core/ports/outbox-repository.port.js";
import type { EventPublisherPort } from "../../core/ports/event-publisher.port.js";
import {
  ProcessOutboxUseCase,
  type ProcessOutboxConfig,
} from "../../core/use-cases/process-outbox.use-case.js";

export interface NotifyRelayConfig {
  channel: string;
  batchSize: number;
  leaseSeconds: number;
  workerId: string;
  debounceMs?: number;
}

export class NotifyRelay {
  private isRunning = false;
  private client?: PoolClient;
  private debounceTimer?: NodeJS.Timeout;

  private readonly processUseCase: ProcessOutboxUseCase;

  constructor(
    private readonly pool: Pool,
    private readonly repository: OutboxRepositoryPort,
    private readonly publisher: EventPublisherPort,
    private readonly config: NotifyRelayConfig,
  ) {
    const processConfig: ProcessOutboxConfig = {
      batchSize: config.batchSize,
      leaseSeconds: config.leaseSeconds,
      workerId: config.workerId,
    };

    this.processUseCase = new ProcessOutboxUseCase(
      repository,
      publisher,
      processConfig,
    );
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error("Relay is already running");
    }

    this.isRunning = true;

    // Get dedicated connection for LISTEN
    this.client = await this.pool.connect();

    // Setup notification handler
    this.client.on("notification", (msg) => {
      if (msg.channel === this.config.channel) {
        this.onNotification();
      }
    });

    // Subscribe to channel
    await this.client.query(`LISTEN ${this.config.channel}`);

    console.log(
      `[NotifyRelay] Worker ${this.config.workerId} listening on ${this.config.channel}`,
    );

    // Initial poll to catch any pending events
    await this.process();
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    if (this.client) {
      await this.client.query(`UNLISTEN ${this.config.channel}`);
      this.client.release();
      this.client = undefined;
    }

    console.log(`[NotifyRelay] Worker ${this.config.workerId} stopped`);
  }

  private onNotification(): void {
    // Debounce to batch rapid notifications
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    const debounceMs = this.config.debounceMs ?? 50;
    this.debounceTimer = setTimeout(() => this.process(), debounceMs);
  }

  private async process(): Promise<void> {
    if (!this.isRunning) return;

    try {
      const result = await this.processUseCase.execute();

      if (result.processed > 0) {
        console.log(
          `[NotifyRelay] Processed ${result.processed} events: ` +
            `${result.succeeded} succeeded, ${result.failed} failed`,
        );

        // If we got a full batch, there might be more
        if (result.processed >= this.config.batchSize) {
          setImmediate(() => this.process());
        }
      }
    } catch (error) {
      console.error("[NotifyRelay] Process error:", error);
    }
  }
}

// ============================================
// SQL Trigger for pg_notify
// ============================================
/*
CREATE OR REPLACE FUNCTION fn_outbox_notify()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('outbox_events', NEW.id::TEXT);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_outbox_notify
  AFTER INSERT ON outbox
  FOR EACH ROW
  EXECUTE FUNCTION fn_outbox_notify();
*/
