import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  BacklogLimiter,
  BacklogLimitExceededError,
} from "../../src/core/domain/services/backlog-limiter";
import type { OutboxRepositoryPort } from "../../src/core/ports/outbox-repository.port";

describe("BacklogLimiter", () => {
  let mockRepository: Partial<OutboxRepositoryPort>;

  beforeEach(() => {
    mockRepository = {
      getPendingCount: vi.fn(),
    };
  });

  describe("checkLimit", () => {
    it("should return true when backlog is within limits", async () => {
      (mockRepository.getPendingCount as ReturnType<typeof vi.fn>).mockResolvedValue(50);

      const limiter = new BacklogLimiter(mockRepository as OutboxRepositoryPort, {
        maxBacklogSize: 100,
        onLimitExceeded: "throw",
      });

      const result = await limiter.checkLimit();
      expect(result).toBe(true);
    });

    it("should throw BacklogLimitExceededError when limit exceeded and action is throw", async () => {
      (mockRepository.getPendingCount as ReturnType<typeof vi.fn>).mockResolvedValue(150);

      const limiter = new BacklogLimiter(mockRepository as OutboxRepositoryPort, {
        maxBacklogSize: 100,
        onLimitExceeded: "throw",
      });

      await expect(limiter.checkLimit()).rejects.toThrow(BacklogLimitExceededError);
    });

    it("should return false and warn when limit exceeded and action is warn", async () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      (mockRepository.getPendingCount as ReturnType<typeof vi.fn>).mockResolvedValue(150);

      const limiter = new BacklogLimiter(mockRepository as OutboxRepositoryPort, {
        maxBacklogSize: 100,
        onLimitExceeded: "warn",
      });

      const result = await limiter.checkLimit();
      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("WARNING: Backlog limit exceeded"),
      );

      consoleSpy.mockRestore();
    });

    it("should return false and warn when limit exceeded and action is drop", async () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      (mockRepository.getPendingCount as ReturnType<typeof vi.fn>).mockResolvedValue(150);

      const limiter = new BacklogLimiter(mockRepository as OutboxRepositoryPort, {
        maxBacklogSize: 100,
        onLimitExceeded: "drop",
      });

      const result = await limiter.checkLimit();
      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining("DROPPING"),
      );

      consoleSpy.mockRestore();
    });
  });

  describe("getUtilization", () => {
    it("should return correct utilization percentage", async () => {
      (mockRepository.getPendingCount as ReturnType<typeof vi.fn>).mockResolvedValue(50);

      const limiter = new BacklogLimiter(mockRepository as OutboxRepositoryPort, {
        maxBacklogSize: 100,
        onLimitExceeded: "throw",
      });

      const utilization = await limiter.getUtilization();
      expect(utilization).toBe(50);
    });

    it("should cap utilization at 100%", async () => {
      (mockRepository.getPendingCount as ReturnType<typeof vi.fn>).mockResolvedValue(200);

      const limiter = new BacklogLimiter(mockRepository as OutboxRepositoryPort, {
        maxBacklogSize: 100,
        onLimitExceeded: "throw",
      });

      const utilization = await limiter.getUtilization();
      expect(utilization).toBe(100);
    });
  });

  describe("isHealthy", () => {
    it("should return true when utilization is below 80%", async () => {
      (mockRepository.getPendingCount as ReturnType<typeof vi.fn>).mockResolvedValue(70);

      const limiter = new BacklogLimiter(mockRepository as OutboxRepositoryPort, {
        maxBacklogSize: 100,
        onLimitExceeded: "throw",
      });

      const healthy = await limiter.isHealthy();
      expect(healthy).toBe(true);
    });

    it("should return false when utilization is 80% or above", async () => {
      (mockRepository.getPendingCount as ReturnType<typeof vi.fn>).mockResolvedValue(85);

      const limiter = new BacklogLimiter(mockRepository as OutboxRepositoryPort, {
        maxBacklogSize: 100,
        onLimitExceeded: "throw",
      });

      const healthy = await limiter.isHealthy();
      expect(healthy).toBe(false);
    });
  });
});
