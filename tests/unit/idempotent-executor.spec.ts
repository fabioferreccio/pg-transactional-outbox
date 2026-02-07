import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  IdempotentExecutor,
  createIdempotentExecutor,
} from "../../src/core/domain/services/idempotent-executor";
import type { IdempotencyStorePort } from "../../src/core/ports/idempotency-store.port";

describe("IdempotentExecutor", () => {
  let mockStore: Partial<IdempotencyStorePort>;

  beforeEach(() => {
    mockStore = {
      getRecord: vi.fn().mockResolvedValue(null),
      markProcessed: vi.fn().mockResolvedValue(true),
      isProcessed: vi.fn().mockResolvedValue(false),
    };
  });

  describe("withIdempotency", () => {
    it("should execute function when not previously processed", async () => {
      const executor = new IdempotentExecutor({
        store: mockStore as IdempotencyStorePort,
        consumerId: "test-consumer",
      });

      const fn = vi.fn().mockResolvedValue({ result: "success" });

      const result = await executor.withIdempotency("tracking-123", fn);

      expect(result.executed).toBe(true);
      expect(result.result).toEqual({ result: "success" });
      expect(fn).toHaveBeenCalledOnce();
    });

    it("should skip execution when already processed", async () => {
      const processedAt = new Date("2024-01-01");
      (mockStore.getRecord as ReturnType<typeof vi.fn>).mockResolvedValue({
        trackingId: "tracking-123",
        processedAt,
        consumerId: "test-consumer",
      });

      const executor = new IdempotentExecutor({
        store: mockStore as IdempotencyStorePort,
        consumerId: "test-consumer",
      });

      const fn = vi.fn().mockResolvedValue({ result: "success" });

      const result = await executor.withIdempotency("tracking-123", fn);

      expect(result.executed).toBe(false);
      expect(result.processedAt).toEqual(processedAt);
      expect(fn).not.toHaveBeenCalled();
    });

    it("should handle race condition when markProcessed returns false", async () => {
      (mockStore.markProcessed as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      (mockStore.getRecord as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(null) // First check
        .mockResolvedValueOnce({
          trackingId: "tracking-123",
          processedAt: new Date(),
          consumerId: "other-consumer",
        }); // After race

      const executor = new IdempotentExecutor({
        store: mockStore as IdempotencyStorePort,
        consumerId: "test-consumer",
      });

      const fn = vi.fn().mockResolvedValue({ result: "success" });

      const result = await executor.withIdempotency("tracking-123", fn);

      expect(result.executed).toBe(false);
      expect(fn).not.toHaveBeenCalled();
    });

    it("should propagate errors from function execution", async () => {
      const executor = new IdempotentExecutor({
        store: mockStore as IdempotencyStorePort,
        consumerId: "test-consumer",
      });

      const error = new Error("Payment failed");
      const fn = vi.fn().mockRejectedValue(error);

      await expect(executor.withIdempotency("tracking-123", fn)).rejects.toThrow(
        "Payment failed",
      );
    });
  });

  describe("wasProcessed", () => {
    it("should return true when already processed", async () => {
      (mockStore.isProcessed as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      const executor = new IdempotentExecutor({
        store: mockStore as IdempotencyStorePort,
        consumerId: "test-consumer",
      });

      const result = await executor.wasProcessed("tracking-123");
      expect(result).toBe(true);
    });

    it("should return false when not processed", async () => {
      const executor = new IdempotentExecutor({
        store: mockStore as IdempotencyStorePort,
        consumerId: "test-consumer",
      });

      const result = await executor.wasProcessed("tracking-123");
      expect(result).toBe(false);
    });
  });

  describe("getConsumerId", () => {
    it("should return the configured consumer ID", () => {
      const executor = new IdempotentExecutor({
        store: mockStore as IdempotencyStorePort,
        consumerId: "my-service",
      });

      expect(executor.getConsumerId()).toBe("my-service");
    });
  });

  describe("createIdempotentExecutor", () => {
    it("should create executor with helper function", () => {
      const executor = createIdempotentExecutor(
        mockStore as IdempotencyStorePort,
        "helper-consumer",
      );

      expect(executor).toBeInstanceOf(IdempotentExecutor);
      expect(executor.getConsumerId()).toBe("helper-consumer");
    });
  });
});
