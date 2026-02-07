/**
 * Domain Errors
 */

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}

export class EventNotFoundError extends DomainError {
  constructor(eventId: string) {
    super(`Event not found: ${eventId}`);
    this.name = "EventNotFoundError";
  }
}

export class LeaseExpiredError extends DomainError {
  constructor(eventId: string) {
    super(`Lease expired for event: ${eventId}`);
    this.name = "LeaseExpiredError";
  }
}

export class MaxRetriesExceededError extends DomainError {
  constructor(eventId: string, maxRetries: number) {
    super(`Max retries (${maxRetries}) exceeded for event: ${eventId}`);
    this.name = "MaxRetriesExceededError";
  }
}

export class IdempotencyViolationError extends DomainError {
  constructor(trackingId: string) {
    super(`Idempotency violation: event ${trackingId} already processed`);
    this.name = "IdempotencyViolationError";
  }
}
