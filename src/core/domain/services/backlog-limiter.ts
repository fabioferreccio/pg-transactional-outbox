/**
 * Backlog Limiter Service (v0.4)
 *
 * Provides backpressure control to prevent unbounded backlog growth.
 */

import type { OutboxRepositoryPort } from "../../ports/outbox-repository.port.js";

export type BacklogLimitAction = "throw" | "warn" | "drop";

export interface BacklogLimiterConfig {
  /** Maximum number of pending events allowed */
  maxBacklogSize: number;
  /** Action to take when limit is exceeded */
  onLimitExceeded: BacklogLimitAction;
}

export class BacklogLimitExceededError extends Error {
  constructor(
    public readonly currentSize: number,
    public readonly maxSize: number,
  ) {
    super(
      `Backlog limit exceeded: ${currentSize} events pending (max: ${maxSize})`,
    );
    this.name = "BacklogLimitExceededError";
  }
}

export class BacklogLimiter {
  constructor(
    private readonly repository: OutboxRepositoryPort,
    private readonly config: BacklogLimiterConfig,
  ) {}

  /**
   * Check if backlog is within limits
   * @throws BacklogLimitExceededError if action is 'throw' and limit exceeded
   * @returns true if within limits, false if exceeded (for 'warn'/'drop' modes)
   */
  async checkLimit(): Promise<boolean> {
    const currentSize = await this.repository.getPendingCount();

    if (currentSize >= this.config.maxBacklogSize) {
      switch (this.config.onLimitExceeded) {
        case "throw":
          throw new BacklogLimitExceededError(
            currentSize,
            this.config.maxBacklogSize,
          );

        case "warn":
          console.warn(
            `[BacklogLimiter] WARNING: Backlog limit exceeded. Current: ${currentSize}, Max: ${this.config.maxBacklogSize}`,
          );
          return false;

        case "drop":
          console.warn(
            `[BacklogLimiter] DROPPING: Event rejected due to backlog limit. Current: ${currentSize}, Max: ${this.config.maxBacklogSize}`,
          );
          return false;
      }
    }

    return true;
  }

  /**
   * Get current backlog utilization percentage
   */
  async getUtilization(): Promise<number> {
    const currentSize = await this.repository.getPendingCount();
    return Math.min(100, (currentSize / this.config.maxBacklogSize) * 100);
  }

  /**
   * Check if backlog is healthy (below 80% capacity)
   */
  async isHealthy(): Promise<boolean> {
    const utilization = await this.getUtilization();
    return utilization < 80;
  }
}
