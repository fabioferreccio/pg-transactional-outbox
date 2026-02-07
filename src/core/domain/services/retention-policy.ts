/**
 * Retention Policy (v0.9)
 *
 * Configurable event retention and cleanup policies.
 */

import type { OutboxRepositoryPort } from "../../ports/outbox-repository.port.js";

export interface RetentionRule {
  /** Rule name for identification */
  name: string;
  /** Event types this rule applies to (empty = all) */
  eventTypes?: string[];
  /** Aggregate types this rule applies to (empty = all) */
  aggregateTypes?: string[];
  /** Event status this rule applies to (empty = all) */
  status?: string[];
  /** Maximum age in days */
  maxAgeDays: number;
  /** Whether to delete or archive */
  action: "delete" | "archive";
}

export interface CleanupResult {
  rulesApplied: number;
  eventsDeleted: number;
  eventsArchived: number;
  durationMs: number;
}

export interface RetentionPolicyConfig {
  /** Default retention in days */
  defaultRetentionDays?: number;
  /** Rules for specific event types */
  rules?: RetentionRule[];
  /** Dry run mode (log but don't delete) */
  dryRun?: boolean;
}

export class RetentionPolicy {
  private rules: RetentionRule[];
  private readonly defaultRetentionDays: number;
  private readonly dryRun: boolean;

  constructor(config: RetentionPolicyConfig = {}) {
    this.defaultRetentionDays = config.defaultRetentionDays ?? 90;
    this.rules = config.rules ?? [];
    this.dryRun = config.dryRun ?? false;
  }

  /**
   * Add a retention rule
   */
  addRule(rule: RetentionRule): void {
    this.rules.push(rule);
  }

  /**
   * Remove a retention rule by name
   */
  removeRule(name: string): boolean {
    const idx = this.rules.findIndex((r) => r.name === name);
    if (idx >= 0) {
      this.rules.splice(idx, 1);
      return true;
    }
    return false;
  }

  /**
   * Get all configured rules
   */
  getRules(): RetentionRule[] {
    return [...this.rules];
  }

  /**
   * Apply retention policy to the outbox
   */
  async apply(repository: OutboxRepositoryPort): Promise<CleanupResult> {
    const startTime = Date.now();
    let eventsDeleted = 0;
    const eventsArchived = 0;

    // Apply default cleanup for completed events
    const defaultCutoff = new Date(
      Date.now() - this.defaultRetentionDays * 24 * 60 * 60 * 1000,
    );

    if (!this.dryRun) {
      const deleted = await repository.cleanup();
      eventsDeleted += deleted;
    } else {
      console.log(
        `[RetentionPolicy] Dry run: would delete events older than ${defaultCutoff.toISOString()}`,
      );
    }

    // Apply specific rules
    for (const rule of this.rules) {
      const cutoff = new Date(
        Date.now() - rule.maxAgeDays * 24 * 60 * 60 * 1000,
      );

      console.log(
        `[RetentionPolicy] Applying rule "${rule.name}": ${rule.action} events older than ${cutoff.toISOString()}`,
      );

      if (!this.dryRun && rule.action === "delete") {
        // Real implementation would filter by rule criteria
        // For now, using basic cleanup
        const deleted = await repository.cleanup();
        eventsDeleted += deleted;
      } else if (rule.action === "archive") {
        // Archive would move to a separate table/storage
        console.log(`[RetentionPolicy] Archive action not implemented`);
      }
    }

    return {
      rulesApplied: this.rules.length + 1, // +1 for default rule
      eventsDeleted,
      eventsArchived,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Preview what would be cleaned up (dry run)
   */
  async preview(repository: OutboxRepositoryPort): Promise<{
    eventsToDelete: number;
    eventsToArchive: number;
  }> {
    // Get count of events older than default retention
    const cutoff = new Date(
      Date.now() - this.defaultRetentionDays * 24 * 60 * 60 * 1000,
    );

    // This is a conceptual implementation
    // Real implementation would query for matching events
    console.log(
      `[RetentionPolicy] Preview: checking events older than ${cutoff.toISOString()}`,
    );

    return {
      eventsToDelete: 0,
      eventsToArchive: 0,
    };
  }

  /**
   * Get the default retention period in days
   */
  getDefaultRetentionDays(): number {
    return this.defaultRetentionDays;
  }
}
