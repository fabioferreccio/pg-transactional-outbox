import { describe, it, expect } from "vitest";
import { CDCEventTransformer } from "../../src/adapters/cdc/cdc-event-transformer";
import type { DebeziumMessage, LogicalReplicationMessage } from "../../src/adapters/cdc/cdc-event-transformer";

describe("CDCEventTransformer", () => {
  describe("fromDebeziumMessage", () => {
    const createDebeziumMessage = (
      op: "c" | "u" | "d" | "r",
      row: object | null,
    ): DebeziumMessage => ({
      payload: {
        before: null,
        after: row as DebeziumMessage["payload"]["after"],
        source: {
          version: "2.0.0",
          connector: "postgresql",
          name: "test",
          ts_ms: 1640000000000,
          snapshot: "false",
          db: "testdb",
          sequence: [],
          schema: "public",
          table: "outbox",
          txId: 1,
          lsn: 1000,
          xmin: null,
        },
        op,
        ts_ms: 1640000000000,
        transaction: null,
      },
    });

    const validRow = {
      id: "123",
      tracking_id: "track-123",
      aggregate_id: "order-1",
      aggregate_type: "Order",
      event_type: "OrderCreated",
      payload: '{"amount": 100}',
      status: "PENDING",
      retry_count: 0,
      max_retries: 5,
      created_at: 1640000000000000,
    };

    it("should transform INSERT message to OutboxEvent", () => {
      const message = createDebeziumMessage("c", validRow);
      const event = CDCEventTransformer.fromDebeziumMessage(message);

      expect(event).not.toBeNull();
      expect(event!.trackingId).toBe("track-123");
      expect(event!.aggregateId).toBe("order-1");
      expect(event!.eventType).toBe("OrderCreated");
      expect(event!.payload).toEqual({ amount: 100 });
    });

    it("should return null for UPDATE operations", () => {
      const message = createDebeziumMessage("u", validRow);
      const event = CDCEventTransformer.fromDebeziumMessage(message);

      expect(event).toBeNull();
    });

    it("should return null for DELETE operations", () => {
      const message = createDebeziumMessage("d", null);
      const event = CDCEventTransformer.fromDebeziumMessage(message);

      expect(event).toBeNull();
    });

    it("should handle READ (snapshot) operations", () => {
      const message = createDebeziumMessage("r", validRow);
      const event = CDCEventTransformer.fromDebeziumMessage(message);

      expect(event).not.toBeNull();
    });
  });

  describe("fromLogicalReplication", () => {
    it("should transform INSERT message to OutboxEvent", () => {
      const message: LogicalReplicationMessage = {
        lsn: "0/1234",
        table: "outbox",
        operation: "INSERT",
        columns: {
          id: "456",
          tracking_id: "track-456",
          aggregate_id: "user-1",
          aggregate_type: "User",
          event_type: "UserCreated",
          payload: '{"name": "John"}',
          status: "PENDING",
          retry_count: 0,
          max_retries: 5,
          created_at: new Date().toISOString(),
        },
      };

      const event = CDCEventTransformer.fromLogicalReplication(message);

      expect(event).not.toBeNull();
      expect(event!.trackingId).toBe("track-456");
      expect(event!.aggregateType).toBe("User");
    });

    it("should return null for UPDATE operations", () => {
      const message: LogicalReplicationMessage = {
        lsn: "0/1234",
        table: "outbox",
        operation: "UPDATE",
        columns: {},
      };

      const event = CDCEventTransformer.fromLogicalReplication(message);
      expect(event).toBeNull();
    });
  });

  describe("isOutboxMessage", () => {
    it("should return true for outbox table", () => {
      const message: DebeziumMessage = {
        payload: {
          source: { table: "outbox" } as DebeziumMessage["payload"]["source"],
          op: "c",
          ts_ms: 0,
          transaction: null,
        },
      };

      expect(CDCEventTransformer.isOutboxMessage(message)).toBe(true);
    });

    it("should return false for other tables", () => {
      const message: DebeziumMessage = {
        payload: {
          source: { table: "users" } as DebeziumMessage["payload"]["source"],
          op: "c",
          ts_ms: 0,
          transaction: null,
        },
      };

      expect(CDCEventTransformer.isOutboxMessage(message)).toBe(false);
    });
  });
});
