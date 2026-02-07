/**
 * OpenTelemetry Instrumentation for Transactional Outbox
 * 
 * Provides:
 * - Automatic span creation for outbox operations
 * - Context propagation in event payloads
 * - W3C TraceContext standard compliance
 * - Integration with postgres, http, and custom spans
 */

import {
  trace,
  context,
  SpanKind,
  SpanStatusCode,
  propagation,
  Span,
  Context,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

// ============================================
// Types
// ============================================

export interface TraceContext {
  trace_id: string;
  span_id: string;
  trace_flags: string;
  baggage?: Record<string, string>;
}

export interface OutboxEventWithTrace {
  id?: bigint;
  tracking_id: string;
  aggregate_id: string;
  aggregate_type: string;
  event_type: string;
  payload: unknown;
  metadata: {
    trace_context?: TraceContext;
    [key: string]: unknown;
  };
}

// ============================================
// Tracer Configuration
// ============================================

const TRACER_NAME = 'transactional-outbox';
const TRACER_VERSION = '1.0.0';

export function getTracer() {
  return trace.getTracer(TRACER_NAME, TRACER_VERSION);
}

// ============================================
// Context Propagation
// ============================================

const propagator = new W3CTraceContextPropagator();

/**
 * Extract trace context from current active span
 * Returns serializable object for storage in outbox metadata
 */
export function extractTraceContext(): TraceContext | undefined {
  const activeSpan = trace.getActiveSpan();
  if (!activeSpan) return undefined;

  const spanContext = activeSpan.spanContext();
  
  return {
    trace_id: spanContext.traceId,
    span_id: spanContext.spanId,
    trace_flags: spanContext.traceFlags.toString(16).padStart(2, '0'),
  };
}

/**
 * Extract full W3C TraceContext carrier for header propagation
 */
export function extractTraceContextCarrier(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

/**
 * Inject trace context from carrier into current context
 */
export function injectTraceContext(carrier: Record<string, string>): Context {
  return propagation.extract(context.active(), carrier);
}

/**
 * Create child context from stored trace context
 */
export function createContextFromTrace(traceCtx: TraceContext): Context {
  const carrier = {
    traceparent: `00-${traceCtx.trace_id}-${traceCtx.span_id}-${traceCtx.trace_flags}`,
  };
  return propagation.extract(context.active(), carrier);
}

// ============================================
// Outbox Instrumentation
// ============================================

/**
 * Instrument outbox event creation with automatic trace injection
 */
export function instrumentOutboxInsert<T extends OutboxEventWithTrace>(
  event: Omit<T, 'metadata'> & { metadata?: Partial<T['metadata']> }
): T {
  const traceContext = extractTraceContext();
  
  return {
    ...event,
    metadata: {
      ...event.metadata,
      trace_context: traceContext,
      instrumented_at: new Date().toISOString(),
    },
  } as T;
}

/**
 * Create a span for outbox insert operation
 */
export async function withOutboxInsertSpan<T>(
  eventType: string,
  aggregateId: string,
  operation: () => Promise<T>
): Promise<T> {
  const tracer = getTracer();
  
  return tracer.startActiveSpan(
    `outbox.insert.${eventType}`,
    {
      kind: SpanKind.PRODUCER,
      attributes: {
        'outbox.event_type': eventType,
        'outbox.aggregate_id': aggregateId,
        'messaging.system': 'transactional_outbox',
        'messaging.operation': 'publish',
      },
    },
    async (span: Span) => {
      try {
        const result = await operation();
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : 'Unknown error',
        });
        span.recordException(error as Error);
        throw error;
      } finally {
        span.end();
      }
    }
  );
}

/**
 * Create a span for outbox processing (worker side)
 */
export async function withOutboxProcessSpan<T>(
  event: OutboxEventWithTrace,
  operation: () => Promise<T>
): Promise<T> {
  const tracer = getTracer();
  
  // Restore context from stored trace
  const parentContext = event.metadata?.trace_context
    ? createContextFromTrace(event.metadata.trace_context)
    : context.active();

  return context.with(parentContext, () => {
    return tracer.startActiveSpan(
      `outbox.process.${event.event_type}`,
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          'outbox.event_id': event.id?.toString(),
          'outbox.tracking_id': event.tracking_id,
          'outbox.event_type': event.event_type,
          'outbox.aggregate_id': event.aggregate_id,
          'outbox.aggregate_type': event.aggregate_type,
          'messaging.system': 'transactional_outbox',
          'messaging.operation': 'receive',
        },
        links: event.metadata?.trace_context
          ? [{
              context: {
                traceId: event.metadata.trace_context.trace_id,
                spanId: event.metadata.trace_context.span_id,
                traceFlags: parseInt(event.metadata.trace_context.trace_flags, 16),
              },
            }]
          : [],
      },
      async (span: Span) => {
        try {
          const result = await operation();
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : 'Unknown error',
          });
          span.recordException(error as Error);
          throw error;
        } finally {
          span.end();
        }
      }
    );
  });
}

// ============================================
// Kafka Header Utilities
// ============================================

/**
 * Convert trace context to Kafka headers format
 */
export function traceContextToKafkaHeaders(
  traceCtx?: TraceContext
): Record<string, string> {
  if (!traceCtx) return {};
  
  return {
    traceparent: `00-${traceCtx.trace_id}-${traceCtx.span_id}-${traceCtx.trace_flags}`,
  };
}

/**
 * Extract trace context from Kafka headers
 */
export function kafkaHeadersToTraceContext(
  headers: Record<string, string | Buffer>
): TraceContext | undefined {
  const traceparent = headers.traceparent?.toString();
  if (!traceparent) return undefined;

  const parts = traceparent.split('-');
  if (parts.length !== 4) return undefined;

  return {
    trace_id: parts[1],
    span_id: parts[2],
    trace_flags: parts[3],
  };
}

// ============================================
// Metrics
// ============================================

/**
 * Record outbox operation metrics
 */
export function recordOutboxMetrics(
  eventType: string,
  operation: 'insert' | 'process' | 'complete' | 'fail',
  durationMs: number,
  attributes?: Record<string, string | number>
) {
  const span = trace.getActiveSpan();
  if (span) {
    span.setAttribute('outbox.operation', operation);
    span.setAttribute('outbox.duration_ms', durationMs);
    
    if (attributes) {
      Object.entries(attributes).forEach(([key, value]) => {
        span.setAttribute(`outbox.${key}`, value);
      });
    }
  }
}

// ============================================
// Setup Helper
// ============================================

/**
 * Initialize OpenTelemetry SDK for Node.js
 * Call this at application startup
 */
export function initializeOpenTelemetry(config: {
  serviceName: string;
  exporterEndpoint?: string;
  enableConsoleExport?: boolean;
}) {
  // Dynamic imports for SDK setup
  return `
// Add to your application entry point:

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';

const sdk = new NodeSDK({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: '${config.serviceName}',
    [SemanticResourceAttributes.SERVICE_VERSION]: '1.0.0',
  }),
  traceExporter: new OTLPTraceExporter({
    url: '${config.exporterEndpoint || 'http://localhost:4318/v1/traces'}',
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();

// Graceful shutdown
process.on('SIGTERM', () => {
  sdk.shutdown()
    .then(() => console.log('OpenTelemetry shut down'))
    .catch((error) => console.error('Error shutting down OTel', error))
    .finally(() => process.exit(0));
});
`;
}

// ============================================
// Usage Example
// ============================================

/*
import { 
  withOutboxInsertSpan, 
  instrumentOutboxInsert,
  withOutboxProcessSpan 
} from './otel-instrumentation';

// Producer side - inserting event
async function createOrder(order: Order) {
  return withOutboxInsertSpan('OrderCreated', order.id, async () => {
    const event = instrumentOutboxInsert({
      tracking_id: crypto.randomUUID(),
      aggregate_id: order.id,
      aggregate_type: 'Order',
      event_type: 'OrderCreated',
      payload: order,
    });
    
    await db.transaction(async (tx) => {
      await tx.insert(orders).values(order);
      await tx.insert(outbox).values(event);
    });
    
    return event;
  });
}

// Consumer side - processing event
async function handleOutboxEvent(event: OutboxEventWithTrace) {
  return withOutboxProcessSpan(event, async () => {
    // Process event with full trace context
    await publishToKafka(event);
  });
}
*/
