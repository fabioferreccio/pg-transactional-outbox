/**
 * Health Checker (v0.5)
 *
 * Aggregates health status from multiple components.
 */

import type { OutboxRepositoryPort } from "../../ports/outbox-repository.port.js";
import type { OutboxMetrics, MetricsPort } from "../../ports/metrics.port.js";

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface HealthCheckResult {
  status: HealthStatus;
  checks: {
    database: CheckDetail;
    backlog: CheckDetail;
    deadLetter: CheckDetail;
  };
  metrics: OutboxMetrics;
  checkedAt: Date;
}

export interface CheckDetail {
  status: HealthStatus;
  message: string;
}

export interface HealthCheckerConfig {
  /** Maximum pending count before degraded */
  maxPendingForHealthy: number;
  /** Maximum pending count before unhealthy */
  maxPendingForDegraded: number;
  /** Maximum lag seconds before degraded */
  maxLagSecondsHealthy: number;
  /** Maximum lag seconds before unhealthy */
  maxLagSecondsDegraded: number;
  /** Maximum dead letter count before warning */
  maxDeadLetterForHealthy: number;
}

export class HealthChecker {
  constructor(
    private readonly repository: OutboxRepositoryPort,
    private readonly metricsCollector: MetricsPort,
    private readonly config: HealthCheckerConfig,
  ) {}

  /**
   * Perform health check and return aggregated status
   */
  async check(): Promise<HealthCheckResult> {
    const metrics = await this.metricsCollector.collect();

    // Check database connectivity (if metrics collected, DB is working)
    const databaseCheck: CheckDetail = {
      status: "healthy",
      message: "Database connection successful",
    };

    // Check backlog health
    const backlogCheck = this.checkBacklog(metrics);

    // Check dead letter health
    const deadLetterCheck = this.checkDeadLetter(metrics);

    // Aggregate overall status (worst of all checks)
    const statuses = [databaseCheck.status, backlogCheck.status, deadLetterCheck.status];
    let overallStatus: HealthStatus = "healthy";
    
    if (statuses.includes("unhealthy")) {
      overallStatus = "unhealthy";
    } else if (statuses.includes("degraded")) {
      overallStatus = "degraded";
    }

    return {
      status: overallStatus,
      checks: {
        database: databaseCheck,
        backlog: backlogCheck,
        deadLetter: deadLetterCheck,
      },
      metrics,
      checkedAt: new Date(),
    };
  }

  private checkBacklog(metrics: OutboxMetrics): CheckDetail {
    const { pendingTotal, oldestPendingAgeSeconds } = metrics;

    // Check by count
    if (pendingTotal > this.config.maxPendingForDegraded) {
      return {
        status: "unhealthy",
        message: `Backlog critical: ${pendingTotal} pending (max: ${this.config.maxPendingForDegraded})`,
      };
    }

    if (pendingTotal > this.config.maxPendingForHealthy) {
      return {
        status: "degraded",
        message: `Backlog elevated: ${pendingTotal} pending (threshold: ${this.config.maxPendingForHealthy})`,
      };
    }

    // Check by lag
    if (oldestPendingAgeSeconds > this.config.maxLagSecondsDegraded) {
      return {
        status: "unhealthy",
        message: `Lag critical: ${Math.round(oldestPendingAgeSeconds)}s (max: ${this.config.maxLagSecondsDegraded}s)`,
      };
    }

    if (oldestPendingAgeSeconds > this.config.maxLagSecondsHealthy) {
      return {
        status: "degraded",
        message: `Lag elevated: ${Math.round(oldestPendingAgeSeconds)}s (threshold: ${this.config.maxLagSecondsHealthy}s)`,
      };
    }

    return {
      status: "healthy",
      message: `Backlog healthy: ${pendingTotal} pending, ${Math.round(oldestPendingAgeSeconds)}s lag`,
    };
  }

  private checkDeadLetter(metrics: OutboxMetrics): CheckDetail {
    const { deadLetterTotal } = metrics;

    if (deadLetterTotal > this.config.maxDeadLetterForHealthy * 2) {
      return {
        status: "unhealthy",
        message: `Dead letters critical: ${deadLetterTotal} events`,
      };
    }

    if (deadLetterTotal > this.config.maxDeadLetterForHealthy) {
      return {
        status: "degraded",
        message: `Dead letters elevated: ${deadLetterTotal} events (threshold: ${this.config.maxDeadLetterForHealthy})`,
      };
    }

    return {
      status: "healthy",
      message: `Dead letters healthy: ${deadLetterTotal} events`,
    };
  }

  /**
   * Quick health check - returns true if healthy or degraded
   */
  async isAlive(): Promise<boolean> {
    try {
      const result = await this.check();
      return result.status !== "unhealthy";
    } catch {
      return false;
    }
  }
}
