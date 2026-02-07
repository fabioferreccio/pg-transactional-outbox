/**
 * Worker Monitor (v0.5)
 *
 * Monitors worker health and detects stale processing.
 */

import type { OutboxRepositoryPort } from "../../ports/outbox-repository.port.js";

export interface WorkerMonitorConfig {
  /** How often to check for stale workers in milliseconds */
  checkIntervalMs: number;
  /** Threshold in milliseconds after which processing is considered stale */
  staleThresholdMs: number;
  /** Callback when stale processing is detected */
  onStaleDetected?: (recoveredCount: number) => void;
  /** Callback for auto-restart logic */
  onRestartNeeded?: () => void;
}

export interface WorkerHealth {
  isHealthy: boolean;
  staleEventCount: number;
  lastCheckAt: Date;
}

export class WorkerMonitor {
  private intervalId?: ReturnType<typeof setInterval>;
  private lastHealth: WorkerHealth = {
    isHealthy: true,
    staleEventCount: 0,
    lastCheckAt: new Date(),
  };

  constructor(
    private readonly repository: OutboxRepositoryPort,
    private readonly config: WorkerMonitorConfig,
  ) {}

  /**
   * Start monitoring
   */
  start(): void {
    if (this.intervalId) {
      return;
    }

    this.intervalId = setInterval(async () => {
      await this.checkAndRecover();
    }, this.config.checkIntervalMs);

    console.log(
      `[WorkerMonitor] Started (interval: ${this.config.checkIntervalMs}ms, stale threshold: ${this.config.staleThresholdMs}ms)`,
    );
  }

  /**
   * Stop monitoring
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
      console.log("[WorkerMonitor] Stopped");
    }
  }

  /**
   * Check for stale events and recover them
   */
  async checkAndRecover(): Promise<WorkerHealth> {
    try {
      // Recover stale events (those with expired leases)
      const recoveredCount = await this.repository.recoverStaleEvents();

      this.lastHealth = {
        isHealthy: recoveredCount === 0,
        staleEventCount: recoveredCount,
        lastCheckAt: new Date(),
      };

      if (recoveredCount > 0) {
        console.warn(
          `[WorkerMonitor] Recovered ${recoveredCount} stale events`,
        );

        // Notify callback
        if (this.config.onStaleDetected) {
          this.config.onStaleDetected(recoveredCount);
        }

        // Check if restart is needed (many stale events indicate worker issues)
        if (recoveredCount > 10 && this.config.onRestartNeeded) {
          console.error(
            `[WorkerMonitor] High stale count (${recoveredCount}), triggering restart callback`,
          );
          this.config.onRestartNeeded();
        }
      }

      return this.lastHealth;
    } catch (error) {
      console.error("[WorkerMonitor] Error during check:", error);
      return {
        isHealthy: false,
        staleEventCount: -1,
        lastCheckAt: new Date(),
      };
    }
  }

  /**
   * Get last health status
   */
  getLastHealth(): WorkerHealth {
    return this.lastHealth;
  }

  /**
   * Manual trigger for recovery check
   */
  async triggerCheck(): Promise<WorkerHealth> {
    return this.checkAndRecover();
  }
}
