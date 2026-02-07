import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WorkerMonitor } from "../../src/core/domain/services/worker-monitor";
import type { OutboxRepositoryPort } from "../../src/core/ports/outbox-repository.port";

describe("WorkerMonitor", () => {
  let mockRepository: Partial<OutboxRepositoryPort>;

  beforeEach(() => {
    mockRepository = {
      recoverStaleEvents: vi.fn().mockResolvedValue(0),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("checkAndRecover", () => {
    it("should return healthy when no stale events", async () => {
      const monitor = new WorkerMonitor(mockRepository as OutboxRepositoryPort, {
        checkIntervalMs: 1000,
        staleThresholdMs: 30000,
      });

      const health = await monitor.checkAndRecover();

      expect(health.isHealthy).toBe(true);
      expect(health.staleEventCount).toBe(0);
    });

    it("should return unhealthy and call callback when stale events found", async () => {
      (mockRepository.recoverStaleEvents as ReturnType<typeof vi.fn>).mockResolvedValue(5);
      const onStaleDetected = vi.fn();

      const monitor = new WorkerMonitor(mockRepository as OutboxRepositoryPort, {
        checkIntervalMs: 1000,
        staleThresholdMs: 30000,
        onStaleDetected,
      });

      const health = await monitor.checkAndRecover();

      expect(health.isHealthy).toBe(false);
      expect(health.staleEventCount).toBe(5);
      expect(onStaleDetected).toHaveBeenCalledWith(5);
    });

    it("should trigger restart callback when many stale events", async () => {
      (mockRepository.recoverStaleEvents as ReturnType<typeof vi.fn>).mockResolvedValue(15);
      const onRestartNeeded = vi.fn();

      const monitor = new WorkerMonitor(mockRepository as OutboxRepositoryPort, {
        checkIntervalMs: 1000,
        staleThresholdMs: 30000,
        onRestartNeeded,
      });

      await monitor.checkAndRecover();

      expect(onRestartNeeded).toHaveBeenCalled();
    });
  });

  describe("getLastHealth", () => {
    it("should return last health status", async () => {
      const monitor = new WorkerMonitor(mockRepository as OutboxRepositoryPort, {
        checkIntervalMs: 1000,
        staleThresholdMs: 30000,
      });

      await monitor.checkAndRecover();
      const health = monitor.getLastHealth();

      expect(health.isHealthy).toBe(true);
      expect(health.lastCheckAt).toBeInstanceOf(Date);
    });
  });

  describe("start/stop", () => {
    it("should start and stop monitoring", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const monitor = new WorkerMonitor(mockRepository as OutboxRepositoryPort, {
        checkIntervalMs: 10000,
        staleThresholdMs: 30000,
      });

      monitor.start();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Started"));

      monitor.stop();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Stopped"));

      consoleSpy.mockRestore();
    });
  });
});
