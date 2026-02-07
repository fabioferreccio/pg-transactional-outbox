/**
 * Audit Logger (v0.9)
 *
 * Logs all outbox operations for compliance and debugging.
 */

import type { OutboxEvent } from "../entities/outbox-event.js";

export type AuditAction =
  | "CREATE"
  | "CLAIM"
  | "COMPLETE"
  | "FAIL"
  | "DEAD_LETTER"
  | "REDRIVE"
  | "DELETE"
  | "REDACT";

export interface AuditEntry {
  id: string;
  timestamp: Date;
  action: AuditAction;
  eventId?: bigint;
  trackingId?: string;
  aggregateType?: string;
  eventType?: string;
  actor?: string;
  metadata?: Record<string, unknown>;
}

export interface AuditLogStore {
  append(entry: AuditEntry): Promise<void>;
  query(options: AuditQueryOptions): Promise<AuditEntry[]>;
  count(options: AuditQueryOptions): Promise<number>;
}

export interface AuditQueryOptions {
  fromDate?: Date;
  toDate?: Date;
  action?: AuditAction;
  eventId?: bigint;
  trackingId?: string;
  actor?: string;
  limit?: number;
  offset?: number;
}

export interface AuditLoggerConfig {
  /** Store implementation */
  store: AuditLogStore;
  /** Include payload in audit logs (may contain PII) */
  includePayload?: boolean;
  /** Default actor for operations */
  defaultActor?: string;
}

/**
 * In-memory audit log store (for testing/development)
 */
export class InMemoryAuditLogStore implements AuditLogStore {
  private entries: AuditEntry[] = [];

  async append(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }

  async query(options: AuditQueryOptions): Promise<AuditEntry[]> {
    let results = [...this.entries];

    if (options.fromDate) {
      results = results.filter((e) => e.timestamp >= options.fromDate!);
    }
    if (options.toDate) {
      results = results.filter((e) => e.timestamp <= options.toDate!);
    }
    if (options.action) {
      results = results.filter((e) => e.action === options.action);
    }
    if (options.eventId) {
      results = results.filter((e) => e.eventId === options.eventId);
    }
    if (options.trackingId) {
      results = results.filter((e) => e.trackingId === options.trackingId);
    }
    if (options.actor) {
      results = results.filter((e) => e.actor === options.actor);
    }

    // Pagination
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 100;
    return results.slice(offset, offset + limit);
  }

  async count(options: AuditQueryOptions): Promise<number> {
    const results = await this.query({ ...options, limit: undefined, offset: undefined });
    return results.length;
  }

  clear(): void {
    this.entries = [];
  }
}

export class AuditLogger {
  constructor(private readonly config: AuditLoggerConfig) {}

  /**
   * Log an outbox event action
   */
  async logEvent(
    action: AuditAction,
    event: OutboxEvent,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const entry: AuditEntry = {
      id: this.generateId(),
      timestamp: new Date(),
      action,
      eventId: event.id,
      trackingId: event.trackingId,
      aggregateType: event.aggregateType,
      eventType: event.eventType,
      actor: this.config.defaultActor,
      metadata: {
        ...metadata,
        ...(this.config.includePayload ? { payload: event.payload } : {}),
      },
    };

    await this.config.store.append(entry);
    console.log(`[Audit] ${action} event ${event.trackingId}`);
  }

  /**
   * Log a generic action (not tied to specific event)
   */
  async log(
    action: AuditAction,
    details: Partial<AuditEntry>,
  ): Promise<void> {
    const entry: AuditEntry = {
      id: this.generateId(),
      timestamp: new Date(),
      action,
      actor: this.config.defaultActor,
      ...details,
    };

    await this.config.store.append(entry);
  }

  /**
   * Query audit log entries
   */
  async getAuditLog(options: AuditQueryOptions = {}): Promise<AuditEntry[]> {
    return this.config.store.query(options);
  }

  /**
   * Count matching audit entries
   */
  async countEntries(options: AuditQueryOptions = {}): Promise<number> {
    return this.config.store.count(options);
  }

  /**
   * Generate unique audit entry ID
   */
  private generateId(): string {
    return `audit-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }
}
