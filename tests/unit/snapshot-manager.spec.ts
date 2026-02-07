import { describe, it, expect, beforeEach } from "vitest";
import {
  SnapshotManager,
  InMemorySnapshotStore,
} from "../../src/core/domain/services/snapshot-manager";

describe("SnapshotManager", () => {
  let store: InMemorySnapshotStore;
  let manager: SnapshotManager;

  beforeEach(() => {
    store = new InMemorySnapshotStore();
    manager = new SnapshotManager({ store, snapshotFrequency: 10 });
  });

  describe("save and load", () => {
    it("should save and load a snapshot", async () => {
      const state = { items: ["apple", "banana"], total: 100 };

      await manager.save("order-123", "Order", 5, state);

      const loaded = await manager.load<typeof state>("order-123", "Order");

      expect(loaded).not.toBeNull();
      expect(loaded?.aggregateId).toBe("order-123");
      expect(loaded?.aggregateType).toBe("Order");
      expect(loaded?.version).toBe(5);
      expect(loaded?.state).toEqual(state);
    });

    it("should return null for non-existent snapshot", async () => {
      const loaded = await manager.load("non-existent", "Order");
      expect(loaded).toBeNull();
    });
  });

  describe("delete", () => {
    it("should delete an existing snapshot", async () => {
      await manager.save("order-123", "Order", 5, { items: [] });

      const deleted = await manager.delete("order-123", "Order");
      expect(deleted).toBe(true);

      const loaded = await manager.load("order-123", "Order");
      expect(loaded).toBeNull();
    });

    it("should return false when deleting non-existent", async () => {
      const deleted = await manager.delete("non-existent", "Order");
      expect(deleted).toBe(false);
    });
  });

  describe("shouldSnapshot", () => {
    it("should return true when events exceed frequency", () => {
      expect(manager.shouldSnapshot(10)).toBe(true);
      expect(manager.shouldSnapshot(15)).toBe(true);
    });

    it("should return false when events below frequency", () => {
      expect(manager.shouldSnapshot(5)).toBe(false);
      expect(manager.shouldSnapshot(9)).toBe(false);
    });
  });

  describe("getSnapshotFrequency", () => {
    it("should return configured frequency", () => {
      expect(manager.getSnapshotFrequency()).toBe(10);
    });

    it("should use default frequency of 100", () => {
      const defaultManager = new SnapshotManager({ store });
      expect(defaultManager.getSnapshotFrequency()).toBe(100);
    });
  });
});

describe("InMemorySnapshotStore", () => {
  let store: InMemorySnapshotStore;

  beforeEach(() => {
    store = new InMemorySnapshotStore();
  });

  describe("listByType", () => {
    it("should list snapshots by type", async () => {
      await store.save({
        aggregateId: "order-1",
        aggregateType: "Order",
        version: 1,
        state: {},
        createdAt: new Date(),
      });
      await store.save({
        aggregateId: "order-2",
        aggregateType: "Order",
        version: 2,
        state: {},
        createdAt: new Date(),
      });
      await store.save({
        aggregateId: "user-1",
        aggregateType: "User",
        version: 1,
        state: {},
        createdAt: new Date(),
      });

      const orders = await store.listByType("Order");
      expect(orders).toHaveLength(2);

      const users = await store.listByType("User");
      expect(users).toHaveLength(1);
    });
  });

  describe("clear", () => {
    it("should clear all snapshots", async () => {
      await store.save({
        aggregateId: "order-1",
        aggregateType: "Order",
        version: 1,
        state: {},
        createdAt: new Date(),
      });

      store.clear();

      const loaded = await store.load("order-1", "Order");
      expect(loaded).toBeNull();
    });
  });
});
