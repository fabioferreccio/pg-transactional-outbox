/**
 * OpenTelemetry Tracer
 *
 * Provides distributed tracing for outbox operations.
 * This is a no-op implementation when @opentelemetry/api is not installed.
 *
 * To enable real tracing, install @opentelemetry/api and configure your SDK,
 * then call initializeTracing() at startup.
 */

// ============================================
// Types
// ============================================

export interface OtelTraceContext {
  traceId: string;
  spanId: string;
  traceFlags: string;
}

export interface SpanLike {
  setAttribute(key: string, value: unknown): void;
  setStatus(status: { code: number; message?: string }): void;
  recordException(exception: Error): void;
  end(): void;
  spanContext(): { traceId: string; spanId: string; traceFlags: number };
}

// ============================================
// No-op Implementation
// ============================================

const noopSpan: SpanLike = {
  setAttribute: () => {},
  setStatus: () => {},
  recordException: () => {},
  end: () => {},
  spanContext: () => ({ traceId: "", spanId: "", traceFlags: 0 }),
};

// ============================================
// Tracer Functions
// ============================================

/**
 * Start a new span for outbox operations
 * Returns no-op span (install @opentelemetry/api for real tracing)
 */
export function startSpan(_name: string): SpanLike {
  return noopSpan;
}

/**
 * Execute a function within a span context
 */
export async function withSpan<T>(
  name: string,
  fn: (span: SpanLike) => Promise<T>,
): Promise<T> {
  const span = startSpan(name);

  try {
    const result = await fn(span);
    span.setStatus({ code: 0 });
    return result;
  } catch (error) {
    span.setStatus({
      code: 1,
      message: error instanceof Error ? error.message : String(error),
    });
    span.recordException(error as Error);
    throw error;
  } finally {
    span.end();
  }
}

/**
 * Execute within outbox insert span
 */
export async function withOutboxInsertSpan<T>(
  _eventType: string,
  _aggregateId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return fn();
}

/**
 * Execute within outbox process span
 */
export async function withOutboxProcessSpan<T>(
  _eventId: string,
  _trackingId: string,
  _eventType: string,
  _traceContext: OtelTraceContext | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return fn();
}

/**
 * Extract trace context from current active span
 */
export function extractTraceContext(): OtelTraceContext | undefined {
  return undefined;
}

/**
 * Inject trace context into event metadata
 */
export function injectTraceContext(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return metadata;
}

/**
 * Check if OpenTelemetry is available
 */
export function isTracingEnabled(): boolean {
  return false;
}

/**
 * Parse W3C traceparent header
 */
export function parseTraceContext(
  traceparent: string,
): OtelTraceContext | undefined {
  const parts = traceparent.split("-");
  if (parts.length !== 4) return undefined;

  return {
    traceId: parts[1]!,
    spanId: parts[2]!,
    traceFlags: parts[3]!,
  };
}

/**
 * Serialize trace context to W3C traceparent format
 */
export function serializeTraceContext(ctx: OtelTraceContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.traceFlags}`;
}
