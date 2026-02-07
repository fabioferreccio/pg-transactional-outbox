import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgNotificationListener } from '../../src/adapters/messaging/pg-notification-listener';
import { Pool, PoolClient } from 'pg';

vi.mock('pg', () => {
  const mClient = {
    query: vi.fn(),
    release: vi.fn(),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
  };
  const mPool = {
    connect: vi.fn(() => Promise.resolve(mClient)),
  };
  return { Pool: vi.fn(() => mPool) };
});

describe('PgNotificationListener', () => {
  let listener: PgNotificationListener;
  let pool: any;
  let client: any;

  beforeEach(() => {
    vi.clearAllMocks();
    pool = new Pool();
    client = {
      query: vi.fn(),
      release: vi.fn(),
      on: vi.fn(),
      removeAllListeners: vi.fn(),
    };
    pool.connect.mockResolvedValue(client);
    listener = new PgNotificationListener(pool);
  });

  it('should connect and get a client', async () => {
    await listener.connect();
    expect(pool.connect).toHaveBeenCalled();
  });

  it('should listen to a channel', async () => {
    await listener.connect();
    const callback = vi.fn();
    await listener.listen('test_channel', callback);

    expect(client.query).toHaveBeenCalledWith('LISTEN test_channel');
    expect(client.on).toHaveBeenCalledWith('notification', expect.any(Function));
  });

  it('should unlisten', async () => {
    await listener.connect();
    await listener.unlisten('test_channel');
    expect(client.query).toHaveBeenCalledWith('UNLISTEN test_channel');
  });

  it('should close connection', async () => {
    await listener.connect();
    await listener.close();
    expect(client.release).toHaveBeenCalled();
  });
});
