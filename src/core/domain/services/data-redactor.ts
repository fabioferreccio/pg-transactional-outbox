/**
 * Data Redactor (v0.9)
 *
 * GDPR-compliant data redaction for outbox events.
 */

import { OutboxEvent } from "../entities/outbox-event.js";
import type { OutboxRepositoryPort } from "../../ports/outbox-repository.port.js";

export interface RedactionConfig {
  /** Fields to always redact */
  sensitiveFields?: string[];
  /** Redaction marker */
  redactionMarker?: string;
  /** Log redactions */
  logRedactions?: boolean;
}

export interface RedactionResult {
  eventsRedacted: number;
  fieldsRedacted: number;
}

export class DataRedactor {
  private readonly sensitiveFields: Set<string>;
  private readonly redactionMarker: string;
  private readonly logRedactions: boolean;

  constructor(config: RedactionConfig = {}) {
    this.sensitiveFields = new Set(
      config.sensitiveFields ?? [
        "email",
        "phone",
        "ssn",
        "password",
        "creditCard",
        "address",
        "name",
        "firstName",
        "lastName",
        "dateOfBirth",
        "ipAddress",
      ],
    );
    this.redactionMarker = config.redactionMarker ?? "[REDACTED]";
    this.logRedactions = config.logRedactions ?? true;
  }

  /**
   * Redact sensitive fields from an event payload
   */
  redactPayload<T extends Record<string, unknown>>(payload: T): T {
    const redacted = { ...payload };
    let fieldsRedacted = 0;

    for (const key of Object.keys(redacted)) {
      if (this.isSensitiveField(key)) {
        redacted[key as keyof T] = this.redactionMarker as T[keyof T];
        fieldsRedacted++;
      } else if (
        typeof redacted[key] === "object" &&
        redacted[key] !== null &&
        !Array.isArray(redacted[key])
      ) {
        // Recursively redact nested objects (but not arrays)
        redacted[key as keyof T] = this.redactPayload(
          redacted[key] as Record<string, unknown>,
        ) as T[keyof T];
      }
    }

    if (this.logRedactions && fieldsRedacted > 0) {
      console.log(`[DataRedactor] Redacted ${fieldsRedacted} field(s)`);
    }

    return redacted;
  }

  /**
   * Check if a field name is sensitive
   */
  isSensitiveField(fieldName: string): boolean {
    const lowerField = fieldName.toLowerCase();
    for (const sensitive of this.sensitiveFields) {
      if (lowerField.includes(sensitive.toLowerCase())) {
        return true;
      }
    }
    return false;
  }

  /**
   * Add a field to the sensitive fields list
   */
  addSensitiveField(fieldName: string): void {
    this.sensitiveFields.add(fieldName);
  }

  /**
   * Remove a field from the sensitive fields list
   */
  removeSensitiveField(fieldName: string): void {
    this.sensitiveFields.delete(fieldName);
  }

  /**
   * Get all configured sensitive fields
   */
  getSensitiveFields(): string[] {
    return Array.from(this.sensitiveFields);
  }

  /**
   * Redact all events for a data subject (GDPR right to erasure)
   */
  async redactBySubject(
    repository: OutboxRepositoryPort,
    subjectId: string,
    subjectField = "userId",
  ): Promise<RedactionResult> {
    // This is a conceptual implementation
    // In practice, you'd need to query events by subject and update them
    console.log(
      `[DataRedactor] Redacting events for subject ${subjectId} (field: ${subjectField})`,
    );

    // Return placeholder - real implementation would update database
    return {
      eventsRedacted: 0,
      fieldsRedacted: 0,
    };
  }

  /**
   * Create a redacted copy of an event
   */
  createRedactedEvent(event: OutboxEvent): OutboxEvent {
    const redactedPayload = this.redactPayload(
      event.payload as Record<string, unknown>,
    );

    return OutboxEvent.reconstitute({
      id: event.id,
      trackingId: event.trackingId,
      aggregateId: event.aggregateId,
      aggregateType: event.aggregateType,
      eventType: event.eventType,
      payload: redactedPayload,
      metadata: event.metadata,
      status: event.status,
      retryCount: event.retryCount,
      maxRetries: event.maxRetries,
      createdAt: event.createdAt,
      processedAt: event.processedAt,
      lockedUntil: event.lockedUntil,
      lockToken: event.lockToken,
      lastError: event.lastError,
      owner: event.owner,
    });
  }
}
