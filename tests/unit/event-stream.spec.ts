import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventStream, createEventStream } from "../../src/core/domain/services/event-stream";
import { OutboxEvent } from "../../src/core/domain/entities/outbox-event";
import type { OutboxRepositoryPort } from "../../src/core/ports/outbox-repository.port";

describe("EventStream", () => {
  let mockRepository: Partial<OutboxRepositoryPort>;
  let mockEvents: OutboxEvent[];

  beforeEach(() => {
    mockEvents = [
      OutboxEvent.reconstitute({
        id: 1n,
        trackingId: "track-1",
        aggregateId: "order-1",
        aggregateType: "Order",
        eventType: "OrderCreated",
        payload: {},
        status: "COMPLETED",
        retryCount: 0,
        maxRetries: 5,
        createdAt: new Date("2024-01-01"),
      }),
      OutboxEvent.reconstitute({
        id: 2n,
        trackingId: "track-2",
        aggregateId: "order-1",
        aggregateType: "Order",
        eventType: "ItemAdded",
        payload: {},
        status: "COMPLETED",
        retryCount: 0,
        maxRetries: 5,
        createdAt: new Date("2024-01-02"),
      }),
      OutboxEvent.reconstitute({
        id: 3n,
        trackingId: "track-3",
        aggregateId: "order-2",
        aggregateType: "Order",
        eventType: "OrderCreated",
        payload: {},
        status: "PENDING",
        retryCount: 0,
        maxRetries: 5,
        createdAt: new Date("2024-01-03"),
      }),
    ];

    mockRepository = {
      findRecent: vi.fn().mockImplementation(({ after }) => {
        if (after === undefined) {
          return Promise.resolve(mockEvents);
        }
        const idx = mockEvents.findIndex((e) => e.id === after);
        return Promise.resolve(mockEvents.slice(idx + 1));
      }),
    };
  });

  describe("async iterator", () => {
    it("should iterate over all events", async () => {
      const stream = new EventStream(mockRepository as OutboxRepositoryPort);
      const collected: OutboxEvent[] = [];

      for await (const event of stream) {
        collected.push(event);
      }

      expect(collected).toHaveLength(3);
    });

    it("should filter by aggregateId", async () => {
      const stream = new EventStream(mockRepository as OutboxRepositoryPort, {
        aggregateId: "order-1",
      });

      const collected = await stream.toArray();
      expect(collected).toHaveLength(2);
      expect(collected.every((e) => e.aggregateId === "order-1")).toBe(true);
    });

    it("should filter by eventType", async () => {
      const stream = new EventStream(mockRepository as OutboxRepositoryPort, {
        eventTypes: ["OrderCreated"],
      });

      const collected = await stream.toArray();
      expect(collected).toHaveLength(2);
      expect(collected.every((e) => e.eventType === "OrderCreated")).toBe(true);
    });

    it("should filter completedOnly", async () => {
      const stream = new EventStream(mockRepository as OutboxRepositoryPort, {
        completedOnly: true,
      });

      const collected = await stream.toArray();
      expect(collected).toHaveLength(2);
      expect(collected.every((e) => e.status === "COMPLETED")).toBe(true);
    });
  });

  describe("toArray", () => {
    it("should collect all events into array", async () => {
      const stream = new EventStream(mockRepository as OutboxRepositoryPort);
      const events = await stream.toArray();
      expect(events).toHaveLength(3);
    });
  });

  describe("count", () => {
    it("should count matching events", async () => {
      const stream = new EventStream(mockRepository as OutboxRepositoryPort, {
        aggregateId: "order-1",
      });

      const count = await stream.count();
      expect(count).toBe(2);
    });
  });

  describe("createEventStream", () => {
    it("should create stream with helper function", () => {
      const stream = createEventStream(mockRepository as OutboxRepositoryPort);
      expect(stream).toBeInstanceOf(EventStream);
    });
  });
});
