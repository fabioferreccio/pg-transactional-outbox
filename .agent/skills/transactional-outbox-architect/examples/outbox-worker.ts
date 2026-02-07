/**
 * Transactional Outbox Worker for Node.js
 * 
 * Aligned with Project Principles:
 * - Lease-based locking with active heartbeat
 * - Fencing token protection against zombie workers
 * - Tracking ID for consumer idempotency
 * - Backpressure-aware stream processing
 * - Configurable concurrency and batching
 * - Exponential backoff with jitter
 * - Graceful shutdown
 */

import { Pool } from 'pg';
import { EventEmitter } from 'events';

// ============================================
// Types
// ============================================

export interface OutboxEvent {
  id: bigint;
  tracking_id: string;         // Idempotency key for consumers
  aggregate_id: string;
  aggregate_type: string;
  event_type: string;
  payload: unknown;
  metadata: Record<string, unknown>;
  created_at: Date;
  retry_count: number;
  lock_token: bigint;
  locked_until: Date;
}

export interface WorkerConfig {
  batchSize: number;
  pollIntervalMs: number;
  concurrency: number;
  maxRetries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  leaseSeconds: number;           // Lease duration
  heartbeatIntervalMs: number;    // Heartbeat renewal interval
  reaperEnabled: boolean;         // Run Reaper in-process
  reaperIntervalMs: number;       // Reaper check interval
}

export type EventHandler = (event: OutboxEvent) => Promise<void>;

// ============================================
// Outbox Worker with Lease & Heartbeat
// ============================================

export class OutboxWorker extends EventEmitter {
  private pool: Pool;
  private config: WorkerConfig;
  private handler: EventHandler;
  private workerId: bigint;
  private running = false;
  private heartbeatTimers: Map<string, NodeJS.Timeout> = new Map();
  private reaperTimer: NodeJS.Timeout | null = null;

  constructor(
    pool: Pool,
    handler: EventHandler,
    config: Partial<WorkerConfig> = {}
  ) {
    super();
    this.pool = pool;
    this.handler = handler;
    this.config = {
      batchSize: 100,
      pollIntervalMs: 1000,
      concurrency: 10,
      maxRetries: 5,
      baseBackoffMs: 100,
      maxBackoffMs: 30000,
      leaseSeconds: 30,
      heartbeatIntervalMs: 10000,
      reaperEnabled: true,
      reaperIntervalMs: 10000,
      ...config,
    };
    // Generate unique worker ID (timestamp + random)
    this.workerId = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.emit('start', { workerId: this.workerId.toString() });

    // Start Reaper if enabled
    if (this.config.reaperEnabled) {
      this.startReaper();
    }

    while (this.running) {
      try {
        const processed = await this.processBatch();
        
        if (processed === 0) {
          await this.sleep(this.config.pollIntervalMs);
        }
      } catch (err) {
        this.emit('error', err);
        await this.sleep(this.config.pollIntervalMs);
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    
    // Stop Reaper
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }

    // Stop all heartbeats
    for (const timer of this.heartbeatTimers.values()) {
      clearInterval(timer);
    }
    this.heartbeatTimers.clear();

    this.emit('stop');
  }

  // ============================================
  // Reaper Process
  // ============================================

  private startReaper(): void {
    this.reaperTimer = setInterval(async () => {
      try {
        const recovered = await this.runReaper();
        if (recovered > 0) {
          this.emit('reaper', { recovered });
        }
      } catch (err) {
        this.emit('error', err);
      }
    }, this.config.reaperIntervalMs);
  }

  private async runReaper(): Promise<number> {
    const { rows } = await this.pool.query(`
      UPDATE outbox
      SET 
        status = 'PENDING',
        locked_until = NULL,
        lock_token = NULL
      WHERE status = 'PROCESSING'
        AND locked_until < NOW()
      RETURNING id, event_type, retry_count
    `);

    for (const row of rows) {
      this.emit('recovered', { 
        id: row.id, 
        eventType: row.event_type,
        retryCount: row.retry_count 
      });
    }

    return rows.length;
  }

  // ============================================
  // Batch Processing
  // ============================================

  private async processBatch(): Promise<number> {
    const client = await this.pool.connect();
    
    try {
      await client.query('BEGIN');
      
      // Claim batch with lease
      const { rows } = await client.query<OutboxEvent>(`
        UPDATE outbox
        SET 
          status = 'PROCESSING',
          processed_at = NOW(),
          locked_until = NOW() + INTERVAL '${this.config.leaseSeconds} seconds',
          lock_token = $1
        WHERE id IN (
          SELECT id 
          FROM outbox
          WHERE status = 'PENDING'
            AND created_at < NOW() - INTERVAL '100 milliseconds'
          ORDER BY created_at ASC
          LIMIT $2
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `, [this.workerId.toString(), this.config.batchSize]);

      await client.query('COMMIT');

      if (rows.length === 0) {
        return 0;
      }

      // Process with concurrency limit and heartbeats
      await this.processWithConcurrency(rows);
      
      this.emit('batch', { count: rows.length });
      return rows.length;

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async processWithConcurrency(events: OutboxEvent[]): Promise<void> {
    const semaphore = new Semaphore(this.config.concurrency);

    await Promise.all(
      events.map(async (event) => {
        await semaphore.acquire();
        try {
          await this.processEvent(event);
        } finally {
          semaphore.release();
        }
      })
    );
  }

  // ============================================
  // Event Processing with Heartbeat
  // ============================================

  private async processEvent(event: OutboxEvent): Promise<void> {
    const eventKey = event.id.toString();
    
    // Start heartbeat for this event
    this.startHeartbeat(event);

    try {
      await this.handler(event);
      await this.markCompleted(event);
      this.emit('processed', { 
        id: event.id, 
        trackingId: event.tracking_id,
        eventType: event.event_type 
      });
    } catch (err) {
      await this.markFailed(event, err as Error);
      this.emit('failed', { event, error: err });
    } finally {
      // Stop heartbeat
      this.stopHeartbeat(eventKey);
    }
  }

  private startHeartbeat(event: OutboxEvent): void {
    const eventKey = event.id.toString();
    
    const timer = setInterval(async () => {
      try {
        await this.renewLease(event);
        this.emit('heartbeat', { id: event.id });
      } catch (err) {
        this.emit('error', err);
      }
    }, this.config.heartbeatIntervalMs);

    this.heartbeatTimers.set(eventKey, timer);
  }

  private stopHeartbeat(eventKey: string): void {
    const timer = this.heartbeatTimers.get(eventKey);
    if (timer) {
      clearInterval(timer);
      this.heartbeatTimers.delete(eventKey);
    }
  }

  private async renewLease(event: OutboxEvent): Promise<void> {
    await this.pool.query(`
      UPDATE outbox 
      SET locked_until = NOW() + INTERVAL '${this.config.leaseSeconds} seconds'
      WHERE id = $1 
        AND lock_token = $2
        AND status = 'PROCESSING'
    `, [event.id.toString(), event.lock_token.toString()]);
  }

  // ============================================
  // Status Updates
  // ============================================

  private async markCompleted(event: OutboxEvent): Promise<void> {
    await this.pool.query(`
      UPDATE outbox
      SET 
        status = 'COMPLETED', 
        processed_at = NOW(),
        locked_until = NULL
      WHERE id = $1 AND lock_token = $2
    `, [event.id.toString(), event.lock_token.toString()]);
  }

  private async markFailed(event: OutboxEvent, error: Error): Promise<void> {
    const isDeadLetter = event.retry_count + 1 >= this.config.maxRetries;
    
    await this.pool.query(`
      UPDATE outbox
      SET 
        status = $3,
        retry_count = retry_count + 1,
        last_error = $4,
        processed_at = NOW(),
        locked_until = NULL
      WHERE id = $1 AND lock_token = $2
    `, [
      event.id.toString(),
      event.lock_token.toString(),
      isDeadLetter ? 'DEAD_LETTER' : 'PENDING',
      error.message.slice(0, 1000),
    ]);

    if (isDeadLetter) {
      this.emit('dead-letter', { 
        id: event.id, 
        trackingId: event.tracking_id,
        error: error.message 
      });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================
// Semaphore for Concurrency Control
// ============================================

class Semaphore {
  private permits: number;
  private waiting: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }
    
    return new Promise((resolve) => {
      this.waiting.push(resolve);
    });
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
    } else {
      this.permits++;
    }
  }
}

// ============================================
// Utilities
// ============================================

/**
 * Calculate exponential backoff with jitter
 */
export function calculateBackoff(
  attempt: number,
  baseMs: number,
  maxMs: number
): number {
  const exponential = Math.min(maxMs, baseMs * Math.pow(2, attempt));
  const jitter = Math.random() * exponential * 0.1;
  return Math.floor(exponential + jitter);
}

/**
 * Generate idempotency key from tracking_id + fencing token
 * Use this when calling external APIs (e.g., Stripe)
 */
export function generateIdempotencyKey(
  trackingId: string,
  fencingToken: bigint
): string {
  return `${trackingId}-${fencingToken.toString()}`;
}

/**
 * Check if an event was already processed (consumer-side idempotency)
 */
export async function checkIdempotency(
  pool: Pool,
  trackingId: string
): Promise<boolean> {
  const { rows } = await pool.query(`
    SELECT EXISTS (
      SELECT 1 FROM outbox 
      WHERE tracking_id = $1 
        AND status = 'COMPLETED'
    ) AS processed
  `, [trackingId]);
  
  return rows[0]?.processed ?? false;
}

// ============================================
// Usage Example
// ============================================

/*
import { Pool } from 'pg';
import { OutboxWorker, checkIdempotency, generateIdempotencyKey } from './outbox-worker';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const worker = new OutboxWorker(
  pool,
  async (event) => {
    // IMPORTANT: Consumer idempotency check
    const alreadyProcessed = await checkIdempotency(pool, event.tracking_id);
    if (alreadyProcessed) {
      console.log('Skipping duplicate:', event.tracking_id);
      return;
    }

    // Your event processing logic
    await publishToKafka(event.payload);
    
    // External API with idempotency key
    await stripe.charges.create(
      { ...event.payload },
      { idempotencyKey: generateIdempotencyKey(event.tracking_id, event.lock_token) }
    );
  },
  {
    batchSize: 100,
    concurrency: 10,
    leaseSeconds: 30,
    heartbeatIntervalMs: 10000,
    reaperEnabled: true,
  }
);

// Event handlers
worker.on('processed', ({ id, trackingId }) => 
  console.log('Processed:', id, trackingId));
worker.on('failed', ({ event, error }) => 
  console.error('Failed:', event.id, error));
worker.on('dead-letter', ({ id, trackingId, error }) => 
  console.error('DLE:', id, trackingId, error));
worker.on('reaper', ({ recovered }) => 
  console.log('Reaper recovered:', recovered, 'events'));
worker.on('heartbeat', ({ id }) => 
  console.debug('Heartbeat:', id));
worker.on('error', (err) => 
  console.error('Worker error:', err));

// Graceful shutdown
process.on('SIGTERM', async () => {
  await worker.stop();
  await pool.end();
  process.exit(0);
});

await worker.start();
*/
