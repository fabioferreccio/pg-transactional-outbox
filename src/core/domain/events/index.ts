/**
 * Domain Events
 */

export interface DomainEvent<T = unknown> {
  readonly eventType: string;
  readonly aggregateId: string;
  readonly aggregateType: string;
  readonly payload: T;
  readonly occurredAt: Date;
}

export function createDomainEvent<T>(
  eventType: string,
  aggregateId: string,
  aggregateType: string,
  payload: T,
): DomainEvent<T> {
  return {
    eventType,
    aggregateId,
    aggregateType,
    payload,
    occurredAt: new Date(),
  };
}
