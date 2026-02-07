/**
 * Event Status Value Object
 */

export type EventStatus =
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "DEAD_LETTER";

export const EventStatusValues = {
  PENDING: "PENDING" as const,
  PROCESSING: "PROCESSING" as const,
  COMPLETED: "COMPLETED" as const,
  FAILED: "FAILED" as const,
  DEAD_LETTER: "DEAD_LETTER" as const,
};

export function isValidEventStatus(status: string): status is EventStatus {
  return Object.values(EventStatusValues).includes(status as EventStatus);
}

export function isTerminalStatus(status: EventStatus): boolean {
  return status === "COMPLETED" || status === "DEAD_LETTER";
}

export function isRetryableStatus(status: EventStatus): boolean {
  return status === "PENDING" || status === "FAILED";
}
