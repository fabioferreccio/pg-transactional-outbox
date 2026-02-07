/**
 * Metrics Port (v0.5)
 *
 * Interface for collecting and exporting observability metrics.
 */

export interface OutboxMetrics {
  /** Total number of pending events */
  pendingTotal: number;
  /** Total number of completed events */
  completedTotal: number;
  /** Total number of dead letter events */
  deadLetterTotal: number;
  /** Age of oldest pending event in seconds */
  oldestPendingAgeSeconds: number;
  /** Backlog utilization percentage (0-100) */
  backlogUtilizationPercent: number;
  /** Number of events currently being processed */
  processingTotal: number;
  /** Timestamp of last metrics collection */
  collectedAt: Date;
}

export interface MetricsPort {
  /**
   * Collect current metrics snapshot
   */
  collect(): Promise<OutboxMetrics>;

  /**
   * Export metrics in Prometheus text format
   */
  toPrometheusFormat(): Promise<string>;
}
