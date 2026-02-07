/**
 * Process Outbox Use Case
 *
 * Orchestrates batch processing of pending events.
 * Implements lease-based locking with heartbeat.
 */

import type { OutboxRepositoryPort } from "../ports/outbox-repository.port.js";
import type { EventPublisherPort } from "../ports/event-publisher.port.js";
import type { OutboxEvent } from "../domain/entities/outbox-event.js";

export interface ProcessOutboxConfig {
  batchSize: number;
  leaseSeconds: number;
  workerId: string;
}

export interface ProcessOutboxResult {
  processed: number;
  succeeded: number;
  failed: number;
  deadLettered: number;
}

export class ProcessOutboxUseCase {
  private lockToken: bigint;

  constructor(
    private readonly repository: OutboxRepositoryPort,
    private readonly publisher: EventPublisherPort,
    private readonly config: ProcessOutboxConfig,
  ) {
    this.lockToken = BigInt(Date.now());
  }

  async execute(): Promise<ProcessOutboxResult> {
    const result: ProcessOutboxResult = {
      processed: 0,
      succeeded: 0,
      failed: 0,
      deadLettered: 0,
    };

    // Claim batch with lease
    const events = await this.repository.claimBatch({
      batchSize: this.config.batchSize,
      leaseSeconds: this.config.leaseSeconds,
      lockToken: this.lockToken,
    });

    // Process each event
    for (const event of events) {
      result.processed++;

      try {
        await this.processEvent(event, result);
      } catch (error) {
        // Outer catch for unexpected errors
        console.error(`Unexpected error processing event ${event.id}:`, error);
      }
    }

    return result;
  }

  private async processEvent(
    event: OutboxEvent,
    result: ProcessOutboxResult,
  ): Promise<void> {
    const eventId = event.id!;

    try {
      // Publish to external system
      const publishResult = await this.publisher.publish(event);

      if (publishResult.success) {
        await this.repository.markCompleted(eventId, this.lockToken);
        result.succeeded++;
      } else {
        await this.handleFailure(
          event,
          publishResult.error ?? "Unknown error",
          result,
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      await this.handleFailure(event, errorMessage, result);
    }
  }

  private async handleFailure(
    event: OutboxEvent,
    error: string,
    result: ProcessOutboxResult,
  ): Promise<void> {
    const eventId = event.id!;

    if (event.canRetry()) {
      await this.repository.markFailed(eventId, this.lockToken, error);
      result.failed++;
    } else {
      await this.repository.markDeadLetter(eventId, this.lockToken, error);
      result.deadLettered++;
    }
  }
}
