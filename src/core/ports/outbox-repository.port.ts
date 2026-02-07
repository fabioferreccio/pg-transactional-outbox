/**
 * Outbox Repository Port
 *
 * Primary port for persistence operations on the outbox.
 */

import type { OutboxEvent } from "../domain/entities/outbox-event.js";
import type { EventStatus } from "../domain/value-objects/event-status.js";

export interface ClaimOptions {
  batchSize: number;
  leaseSeconds: number;
  lockToken: bigint;
}

export interface OutboxRepositoryPort {
  /**
   * Insert a new event into the outbox
   * MUST be called within the same transaction as the business operation
   */
  insert(event: OutboxEvent): Promise<OutboxEvent>;

  /**
   * Claim pending events for processing
   * Uses SKIP LOCKED to allow parallel workers
   */
  claimBatch(options: ClaimOptions): Promise<OutboxEvent[]>;

  /**
   * Mark event as completed
   * Validates lock token (fencing)
   */
  markCompleted(eventId: bigint, lockToken: bigint): Promise<boolean>;

  /**
   * Mark event as failed with error
   */
  markFailed(
    eventId: bigint,
    lockToken: bigint,
    error: string,
  ): Promise<boolean>;

  /**
   * Move event to dead letter
   */
  markDeadLetter(
    eventId: bigint,
    lockToken: bigint,
    error: string,
  ): Promise<boolean>;

  /**
   * Renew lease on event (heartbeat)
   */
  renewLease(
    eventId: bigint,
    lockToken: bigint,
    leaseSeconds: number,
  ): Promise<boolean>;

  /**
   * Recover stale events (Reaper)
   */
  recoverStaleEvents(): Promise<number>;

  /**
   * Find event by ID
   */
  findById(eventId: bigint): Promise<OutboxEvent | null>;

  /**
   * Find event by tracking ID
   */
  findByTrackingId(trackingId: string): Promise<OutboxEvent | null>;

  /**
   * Get events by status
   */
  findByStatus(status: EventStatus, limit: number): Promise<OutboxEvent[]>;

  /**
   * Find recent events with keyset pagination
   */
  findRecent(options: {
    limit: number;
    before?: bigint;
    after?: bigint;
  }): Promise<OutboxEvent[]>;

  /**
   * Get oldest pending event age in seconds
   */
  getOldestPendingAgeSeconds(): Promise<number>;

  /**
   * Get pending event count
   */
  getPendingCount(): Promise<number>;

  /**
   * Get dead letter count
   */
  getDeadLetterCount(): Promise<number>;

  /**
   * Get completed event count
   */
  getCompletedCount(): Promise<number>;

  /**
   * Cleanup processed events
   */
  cleanup(): Promise<number>;
}
