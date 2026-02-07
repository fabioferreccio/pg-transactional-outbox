import { describe, it, expect, vi, beforeEach } from "vitest";
import { MetricsCollector } from "../../src/core/domain/services/metrics-collector";
import type { OutboxRepositoryPort } from "../../src/core/ports/outbox-repository.port";

describe("MetricsCollector", () => {
  let mockRepository: Partial<OutboxRepositoryPort>;

  beforeEach(() => {
    mockRepository = {
      getPendingCount: vi.fn().mockResolvedValue(50),
      getCompletedCount: vi.fn().mockResolvedValue(1000),
      getDeadLetterCount: vi.fn().mockResolvedValue(5),
      getOldestPendingAgeSeconds: vi.fn().mockResolvedValue(30),
    };
  });

  describe("collect", () => {
    it("should collect all metrics from repository", async () => {
      const collector = new MetricsCollector(mockRepository as OutboxRepositoryPort, {
        maxBacklogSize: 100,
      });

      const metrics = await collector.collect();

      expect(metrics.pendingTotal).toBe(50);
      expect(metrics.completedTotal).toBe(1000);
      expect(metrics.deadLetterTotal).toBe(5);
      expect(metrics.oldestPendingAgeSeconds).toBe(30);
      expect(metrics.backlogUtilizationPercent).toBe(50);
      expect(metrics.collectedAt).toBeInstanceOf(Date);
    });

    it("should cap utilization at 100%", async () => {
      (mockRepository.getPendingCount as ReturnType<typeof vi.fn>).mockResolvedValue(200);

      const collector = new MetricsCollector(mockRepository as OutboxRepositoryPort, {
        maxBacklogSize: 100,
      });

      const metrics = await collector.collect();
      expect(metrics.backlogUtilizationPercent).toBe(100);
    });
  });

  describe("toPrometheusFormat", () => {
    it("should output valid Prometheus format", async () => {
      const collector = new MetricsCollector(mockRepository as OutboxRepositoryPort, {
        maxBacklogSize: 100,
        metricsPrefix: "test",
      });

      const output = await collector.toPrometheusFormat();

      expect(output).toContain("# HELP test_pending_total");
      expect(output).toContain("# TYPE test_pending_total gauge");
      expect(output).toContain("test_pending_total 50");
      expect(output).toContain("test_completed_total 1000");
      expect(output).toContain("test_dead_letter_total 5");
    });

    it("should use default prefix if not specified", async () => {
      const collector = new MetricsCollector(mockRepository as OutboxRepositoryPort, {
        maxBacklogSize: 100,
      });

      const output = await collector.toPrometheusFormat();

      expect(output).toContain("outbox_pending_total");
    });
  });
});
