/**
 * Idempotency Store Port
 *
 * Port for consumer-side idempotency tracking.
 */

export interface IdempotencyRecord {
  trackingId: string;
  processedAt: Date;
  consumerId: string;
}

export interface IdempotencyStorePort {
  /**
   * Check if event was already processed
   */
  isProcessed(trackingId: string): Promise<boolean>;

  /**
   * Mark event as processed (atomically with business operation)
   */
  markProcessed(trackingId: string, consumerId: string): Promise<boolean>;

  /**
   * Get processing record
   */
  getRecord(trackingId: string): Promise<IdempotencyRecord | null>;

  /**
   * Cleanup old records (optional)
   */
  cleanup?(olderThanDays: number): Promise<number>;
}
