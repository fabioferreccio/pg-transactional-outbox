/**
 * Event Stream (v0.7)
 *
 * Async iterator for paginated event retrieval from the outbox.
 */

import type { OutboxEvent } from "../entities/outbox-event.js";
import type { OutboxRepositoryPort } from "../../ports/outbox-repository.port.js";

export interface EventStreamOptions {
  /** Filter by aggregate ID */
  aggregateId?: string;
  /** Filter by aggregate type */
  aggregateType?: string;
  /** Filter by event types */
  eventTypes?: string[];
  /** Start from this date */
  fromDate?: Date;
  /** End at this date */
  toDate?: Date;
  /** Page size for batched retrieval */
  batchSize?: number;
  /** Include only completed events */
  completedOnly?: boolean;
}

export class EventStream implements AsyncIterable<OutboxEvent> {
  private readonly batchSize: number;

  constructor(
    private readonly repository: OutboxRepositoryPort,
    private readonly options: EventStreamOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 100;
  }

  /**
   * Async iterator implementation
   */
  async *[Symbol.asyncIterator](): AsyncIterator<OutboxEvent> {
    let lastId: bigint | undefined;
    let hasMore = true;

    while (hasMore) {
      const events = await this.repository.findRecent({
        limit: this.batchSize,
        after: lastId,
      });

      if (events.length === 0) {
        hasMore = false;
        break;
      }

      for (const event of events) {
        if (this.matchesFilters(event)) {
          yield event;
        }
        lastId = event.id;
      }

      if (events.length < this.batchSize) {
        hasMore = false;
      }
    }
  }

  /**
   * Check if an event matches the configured filters
   */
  private matchesFilters(event: OutboxEvent): boolean {
    if (this.options.aggregateId && event.aggregateId !== this.options.aggregateId) {
      return false;
    }

    if (this.options.aggregateType && event.aggregateType !== this.options.aggregateType) {
      return false;
    }

    if (this.options.eventTypes && !this.options.eventTypes.includes(event.eventType)) {
      return false;
    }

    if (this.options.fromDate && event.createdAt < this.options.fromDate) {
      return false;
    }

    if (this.options.toDate && event.createdAt > this.options.toDate) {
      return false;
    }

    if (this.options.completedOnly && event.status !== "COMPLETED") {
      return false;
    }

    return true;
  }

  /**
   * Collect all events into an array
   */
  async toArray(): Promise<OutboxEvent[]> {
    const events: OutboxEvent[] = [];
    for await (const event of this) {
      events.push(event);
    }
    return events;
  }

  /**
   * Count total events matching filters
   */
  async count(): Promise<number> {
    const events = await this.toArray();
    return events.length;
  }
}

/**
 * Create an event stream
 */
export function createEventStream(
  repository: OutboxRepositoryPort,
  options?: EventStreamOptions,
): EventStream {
  return new EventStream(repository, options);
}
