/**
 * Use Case Unit Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PublishEventUseCase } from '../../src/core/use-cases/publish-event.use-case.js';
import { ProcessOutboxUseCase } from '../../src/core/use-cases/process-outbox.use-case.js';
import { ReapStaleEventsUseCase } from '../../src/core/use-cases/reap-stale-events.use-case.js';
import { OutboxEvent } from '../../src/core/domain/entities/outbox-event.js';
import type { OutboxRepositoryPort } from '../../src/core/ports/outbox-repository.port.js';
import type { EventPublisherPort } from '../../src/core/ports/event-publisher.port.js';

describe('PublishEventUseCase', () => {
  let mockRepository: OutboxRepositoryPort;
  let useCase: PublishEventUseCase;

  beforeEach(() => {
    mockRepository = {
      insert: vi.fn().mockResolvedValue(
        OutboxEvent.reconstitute({
          id: 1n,
          trackingId: 'tracking-123',
          aggregateId: 'agg-123',
          aggregateType: 'Order',
          eventType: 'OrderCreated',
          payload: {},
        })
      ),
    } as unknown as OutboxRepositoryPort;

    useCase = new PublishEventUseCase(mockRepository);
  });

  it('should publish event and return IDs', async () => {
    const result = await useCase.execute({
      aggregateId: 'agg-123',
      aggregateType: 'Order',
      eventType: 'OrderCreated',
      payload: { orderId: 123 },
    });

    expect(result.eventId).toBe(1n);
    expect(result.trackingId).toBe('tracking-123');
    expect(mockRepository.insert).toHaveBeenCalled();
  });
});

describe('ProcessOutboxUseCase', () => {
  let mockRepository: OutboxRepositoryPort;
  let mockPublisher: EventPublisherPort;
  let useCase: ProcessOutboxUseCase;

  beforeEach(() => {
    const mockEvent = OutboxEvent.reconstitute({
      id: 1n,
      trackingId: 'tracking-123',
      aggregateId: 'agg-123',
      aggregateType: 'Order',
      eventType: 'OrderCreated',
      payload: {},
      retryCount: 0,
      maxRetries: 5,
    });

    mockRepository = {
      claimBatch: vi.fn().mockResolvedValue([mockEvent]),
      markCompleted: vi.fn().mockResolvedValue(true),
      markFailed: vi.fn().mockResolvedValue(true),
      markDeadLetter: vi.fn().mockResolvedValue(true),
    } as unknown as OutboxRepositoryPort;

    mockPublisher = {
      publish: vi.fn().mockResolvedValue({ success: true }),
    } as unknown as EventPublisherPort;

    useCase = new ProcessOutboxUseCase(mockRepository, mockPublisher, {
      batchSize: 10,
      leaseSeconds: 30,
      workerId: 'test-worker',
    });
  });

  it('should process events successfully', async () => {
    const result = await useCase.execute();

    expect(result.processed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(mockRepository.markCompleted).toHaveBeenCalled();
  });

  it('should handle publish failures', async () => {
    (mockPublisher.publish as ReturnType<typeof vi.fn>).mockResolvedValue({
      success: false,
      error: 'Connection failed',
    });

    const result = await useCase.execute();

    expect(result.processed).toBe(1);
    expect(result.failed).toBe(1);
    expect(mockRepository.markFailed).toHaveBeenCalled();
  });
});

describe('ReapStaleEventsUseCase', () => {
  it('should recover stale events', async () => {
    const mockRepository = {
      recoverStaleEvents: vi.fn().mockResolvedValue(5),
    } as unknown as OutboxRepositoryPort;

    const useCase = new ReapStaleEventsUseCase(mockRepository);
    const result = await useCase.execute();

    expect(result.recovered).toBe(5);
  });
});
