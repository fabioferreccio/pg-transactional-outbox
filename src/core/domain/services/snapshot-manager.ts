/**
 * Snapshot Manager (v0.7)
 *
 * Manages aggregate state snapshots for efficient state reconstruction.
 */

export interface Snapshot<T = unknown> {
  /** Aggregate identifier */
  aggregateId: string;
  /** Aggregate type */
  aggregateType: string;
  /** Version/sequence number of the snapshot */
  version: number;
  /** Serialized aggregate state */
  state: T;
  /** Timestamp when snapshot was created */
  createdAt: Date;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

export interface SnapshotStore {
  save<T>(snapshot: Snapshot<T>): Promise<void>;
  load<T>(aggregateId: string, aggregateType: string): Promise<Snapshot<T> | null>;
  delete(aggregateId: string, aggregateType: string): Promise<boolean>;
  listByType(aggregateType: string): Promise<Snapshot[]>;
}

export interface SnapshotManagerConfig {
  /** Snapshot store implementation */
  store: SnapshotStore;
  /** How often to create snapshots (every N events) */
  snapshotFrequency?: number;
}

/**
 * In-memory snapshot store (for testing/development)
 */
export class InMemorySnapshotStore implements SnapshotStore {
  private snapshots = new Map<string, Snapshot>();

  private key(aggregateId: string, aggregateType: string): string {
    return `${aggregateType}:${aggregateId}`;
  }

  async save<T>(snapshot: Snapshot<T>): Promise<void> {
    this.snapshots.set(
      this.key(snapshot.aggregateId, snapshot.aggregateType),
      snapshot as Snapshot,
    );
  }

  async load<T>(aggregateId: string, aggregateType: string): Promise<Snapshot<T> | null> {
    const snapshot = this.snapshots.get(this.key(aggregateId, aggregateType));
    return (snapshot as Snapshot<T>) ?? null;
  }

  async delete(aggregateId: string, aggregateType: string): Promise<boolean> {
    return this.snapshots.delete(this.key(aggregateId, aggregateType));
  }

  async listByType(aggregateType: string): Promise<Snapshot[]> {
    const results: Snapshot[] = [];
    for (const [key, snapshot] of this.snapshots) {
      if (key.startsWith(`${aggregateType}:`)) {
        results.push(snapshot);
      }
    }
    return results;
  }

  clear(): void {
    this.snapshots.clear();
  }
}

export class SnapshotManager {
  private readonly snapshotFrequency: number;

  constructor(private readonly config: SnapshotManagerConfig) {
    this.snapshotFrequency = config.snapshotFrequency ?? 100;
  }

  /**
   * Save a snapshot of aggregate state
   */
  async save<T>(
    aggregateId: string,
    aggregateType: string,
    version: number,
    state: T,
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const snapshot: Snapshot<T> = {
      aggregateId,
      aggregateType,
      version,
      state,
      createdAt: new Date(),
      metadata,
    };

    await this.config.store.save(snapshot);
    console.log(
      `[SnapshotManager] Saved snapshot for ${aggregateType}:${aggregateId} at version ${version}`,
    );
  }

  /**
   * Load the latest snapshot for an aggregate
   */
  async load<T>(aggregateId: string, aggregateType: string): Promise<Snapshot<T> | null> {
    return this.config.store.load<T>(aggregateId, aggregateType);
  }

  /**
   * Delete a snapshot
   */
  async delete(aggregateId: string, aggregateType: string): Promise<boolean> {
    return this.config.store.delete(aggregateId, aggregateType);
  }

  /**
   * Check if a snapshot should be created based on event count
   */
  shouldSnapshot(eventsSinceLastSnapshot: number): boolean {
    return eventsSinceLastSnapshot >= this.snapshotFrequency;
  }

  /**
   * Get snapshot frequency
   */
  getSnapshotFrequency(): number {
    return this.snapshotFrequency;
  }
}
