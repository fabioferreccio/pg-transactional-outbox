/**
 * Metrics Collector (v0.5)
 *
 * Collects and exports observability metrics in Prometheus format.
 */

import type { OutboxRepositoryPort } from "../../ports/outbox-repository.port.js";
import type { OutboxMetrics, MetricsPort } from "../../ports/metrics.port.js";

export interface MetricsCollectorConfig {
  /** Maximum backlog size for utilization calculation */
  maxBacklogSize: number;
  /** Prefix for Prometheus metric names */
  metricsPrefix?: string;
}

export class MetricsCollector implements MetricsPort {
  private readonly prefix: string;

  constructor(
    private readonly repository: OutboxRepositoryPort,
    private readonly config: MetricsCollectorConfig,
  ) {
    this.prefix = config.metricsPrefix ?? "outbox";
  }

  async collect(): Promise<OutboxMetrics> {
    const [
      pendingTotal,
      completedTotal,
      deadLetterTotal,
      oldestPendingAgeSeconds,
    ] = await Promise.all([
      this.repository.getPendingCount(),
      this.repository.getCompletedCount(),
      this.repository.getDeadLetterCount(),
      this.repository.getOldestPendingAgeSeconds(),
    ]);

    const backlogUtilizationPercent = Math.min(
      100,
      (pendingTotal / this.config.maxBacklogSize) * 100,
    );

    return {
      pendingTotal,
      completedTotal,
      deadLetterTotal,
      oldestPendingAgeSeconds,
      backlogUtilizationPercent,
      processingTotal: 0, // TODO: Add processingCount to repository
      collectedAt: new Date(),
    };
  }

  async toPrometheusFormat(): Promise<string> {
    const metrics = await this.collect();
    const lines: string[] = [];

    // Helper to add metric with help and type
    const addGauge = (name: string, help: string, value: number) => {
      lines.push(`# HELP ${this.prefix}_${name} ${help}`);
      lines.push(`# TYPE ${this.prefix}_${name} gauge`);
      lines.push(`${this.prefix}_${name} ${value}`);
    };

    addGauge(
      "pending_total",
      "Total number of pending events in the outbox",
      metrics.pendingTotal,
    );

    addGauge(
      "completed_total",
      "Total number of completed events in the outbox",
      metrics.completedTotal,
    );

    addGauge(
      "dead_letter_total",
      "Total number of dead letter events in the outbox",
      metrics.deadLetterTotal,
    );

    addGauge(
      "oldest_pending_age_seconds",
      "Age of the oldest pending event in seconds",
      metrics.oldestPendingAgeSeconds,
    );

    addGauge(
      "backlog_utilization_percent",
      "Backlog utilization as a percentage of max capacity",
      Math.round(metrics.backlogUtilizationPercent * 100) / 100,
    );

    addGauge(
      "processing_total",
      "Total number of events currently being processed",
      metrics.processingTotal,
    );

    return lines.join("\n") + "\n";
  }
}
