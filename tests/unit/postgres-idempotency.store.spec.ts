import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostgresIdempotencyStore } from '../../src/adapters/persistence/postgres-idempotency.store';
import { SqlExecutor } from '../../src/adapters/persistence/sql-executor';

describe('PostgresIdempotencyStore', () => {
  let store: PostgresIdempotencyStore;
  let executor: SqlExecutor;

  beforeEach(() => {
    executor = {
      query: vi.fn(),
    };
    store = new PostgresIdempotencyStore(executor);
  });

  it('should check if processed', async () => {
    vi.mocked(executor.query).mockResolvedValueOnce({ rows: [{ exists: true }], rowCount: 1 });
    const result = await store.isProcessed('track-1');
    expect(result).toBe(true);
    expect(executor.query).toHaveBeenCalledWith(expect.stringContaining('SELECT EXISTS'), ['track-1']);
  });

  it('should mark processed successfully', async () => {
    vi.mocked(executor.query).mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const result = await store.markProcessed('track-1', 'consumer-1');
    expect(result).toBe(true);
    expect(executor.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO inbox'), ['track-1', 'consumer-1']);
  });

  it('should return false if mark processed conflicts', async () => {
    vi.mocked(executor.query).mockResolvedValueOnce({ rows: [], rowCount: 0 }); // ON CONFLICT DO NOTHING
    const result = await store.markProcessed('track-1', 'consumer-1');
    expect(result).toBe(false);
  });

  it('should get record', async () => {
    const now = new Date();
    vi.mocked(executor.query).mockResolvedValueOnce({
      rows: [{ tracking_id: 'track-1', processed_at: now, consumer_id: 'c1' }],
      rowCount: 1,
    });

    const record = await store.getRecord('track-1');
    expect(record).toEqual({
      trackingId: 'track-1',
      processedAt: now,
      consumerId: 'c1',
    });
  });

  it('should return null if record not found', async () => {
    vi.mocked(executor.query).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const record = await store.getRecord('track-1');
    expect(record).toBeNull();
  });
});
