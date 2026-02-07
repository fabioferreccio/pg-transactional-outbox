import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotifyRelay } from './notify-relay';
import { NotificationListener } from './notification-listener';
import { OutboxRepositoryPort } from '../../core/ports/outbox-repository.port';
import { EventPublisherPort } from '../../core/ports/event-publisher.port';

describe('NotifyRelay', () => {
  let relay: NotifyRelay;
  let listener: NotificationListener;
  let repository: OutboxRepositoryPort;
  let publisher: EventPublisherPort;

  beforeEach(() => {
    listener = {
      connect: vi.fn(),
      listen: vi.fn(),
      unlisten: vi.fn(),
      close: vi.fn(),
    };
    repository = {
      claimBatch: vi.fn().mockResolvedValue([]),
      recoverStaleEvents: vi.fn().mockResolvedValue(0),
    } as any;
    publisher = {} as any;

    relay = new NotifyRelay(listener, repository, publisher, {
      channel: 'outbox_events',
      batchSize: 10,
      leaseSeconds: 30,
      workerId: 'test-worker',
    });
  });

  it('should start and connect listener', async () => {
    await relay.start();
    expect(listener.connect).toHaveBeenCalled();
    expect(listener.listen).toHaveBeenCalledWith('outbox_events', expect.any(Function));
  });

  it('should stop and close listener', async () => {
    await relay.start();
    await relay.stop();
    expect(listener.unlisten).toHaveBeenCalledWith('outbox_events');
    expect(listener.close).toHaveBeenCalled();
  });

  it('should throw if started twice', async () => {
    await relay.start();
    await expect(relay.start()).rejects.toThrow('Relay is already running');
  });
});
