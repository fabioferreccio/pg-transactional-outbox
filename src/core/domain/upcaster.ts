/**
 * Upcaster
 *
 * Schema transformation at read-time for payload evolution.
 * Allows safe changes to event schema without breaking consumers.
 */

export interface UpcasterFunction<T = unknown> {
  (payload: T): T;
}

export interface VersionedUpcaster<T = unknown> {
  version: number;
  up: UpcasterFunction<T>;
}

/**
 * Upcaster registry for an event type
 */
export class Upcaster<T = unknown> {
  private readonly upcasters: Map<number, UpcasterFunction<T>> = new Map();

  constructor(
    private readonly eventType: string,
    private readonly currentVersion: number,
  ) {}

  /**
   * Register an upcaster for a specific version
   */
  register(version: number, up: UpcasterFunction<T>): this {
    this.upcasters.set(version, up);
    return this;
  }

  /**
   * Register multiple upcasters
   */
  registerAll(upcasters: VersionedUpcaster<T>[]): this {
    for (const { version, up } of upcasters) {
      this.register(version, up);
    }
    return this;
  }

  /**
   * Apply all upcasters from fromVersion to currentVersion
   */
  upcast(payload: T, fromVersion: number): T {
    let result = payload;

    for (let v = fromVersion; v < this.currentVersion; v++) {
      const up = this.upcasters.get(v);
      if (up) {
        result = up(result);
      }
    }

    return result;
  }

  /**
   * Get current schema version
   */
  get version(): number {
    return this.currentVersion;
  }

  /**
   * Get event type this upcaster handles
   */
  get type(): string {
    return this.eventType;
  }
}

/**
 * Registry of upcasters by event type
 */
export class UpcasterRegistry {
  private readonly upcasters: Map<string, Upcaster> = new Map();

  /**
   * Register an upcaster for an event type
   */
  register<T>(upcaster: Upcaster<T>): this {
    this.upcasters.set(upcaster.type, upcaster as unknown as Upcaster);
    return this;
  }

  /**
   * Get upcaster for event type
   */
  get<T>(eventType: string): Upcaster<T> | undefined {
    return this.upcasters.get(eventType) as Upcaster<T> | undefined;
  }

  /**
   * Apply upcasting to a payload
   */
  upcast<T>(eventType: string, payload: T, schemaVersion: number): T {
    const upcaster = this.get<T>(eventType);
    if (!upcaster) {
      return payload; // No upcaster, return as-is
    }
    return upcaster.upcast(payload, schemaVersion);
  }
}

// ============================================
// Factory Functions
// ============================================

/**
 * Create an upcaster for an event type
 */
export function createUpcaster<T>(
  eventType: string,
  currentVersion: number,
  upcasters: VersionedUpcaster<T>[] = [],
): Upcaster<T> {
  return new Upcaster<T>(eventType, currentVersion).registerAll(upcasters);
}

/**
 * Create an upcaster registry
 */
export function createUpcasterRegistry(): UpcasterRegistry {
  return new UpcasterRegistry();
}
