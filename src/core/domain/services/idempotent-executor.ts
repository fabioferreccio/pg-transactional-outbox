/**
 * Idempotent Executor (v0.6)
 *
 * Provides a wrapper for idempotent execution of external operations.
 * Ensures operations are only executed once per tracking ID.
 */

import type { IdempotencyStorePort } from "../../ports/idempotency-store.port.js";

export interface IdempotentExecutorConfig {
  /** Idempotency store for tracking processed operations */
  store: IdempotencyStorePort;
  /** Consumer identifier for this executor */
  consumerId: string;
}

export interface ExecutionResult<T> {
  /** Whether the function was actually executed (false = already processed) */
  executed: boolean;
  /** Result of the function execution (undefined if skipped) */
  result?: T;
  /** Timestamp when originally processed (if skipped) */
  processedAt?: Date;
}

export class IdempotentExecutor {
  constructor(private readonly config: IdempotentExecutorConfig) {}

  /**
   * Execute a function only if it hasn't been processed before.
   *
   * @param trackingId - Unique identifier for this operation (typically event tracking ID)
   * @param fn - The function to execute idempotently
   * @returns ExecutionResult with executed flag and result
   *
   * @example
   * ```typescript
   * const executor = new IdempotentExecutor({ store, consumerId: 'payment-service' });
   *
   * const result = await executor.withIdempotency(event.trackingId, async () => {
   *   return await stripe.paymentIntents.create({
   *     amount: 1000,
   *     currency: 'usd',
   *   }, {
   *     idempotencyKey: event.trackingId, // Forward to Stripe
   *   });
   * });
   *
   * if (result.executed) {
   *   console.log('Payment created:', result.result);
   * } else {
   *   console.log('Duplicate - already processed at:', result.processedAt);
   * }
   * ```
   */
  async withIdempotency<T>(
    trackingId: string,
    fn: () => Promise<T>,
  ): Promise<ExecutionResult<T>> {
    // Check if already processed
    const existingRecord = await this.config.store.getRecord(trackingId);

    if (existingRecord) {
      console.log(
        `[IdempotentExecutor] Skipping ${trackingId} - already processed at ${existingRecord.processedAt.toISOString()}`,
      );
      return {
        executed: false,
        processedAt: existingRecord.processedAt,
      };
    }

    // Try to mark as processed (atomic check-and-set)
    const marked = await this.config.store.markProcessed(
      trackingId,
      this.config.consumerId,
    );

    if (!marked) {
      // Race condition: another process marked it first
      const record = await this.config.store.getRecord(trackingId);
      console.log(
        `[IdempotentExecutor] Race condition on ${trackingId} - marked by another process`,
      );
      return {
        executed: false,
        processedAt: record?.processedAt,
      };
    }

    // Execute the function
    try {
      const result = await fn();
      return {
        executed: true,
        result,
      };
    } catch (error) {
      // Note: We don't rollback the idempotency mark.
      // This is intentional - at-least-once semantics mean the caller
      // should handle failures and may retry with a new tracking ID.
      console.error(
        `[IdempotentExecutor] Error executing ${trackingId}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * Check if an operation was already processed without executing anything.
   */
  async wasProcessed(trackingId: string): Promise<boolean> {
    return this.config.store.isProcessed(trackingId);
  }

  /**
   * Get the consumer ID for this executor.
   */
  getConsumerId(): string {
    return this.config.consumerId;
  }
}

/**
 * Helper function to create an IdempotentExecutor
 */
export function createIdempotentExecutor(
  store: IdempotencyStorePort,
  consumerId: string,
): IdempotentExecutor {
  return new IdempotentExecutor({ store, consumerId });
}
