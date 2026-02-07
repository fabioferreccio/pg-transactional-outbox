import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  AuditLogger,
  InMemoryAuditLogStore,
  type AuditAction,
} from "../../src/core/domain/services/audit-logger";
import { OutboxEvent } from "../../src/core/domain/entities/outbox-event";

describe("AuditLogger", () => {
  let store: InMemoryAuditLogStore;
  let logger: AuditLogger;

  beforeEach(() => {
    store = new InMemoryAuditLogStore();
    logger = new AuditLogger({ store, defaultActor: "test-system" });
  });

  const createMockEvent = (): OutboxEvent =>
    OutboxEvent.reconstitute({
      id: 1n,
      trackingId: "track-123",
      aggregateId: "order-1",
      aggregateType: "Order",
      eventType: "OrderCreated",
      payload: { amount: 100 },
      status: "PENDING",
      retryCount: 0,
      maxRetries: 5,
      createdAt: new Date(),
    });

  describe("logEvent", () => {
    it("should log an event action", async () => {
      const event = createMockEvent();

      await logger.logEvent("CREATE", event);

      const entries = await logger.getAuditLog();
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe("CREATE");
      expect(entries[0].trackingId).toBe("track-123");
      expect(entries[0].actor).toBe("test-system");
    });

    it("should include metadata when provided", async () => {
      const event = createMockEvent();

      await logger.logEvent("COMPLETE", event, { processingTimeMs: 150 });

      const entries = await logger.getAuditLog();
      expect(entries[0].metadata).toHaveProperty("processingTimeMs", 150);
    });
  });

  describe("log", () => {
    it("should log generic actions", async () => {
      await logger.log("DELETE", { trackingId: "deleted-event" });

      const entries = await logger.getAuditLog();
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe("DELETE");
    });
  });

  describe("getAuditLog", () => {
    it("should filter by action", async () => {
      const event = createMockEvent();
      await logger.logEvent("CREATE", event);
      await logger.logEvent("COMPLETE", event);

      const createEntries = await logger.getAuditLog({ action: "CREATE" });
      expect(createEntries).toHaveLength(1);
    });

    it("should support pagination", async () => {
      const event = createMockEvent();
      for (let i = 0; i < 10; i++) {
        await logger.logEvent("CREATE", event);
      }

      const page1 = await logger.getAuditLog({ limit: 5, offset: 0 });
      const page2 = await logger.getAuditLog({ limit: 5, offset: 5 });

      expect(page1).toHaveLength(5);
      expect(page2).toHaveLength(5);
    });
  });

  describe("countEntries", () => {
    it("should count matching entries", async () => {
      const event = createMockEvent();
      await logger.logEvent("CREATE", event);
      await logger.logEvent("COMPLETE", event);
      await logger.logEvent("CREATE", event);

      const count = await logger.countEntries({ action: "CREATE" });
      expect(count).toBe(2);
    });
  });
});

describe("InMemoryAuditLogStore", () => {
  it("should clear all entries", async () => {
    const store = new InMemoryAuditLogStore();

    await store.append({
      id: "1",
      timestamp: new Date(),
      action: "CREATE",
    });

    store.clear();

    const entries = await store.query({});
    expect(entries).toHaveLength(0);
  });
});
