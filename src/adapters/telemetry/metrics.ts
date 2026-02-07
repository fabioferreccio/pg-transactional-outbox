/**
 * OpenTelemetry Metrics
 *
 * Provides metrics recording for outbox operations.
 * This is a no-op implementation when @opentelemetry/api is not installed.
 *
 * To enable real metrics, install @opentelemetry/api and configure your SDK.
 */

// ============================================
// Types
// ============================================

export interface MetricRecorder {
  recordPublished(aggregateType: string, eventType: string): void;
  recordProcessed(aggregateType: string, eventType: string): void;
  recordFailed(
    aggregateType: string,
    eventType: string,
    errorType: string,
  ): void;
  recordDeadLettered(aggregateType: string, eventType: string): void;
  recordDuration(
    durationMs: number,
    aggregateType: string,
    eventType: string,
  ): void;
  recordQueueDepth(depth: number): void;
  recordOldestEventAge(ageSeconds: number): void;
}

// ============================================
// No-op Implementation
// ============================================

class NoopMetrics implements MetricRecorder {
  recordPublished(_aggregateType: string, _eventType: string): void {}
  recordProcessed(_aggregateType: string, _eventType: string): void {}
  recordFailed(
    _aggregateType: string,
    _eventType: string,
    _errorType: string,
  ): void {}
  recordDeadLettered(_aggregateType: string, _eventType: string): void {}
  recordDuration(
    _durationMs: number,
    _aggregateType: string,
    _eventType: string,
  ): void {}
  recordQueueDepth(_depth: number): void {}
  recordOldestEventAge(_ageSeconds: number): void {}
}

// ============================================
// Singleton Export
// ============================================

/**
 * Get metrics instance
 * Returns no-op metrics (install @opentelemetry/api for real metrics)
 */
export function getMetrics(): MetricRecorder {
  return new NoopMetrics();
}

/**
 * Outbox metrics singleton
 */
export const metrics: MetricRecorder = new NoopMetrics();

/**
 * Check if metrics are enabled
 */
export function isMetricsEnabled(): boolean {
  return false;
}
