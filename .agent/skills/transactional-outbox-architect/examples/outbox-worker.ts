/**
 * Transactional Outbox Worker
 * 
 * Agnostic Worker using Ports and Adapters.
 * Can run with Postgres, MySQL, or In-Memory adapters.
 */

import { EventEmitter } from 'events';
import { OutboxEvent } from '../../../../src/core/domain/entities/outbox-event.js';
import { OutboxRepositoryPort } from '../../../../src/core/ports/outbox-repository.port.js';

// ============================================
// Types
// ============================================

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
// Outbox Worker
// ============================================

export class OutboxWorker extends EventEmitter {
  private config: WorkerConfig;
  private workerId: bigint;
  private running = false;
  private heartbeatTimers: Map<string, NodeJS.Timeout> = new Map();
  private reaperTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repository: OutboxRepositoryPort,
    private readonly handler: EventHandler,
    config: Partial<WorkerConfig> = {}
  ) {
    super();
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
        const recovered = await this.repository.recoverStaleEvents();
        if (recovered > 0) {
          this.emit('reaper', { recovered });
        }
      } catch (err) {
        this.emit('error', err);
      }
    }, this.config.reaperIntervalMs);
  }

  // ============================================
  // Batch Processing
  // ============================================

  private async processBatch(): Promise<number> {
    try {
      // Claim batch with lease via Repository
      const events = await this.repository.claimBatch({
        batchSize: this.config.batchSize,
        leaseSeconds: this.config.leaseSeconds,
        lockToken: this.workerId
      });

      if (events.length === 0) {
        return 0;
      }

      // Process with concurrency limit and heartbeats
      await this.processWithConcurrency(events);
      
      this.emit('batch', { count: events.length });
      return events.length;

    } catch (err) {
      this.emit('error', err);
      return 0;
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
    const lockToken = event.lockToken!; // exist because we claimed it

    // Start heartbeat for this event
    this.startHeartbeat(event);

    try {
      await this.handler(event);
      await this.repository.markCompleted(event.id, lockToken);
      
      this.emit('processed', { 
        id: event.id, 
        trackingId: event.trackingId,
        eventType: event.eventType 
      });
    } catch (err) {
      const error = err as Error;
      const isDeadLetter = event.retryCount + 1 >= this.config.maxRetries;
      
      if (isDeadLetter) {
        await this.repository.markDeadLetter(event.id, lockToken, error.message);
        this.emit('dead-letter', { 
          id: event.id, 
          trackingId: event.trackingId, 
          error: error.message 
        });
      } else {
        await this.repository.markFailed(event.id, lockToken, error.message);
        this.emit('failed', { event, error: err });
      }
    } finally {
      // Stop heartbeat
      this.stopHeartbeat(eventKey);
    }
  }

  private startHeartbeat(event: OutboxEvent): void {
    const eventKey = event.id.toString();
    
    // Safety check: ensure lockToken exists
    if (!event.lockToken) return;

    const timer = setInterval(async () => {
      try {
        await this.repository.renewLease(event.id, event.lockToken!, this.config.leaseSeconds);
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

// ============================================
// Usage Example
// ============================================

/*
import { Pool } from 'pg';
import { OutboxWorker } from './outbox-worker';
import { PostgresOutboxRepository } from 'pg-transactional-outbox';
import { PgSqlExecutor } from 'pg-transactional-outbox';

// 1. Setup Adapter (Postgres, Prisma, Knex...)
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const executor = new PgSqlExecutor(pool);
const repository = new PostgresOutboxRepository(executor);

// 2. Start Worker (Agnostic)
const worker = new OutboxWorker(
  repository,
  async (event) => {
    console.log('Doing work:', event.payload);
    // ... logic
  }
);

worker.start();
*/
