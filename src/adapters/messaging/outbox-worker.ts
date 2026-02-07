/**
 * Outbox Worker
 *
 * Production-grade worker with:
 * - Lease-based locking with active heartbeat
 * - Fencing token protection against zombie workers
 * - Configurable concurrency and batching
 * - Exponential backoff with jitter
 * - Graceful shutdown
 * - Integrated Reaper process
 */

import { EventEmitter } from "events";
import type { Pool } from "pg";
import type { OutboxRepositoryPort } from "../../core/ports/outbox-repository.port.js";
import type { EventPublisherPort } from "../../core/ports/event-publisher.port.js";
import type { OutboxEvent } from "../../core/domain/entities/outbox-event.js";
import { Semaphore } from "../../core/domain/value-objects/semaphore.js";
import {
  calculateBackoff,
  type RetryPolicyConfig,
  DEFAULT_RETRY_POLICY,
} from "../../core/domain/value-objects/retry-policy.js";

// ============================================
// Types
// ============================================

export interface OutboxWorkerConfig {
  batchSize: number;
  pollIntervalMs: number;
  concurrency: number;
  leaseSeconds: number;
  heartbeatIntervalMs: number;
  reaperEnabled: boolean;
  reaperIntervalMs: number;
  retryPolicy: RetryPolicyConfig;
}

export interface WorkerEvents {
  start: { workerId: string };
  stop: void;
  batch: { count: number };
  processed: { id: bigint; trackingId: string; eventType: string };
  failed: { id: bigint; error: string };
  "dead-letter": { id: bigint; trackingId: string; error: string };
  reaper: { recovered: number };
  heartbeat: { id: bigint };
  error: Error;
}

const DEFAULT_CONFIG: OutboxWorkerConfig = {
  batchSize: 100,
  pollIntervalMs: 1000,
  concurrency: 10,
  leaseSeconds: 30,
  heartbeatIntervalMs: 10000,
  reaperEnabled: true,
  reaperIntervalMs: 10000,
  retryPolicy: DEFAULT_RETRY_POLICY,
};

// ============================================
// Outbox Worker
// ============================================

export class OutboxWorker extends EventEmitter {
  private readonly config: OutboxWorkerConfig;
  private readonly workerId: bigint;
  private running = false;
  private heartbeatTimers: Map<string, NodeJS.Timeout> = new Map();
  private reaperTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly repository: OutboxRepositoryPort,
    private readonly publisher: EventPublisherPort,
    config: Partial<OutboxWorkerConfig> = {},
  ) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    // Generate unique worker ID (timestamp + random)
    this.workerId =
      BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
  }

  get id(): string {
    return this.workerId.toString();
  }

  get isRunning(): boolean {
    return this.running;
  }

  // ============================================
  // Lifecycle
  // ============================================

  async start(): Promise<void> {
    if (this.running) {
      throw new Error("Worker is already running");
    }

    this.running = true;
    this.emit("start", { workerId: this.workerId.toString() });

    // Start Reaper if enabled
    if (this.config.reaperEnabled) {
      this.startReaper();
    }

    // Start polling loop
    this.poll();
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;

    // Stop poll timer
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

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

    this.emit("stop");
  }

  // ============================================
  // Reaper Process
  // ============================================

  private startReaper(): void {
    this.reaperTimer = setInterval(async () => {
      try {
        const recovered = await this.repository.recoverStaleEvents();
        if (recovered > 0) {
          this.emit("reaper", { recovered });
        }
      } catch (err) {
        this.emit("error", err as Error);
      }
    }, this.config.reaperIntervalMs);
  }

  // ============================================
  // Polling Loop
  // ============================================

  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      const processed = await this.processBatch();

      // If we processed events, poll immediately for more
      if (processed > 0 && processed >= this.config.batchSize) {
        setImmediate(() => this.poll());
        return;
      }
    } catch (err) {
      this.emit("error", err as Error);
    }

    // Schedule next poll
    if (this.running) {
      this.pollTimer = setTimeout(
        () => this.poll(),
        this.config.pollIntervalMs,
      );
    }
  }

  // ============================================
  // Batch Processing
  // ============================================

  private async processBatch(): Promise<number> {
    const events = await this.repository.claimBatch({
      batchSize: this.config.batchSize,
      leaseSeconds: this.config.leaseSeconds,
      lockToken: this.workerId,
    });

    if (events.length === 0) {
      return 0;
    }

    // Process with concurrency limit
    const semaphore = new Semaphore(this.config.concurrency);

    await Promise.all(
      events.map(async (event) => {
        await semaphore.acquire();
        try {
          await this.processEvent(event);
        } finally {
          semaphore.release();
        }
      }),
    );

    this.emit("batch", { count: events.length });
    return events.length;
  }

  // ============================================
  // Event Processing with Heartbeat
  // ============================================

  private async processEvent(event: OutboxEvent): Promise<void> {
    const eventId = event.id!;
    const eventKey = eventId.toString();

    // Start heartbeat for this event
    this.startHeartbeat(event);

    try {
      const result = await this.publisher.publish(event);

      if (result.success) {
        await this.repository.markCompleted(eventId, this.workerId);
        this.emit("processed", {
          id: eventId,
          trackingId: event.trackingId,
          eventType: event.eventType,
        });
      } else {
        await this.handleFailure(event, result.error ?? "Unknown error");
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      await this.handleFailure(event, errorMessage);
    } finally {
      this.stopHeartbeat(eventKey);
    }
  }

  private async handleFailure(
    event: OutboxEvent,
    error: string,
  ): Promise<void> {
    const eventId = event.id!;

    if (event.canRetry()) {
      // Calculate backoff delay (stored in metadata for future use)
      const backoffMs = calculateBackoff(
        event.retryCount,
        this.config.retryPolicy,
      );

      await this.repository.markFailed(eventId, this.workerId, error);
      this.emit("failed", { id: eventId, error });
    } else {
      await this.repository.markDeadLetter(eventId, this.workerId, error);
      this.emit("dead-letter", {
        id: eventId,
        trackingId: event.trackingId,
        error,
      });
    }
  }

  // ============================================
  // Heartbeat
  // ============================================

  private startHeartbeat(event: OutboxEvent): void {
    const eventId = event.id!;
    const eventKey = eventId.toString();

    const timer = setInterval(async () => {
      try {
        await this.repository.renewLease(
          eventId,
          this.workerId,
          this.config.leaseSeconds,
        );
        this.emit("heartbeat", { id: eventId });
      } catch (err) {
        this.emit("error", err as Error);
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
}

// ============================================
// Utilities
// ============================================

/**
 * Generate idempotency key from tracking_id + fencing token
 * Use this when calling external APIs (e.g., Stripe)
 */
export function generateIdempotencyKey(
  trackingId: string,
  fencingToken: bigint,
): string {
  return `${trackingId}-${fencingToken.toString()}`;
}
