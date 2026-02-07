/**
 * Event Publisher Port
 *
 * Secondary port for publishing events to external systems.
 */

import type { OutboxEvent } from "../domain/entities/outbox-event.js";

export interface PublishResult {
  success: boolean;
  error?: string;
  externalId?: string;
}

export interface EventPublisherPort {
  /**
   * Publish event to external system (Kafka, SNS, etc.)
   */
  publish(event: OutboxEvent): Promise<PublishResult>;

  /**
   * Check if publisher is healthy
   */
  isHealthy(): Promise<boolean>;
}
