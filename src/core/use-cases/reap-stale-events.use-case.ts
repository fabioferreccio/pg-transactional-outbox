/**
 * Reap Stale Events Use Case
 *
 * Recovers events stuck in PROCESSING with expired leases.
 * Implements the Reaper pattern for zombie worker recovery.
 */

import type { OutboxRepositoryPort } from "../ports/outbox-repository.port.js";

export interface ReapStaleEventsResult {
  recovered: number;
}

export class ReapStaleEventsUseCase {
  constructor(private readonly repository: OutboxRepositoryPort) {}

  async execute(): Promise<ReapStaleEventsResult> {
    const recovered = await this.repository.recoverStaleEvents();

    return { recovered };
  }
}
