/**
 * Dashboard API Service
 * 
 * Exposes internal state and controls via JSON endpoints.
 */

import { OutboxEvent } from '../core/domain/entities/outbox-event.js';
import { OutboxRepositoryPort } from '../core/ports/outbox-repository.port.js';
import { EventSimulator } from './simulator.js';

export class DashboardApi {
  constructor(private repository: OutboxRepositoryPort) {}

  /**
   * Get recent events overview
   */
  /**
   * Get recent events overview with cursor-based pagination
   */
  async getRecentEvents(options: { limit?: number; before?: string; after?: string } = {}): Promise<any> {
    const limit = options.limit || 8;
    const before = options.before ? BigInt(options.before) : undefined;
    const after = options.after ? BigInt(options.after) : undefined;

    const events = await this.repository.findRecent({
      limit: limit + 1,
      before,
      after
    });

    const hasMore = events.length > limit;
    let items;
    
    if (hasMore) {
      if (options.after) {
        // When moving newer, we fetch limit + 1 ASC and reverse.
        // Result is [NewestExtra, ..., ImmediateNext8]
        // We want the 8 closest to our cursor (the end of the ASC list, start of reversed).
        // Actually, ASC 93, 94... 100, 101. Reversed 101, 100... 94, 93.
        // Closest to 92 are 93..100 which are at the END of reversed.
        items = events.slice(1); 
      } else {
        // When moving older, we fetch limit + 1 DESC.
        // Result is [ImmediatePrev8, ..., OldestExtra]
        items = events.slice(0, limit);
      }
    } else {
      items = events;
    }

    const firstEvent = items[0];
    const lastEvent = items[items.length - 1];

    return {
      events: items.map((e: OutboxEvent) => ({
        id: e.id?.toString(),
        trackingId: e.trackingId,
        aggregateType: e.aggregateType,
        aggregateId: e.aggregateId,
        eventType: e.eventType,
        status: e.status,
        retryCount: e.retryCount,
        lastError: e.lastError,
        createdAt: e.createdAt,
        processedAt: e.processedAt,
        producerId: (e.payload as any)?.producerId || 'System'
      })),
      pagination: {
        firstId: firstEvent?.id?.toString() || null,
        lastId: lastEvent?.id?.toString() || null,
        hasMore: hasMore
      }
    };
  }

  /**
   * Cleanup processed events
   */
  async cleanupEvents(): Promise<number> {
    return this.repository.cleanup();
  }

  /**
   * Get system health and counts
   */
  async getStats(): Promise<any> {
    const [pending, deadLetter, completed] = await Promise.all([
      this.repository.getPendingCount(),
      this.repository.getDeadLetterCount(),
      this.repository.getCompletedCount()
    ]);

    const producers = EventSimulator.getProducers();

    return {
      workers: 1,
      producers: producers.length,
      producerList: producers,
      pendingEvents: pending,
      deadLetterEvents: deadLetter,
      completedEvents: completed,
      uptime: Math.floor(process.uptime()),
      memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB'
    };
  }
}
