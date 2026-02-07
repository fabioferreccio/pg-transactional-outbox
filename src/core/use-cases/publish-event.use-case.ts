/**
 * Publish Event Use Case
 *
 * Orchestrates the creation and persistence of domain events in the outbox.
 * MUST be called within the same transaction as the business operation.
 */

import type { OutboxRepositoryPort } from "../ports/outbox-repository.port.js";
import { OutboxEvent } from "../domain/entities/outbox-event.js";
import type { TraceContext } from "../domain/value-objects/trace-context.js";

export interface PublishEventInput {
  aggregateId: string;
  aggregateType: string;
  eventType: string;
  payload: unknown;
  trackingId?: string;
  traceContext?: TraceContext;
  metadata?: Record<string, unknown>;
}

export interface PublishEventOutput {
  eventId: bigint;
  trackingId: string;
}

export class PublishEventUseCase {
  constructor(private readonly repository: OutboxRepositoryPort) {}

  async execute(input: PublishEventInput): Promise<PublishEventOutput> {
    const event = OutboxEvent.create({
      trackingId: input.trackingId ?? crypto.randomUUID(),
      aggregateId: input.aggregateId,
      aggregateType: input.aggregateType,
      eventType: input.eventType,
      payload: input.payload,
      metadata: {
        schemaVersion: 1,
        traceContext: input.traceContext,
        ...input.metadata,
      },
    });

    const persisted = await this.repository.insert(event);

    return {
      eventId: persisted.id!,
      trackingId: persisted.trackingId,
    };
  }
}
