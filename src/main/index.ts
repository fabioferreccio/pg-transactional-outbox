/**
 * @module main
 * Composition root and entry point
 *
 * Re-exports core and adapter modules with explicit naming to avoid conflicts.
 */

// Core exports
export * from "../core/domain/entities/index.js";
export * from "../core/domain/errors/index.js";
export * from "../core/domain/events/index.js";
export * from "../core/domain/value-objects/index.js";
export * from "../core/domain/upcaster.js";
export * from "../core/ports/index.js";
export * from "../core/use-cases/index.js";

// Adapter exports
export * from "../adapters/persistence/index.js";
export * from "../adapters/messaging/index.js";

// Script exports
export * from "../scripts/run-migrations.js";
export * from "../scripts/run-seed.js";

// Telemetry exports (avoid conflict with core TraceContext)
export {
  startSpan,
  withSpan,
  withOutboxInsertSpan,
  withOutboxProcessSpan,
  extractTraceContext,
  injectTraceContext,
  isTracingEnabled,
  parseTraceContext,
  serializeTraceContext,
  type OtelTraceContext,
  type SpanLike,
} from "../adapters/telemetry/tracer.js";

export {
  getMetrics,
  metrics,
  isMetricsEnabled,
  type MetricRecorder,
} from "../adapters/telemetry/metrics.js";
