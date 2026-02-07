import { describe, it, expect, vi, beforeEach } from "vitest";
import { HealthChecker } from "../../src/core/domain/services/health-checker";
import type { OutboxRepositoryPort } from "../../src/core/ports/outbox-repository.port";
import type { MetricsPort, OutboxMetrics } from "../../src/core/ports/metrics.port";

describe("HealthChecker", () => {
  let mockRepository: Partial<OutboxRepositoryPort>;
  let mockMetrics: Partial<MetricsPort>;
  let defaultMetrics: OutboxMetrics;

  beforeEach(() => {
    defaultMetrics = {
      pendingTotal: 10,
      completedTotal: 1000,
      deadLetterTotal: 2,
      oldestPendingAgeSeconds: 5,
      backlogUtilizationPercent: 10,
      processingTotal: 0,
      collectedAt: new Date(),
    };

    mockRepository = {};
    mockMetrics = {
      collect: vi.fn().mockResolvedValue(defaultMetrics),
    };
  });

  const createChecker = () =>
    new HealthChecker(mockRepository as OutboxRepositoryPort, mockMetrics as MetricsPort, {
      maxPendingForHealthy: 50,
      maxPendingForDegraded: 100,
      maxLagSecondsHealthy: 30,
      maxLagSecondsDegraded: 60,
      maxDeadLetterForHealthy: 10,
    });

  describe("check", () => {
    it("should return healthy when all metrics are within limits", async () => {
      const checker = createChecker();
      const result = await checker.check();

      expect(result.status).toBe("healthy");
      expect(result.checks.database.status).toBe("healthy");
      expect(result.checks.backlog.status).toBe("healthy");
      expect(result.checks.deadLetter.status).toBe("healthy");
    });

    it("should return degraded when pending count exceeds healthy threshold", async () => {
      defaultMetrics.pendingTotal = 75;
      const checker = createChecker();
      const result = await checker.check();

      expect(result.status).toBe("degraded");
      expect(result.checks.backlog.status).toBe("degraded");
    });

    it("should return unhealthy when pending count exceeds degraded threshold", async () => {
      defaultMetrics.pendingTotal = 150;
      const checker = createChecker();
      const result = await checker.check();

      expect(result.status).toBe("unhealthy");
      expect(result.checks.backlog.status).toBe("unhealthy");
    });

    it("should return degraded when lag exceeds healthy threshold", async () => {
      defaultMetrics.oldestPendingAgeSeconds = 45;
      const checker = createChecker();
      const result = await checker.check();

      expect(result.status).toBe("degraded");
    });

    it("should return unhealthy when dead letters exceed critical threshold", async () => {
      defaultMetrics.deadLetterTotal = 25;
      const checker = createChecker();
      const result = await checker.check();

      expect(result.status).toBe("unhealthy");
      expect(result.checks.deadLetter.status).toBe("unhealthy");
    });
  });

  describe("isAlive", () => {
    it("should return true when healthy", async () => {
      const checker = createChecker();
      const alive = await checker.isAlive();
      expect(alive).toBe(true);
    });

    it("should return true when degraded", async () => {
      defaultMetrics.pendingTotal = 75;
      const checker = createChecker();
      const alive = await checker.isAlive();
      expect(alive).toBe(true);
    });

    it("should return false when unhealthy", async () => {
      defaultMetrics.pendingTotal = 150;
      const checker = createChecker();
      const alive = await checker.isAlive();
      expect(alive).toBe(false);
    });
  });
});
