/**
 * Polling Relay
 *
 * Standard polling-based relay for outbox processing.
 * Suitable for low-to-medium throughput (< 10,000 events/sec).
 */

import type { Pool } from "pg";
import type { OutboxRepositoryPort } from "../../core/ports/outbox-repository.port.js";
import type { EventPublisherPort } from "../../core/ports/event-publisher.port.js";
import {
  ProcessOutboxUseCase,
  type ProcessOutboxConfig,
} from "../../core/use-cases/process-outbox.use-case.js";
import { ReapStaleEventsUseCase } from "../../core/use-cases/reap-stale-events.use-case.js";

export interface PollingRelayConfig {
  pollIntervalMs: number;
  batchSize: number;
  leaseSeconds: number;
  workerId: string;
  reaperIntervalMs?: number;
}

export class PollingRelay {
  private isRunning = false;
  private pollTimer?: NodeJS.Timeout;
  private reaperTimer?: NodeJS.Timeout;

  private readonly processUseCase: ProcessOutboxUseCase;
  private readonly reaperUseCase: ReapStaleEventsUseCase;

  constructor(
    private readonly repository: OutboxRepositoryPort,
    private readonly publisher: EventPublisherPort,
    private readonly config: PollingRelayConfig,
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

    this.reaperUseCase = new ReapStaleEventsUseCase(repository);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error("Relay is already running");
    }

    this.isRunning = true;
    console.log(`[PollingRelay] Starting worker ${this.config.workerId}`);

    // Start polling loop
    this.poll();

    // Start reaper loop
    const reaperInterval =
      this.config.reaperIntervalMs ?? this.config.leaseSeconds * 500;
    this.reaperTimer = setInterval(() => this.reap(), reaperInterval);

    console.log(`[PollingRelay] Worker ${this.config.workerId} started`);
  }

  async stop(): Promise<void> {
    if (!this.isRunning) return;

    this.isRunning = false;

    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }

    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = undefined;
    }

    console.log(`[PollingRelay] Worker ${this.config.workerId} stopped`);
  }

  private async poll(): Promise<void> {
    if (!this.isRunning) return;

    try {
      const result = await this.processUseCase.execute();

      if (result.processed > 0) {
        console.log(
          `[PollingRelay] Processed ${result.processed} events: ` +
            `${result.succeeded} succeeded, ${result.failed} failed, ${result.deadLettered} DLE`,
        );
      }
    } catch (error) {
      console.error("[PollingRelay] Poll error:", error);
    }

    // Schedule next poll
    if (this.isRunning) {
      this.pollTimer = setTimeout(
        () => this.poll(),
        this.config.pollIntervalMs,
      );
    }
  }

  private async reap(): Promise<void> {
    if (!this.isRunning) return;

    try {
      const result = await this.reaperUseCase.execute();

      if (result.recovered > 0) {
        console.log(
          `[PollingRelay] Reaper recovered ${result.recovered} stale events`,
        );
      }
    } catch (error) {
      console.error("[PollingRelay] Reaper error:", error);
    }
  }
}
