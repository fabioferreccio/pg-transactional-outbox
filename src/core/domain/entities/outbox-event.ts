/**
 * OutboxEvent Entity
 *
 * Represents a domain event persisted in the outbox table.
 * This is the core entity of the Transactional Outbox pattern.
 */

import type { EventStatus } from "../value-objects/event-status.js";
import type { TraceContext } from "../value-objects/trace-context.js";

export interface OutboxEventProps {
  id?: bigint;
  trackingId: string;
  aggregateId: string;
  aggregateType: string;
  eventType: string;
  payload: unknown;
  metadata?: EventMetadata;
  status?: EventStatus;
  retryCount?: number;
  maxRetries?: number;
  createdAt?: Date;
  processedAt?: Date;
  lockedUntil?: Date;
  lockToken?: bigint;
  lastError?: string;
}

export interface EventMetadata {
  schemaVersion?: number;
  traceContext?: TraceContext;
  correlationId?: string;
  causationId?: string;
  [key: string]: unknown;
}

export class OutboxEvent {
  readonly id?: bigint;
  readonly trackingId: string;
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly metadata: EventMetadata;
  readonly status: EventStatus;
  readonly retryCount: number;
  readonly maxRetries: number;
  readonly createdAt: Date;
  readonly processedAt?: Date;
  readonly lockedUntil?: Date;
  readonly lockToken?: bigint;
  readonly lastError?: string;

  private constructor(props: OutboxEventProps) {
    this.id = props.id;
    this.trackingId = props.trackingId;
    this.aggregateId = props.aggregateId;
    this.aggregateType = props.aggregateType;
    this.eventType = props.eventType;
    this.payload = props.payload;
    this.metadata = props.metadata ?? { schemaVersion: 1 };
    this.status = props.status ?? "PENDING";
    this.retryCount = props.retryCount ?? 0;
    this.maxRetries = props.maxRetries ?? 5;
    this.createdAt = props.createdAt ?? new Date();
    this.processedAt = props.processedAt;
    this.lockedUntil = props.lockedUntil;
    this.lockToken = props.lockToken;
    this.lastError = props.lastError;
  }

  static create(
    props: Omit<OutboxEventProps, "id" | "status" | "retryCount" | "createdAt">,
  ): OutboxEvent {
    return new OutboxEvent({
      ...props,
      trackingId: props.trackingId ?? crypto.randomUUID(),
    });
  }

  static reconstitute(props: OutboxEventProps): OutboxEvent {
    return new OutboxEvent(props);
  }

  /**
   * Check if event can be retried
   */
  canRetry(): boolean {
    return this.retryCount < this.maxRetries;
  }

  /**
   * Check if event is currently leased
   */
  isLeased(): boolean {
    return this.lockedUntil !== undefined && this.lockedUntil > new Date();
  }

  /**
   * Check if lease has expired
   */
  isLeaseExpired(): boolean {
    return this.lockedUntil !== undefined && this.lockedUntil <= new Date();
  }

  /**
   * Get age in milliseconds
   */
  getAgeMs(): number {
    return Date.now() - this.createdAt.getTime();
  }

  /**
   * Get processing duration in milliseconds (if completed)
   */
  getProcessingDurationMs(): number | undefined {
    if (!this.processedAt) return undefined;
    return this.processedAt.getTime() - this.createdAt.getTime();
  }
}
