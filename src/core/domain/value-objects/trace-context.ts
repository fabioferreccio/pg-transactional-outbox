/**
 * Trace Context Value Object
 * W3C TraceContext format for distributed tracing
 */

export interface TraceContext {
  traceId: string;
  spanId: string;
  traceFlags: string;
  baggage?: Record<string, string>;
}

export function createTraceContext(
  traceId: string,
  spanId: string,
  traceFlags = "01",
): TraceContext {
  return { traceId, spanId, traceFlags };
}

export function serializeTraceContext(ctx: TraceContext): string {
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.traceFlags}`;
}

export function parseTraceContext(
  traceparent: string,
): TraceContext | undefined {
  const parts = traceparent.split("-");
  if (parts.length !== 4) return undefined;

  return {
    traceId: parts[1]!,
    spanId: parts[2]!,
    traceFlags: parts[3]!,
  };
}
