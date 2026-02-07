/**
 * Replay Service (v0.7)
 *
 * Enables replaying events from the outbox to reconstruct state.
 */

import type { OutboxEvent } from "../entities/outbox-event.js";
import type { OutboxRepositoryPort } from "../../ports/outbox-repository.port.js";
import { EventStream, type EventStreamOptions } from "./event-stream.js";
import { SnapshotManager, type Snapshot } from "./snapshot-manager.js";

export type EventHandler = (event: OutboxEvent) => Promise<void>;

export type Reducer<T> = (state: T, event: OutboxEvent) => T;

export interface ReplayOptions extends EventStreamOptions {
  /** Handler to process each event */
  onEvent?: EventHandler;
  /** Progress callback */
  onProgress?: (processed: number, total?: number) => void;
}

export interface ReplayResult {
  /** Total events replayed */
  eventsProcessed: number;
  /** Time taken in milliseconds */
  durationMs: number;
  /** Any errors encountered */
  errors: Array<{ eventId: bigint; error: Error }>;
}

export class ReplayService {
  constructor(
    private readonly repository: OutboxRepositoryPort,
    private readonly snapshotManager?: SnapshotManager,
  ) {}

  /**
   * Replay events matching the given options
   */
  async replay(options: ReplayOptions): Promise<ReplayResult> {
    const startTime = Date.now();
    const errors: Array<{ eventId: bigint; error: Error }> = [];
    let processed = 0;

    const stream = new EventStream(this.repository, options);

    for await (const event of stream) {
      try {
        if (options.onEvent) {
          await options.onEvent(event);
        }
        processed++;

        if (options.onProgress) {
          options.onProgress(processed);
        }
      } catch (error) {
        errors.push({
          eventId: event.id!,
          error: error as Error,
        });
      }
    }

    return {
      eventsProcessed: processed,
      durationMs: Date.now() - startTime,
      errors,
    };
  }

  /**
   * Replay events and reduce them to a final state
   *
   * @example
   * ```typescript
   * interface OrderState { items: string[]; total: number; }
   *
   * const state = await replayService.replayToState<OrderState>(
   *   'order-123',
   *   'Order',
   *   { items: [], total: 0 },
   *   (state, event) => {
   *     if (event.eventType === 'ItemAdded') {
   *       return {
   *         items: [...state.items, event.payload.item],
   *         total: state.total + event.payload.price,
   *       };
   *     }
   *     return state;
   *   },
   * );
   * ```
   */
  async replayToState<T>(
    aggregateId: string,
    aggregateType: string,
    initialState: T,
    reducer: Reducer<T>,
  ): Promise<{ state: T; version: number }> {
    // Try to load from snapshot first
    let state = initialState;
    let version = 0;
    let fromDate: Date | undefined;

    if (this.snapshotManager) {
      const snapshot = await this.snapshotManager.load<T>(aggregateId, aggregateType);
      if (snapshot) {
        state = snapshot.state;
        version = snapshot.version;
        fromDate = snapshot.createdAt;
        console.log(
          `[ReplayService] Loaded snapshot for ${aggregateType}:${aggregateId} at version ${version}`,
        );
      }
    }

    // Replay events after the snapshot
    const stream = new EventStream(this.repository, {
      aggregateId,
      aggregateType,
      fromDate,
      completedOnly: true,
    });

    for await (const event of stream) {
      state = reducer(state, event);
      version++;
    }

    // Optionally save a new snapshot
    if (this.snapshotManager && this.snapshotManager.shouldSnapshot(version)) {
      await this.snapshotManager.save(aggregateId, aggregateType, version, state);
    }

    return { state, version };
  }

  /**
   * Replay a single aggregate's events
   */
  async replayAggregate(
    aggregateId: string,
    handler: EventHandler,
  ): Promise<ReplayResult> {
    return this.replay({
      aggregateId,
      completedOnly: true,
      onEvent: handler,
    });
  }

  /**
   * Dry run - count events without processing
   */
  async dryRun(options: EventStreamOptions): Promise<number> {
    const stream = new EventStream(this.repository, options);
    return stream.count();
  }
}

/**
 * Create a replay service
 */
export function createReplayService(
  repository: OutboxRepositoryPort,
  snapshotManager?: SnapshotManager,
): ReplayService {
  return new ReplayService(repository, snapshotManager);
}
