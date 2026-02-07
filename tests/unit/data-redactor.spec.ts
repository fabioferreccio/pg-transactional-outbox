import { describe, it, expect, beforeEach } from "vitest";
import { DataRedactor } from "../../src/core/domain/services/data-redactor";
import { OutboxEvent } from "../../src/core/domain/entities/outbox-event";

describe("DataRedactor", () => {
  let redactor: DataRedactor;

  beforeEach(() => {
    redactor = new DataRedactor({ logRedactions: false });
  });

  describe("redactPayload", () => {
    it("should redact sensitive fields", () => {
      const payload = {
        orderId: "123",
        email: "user@example.com",
        phone: "+1234567890",
        items: ["item1"],
      };

      const redacted = redactor.redactPayload(payload);

      expect(redacted.orderId).toBe("123");
      expect(redacted.email).toBe("[REDACTED]");
      expect(redacted.phone).toBe("[REDACTED]");
      expect(redacted.items).toEqual(["item1"]);
    });

    it("should recursively redact nested objects", () => {
      const payload = {
        user: {
          name: "John Doe",
          email: "john@example.com",
        },
      };

      const redacted = redactor.redactPayload(payload);

      expect(redacted.user.name).toBe("[REDACTED]");
      expect(redacted.user.email).toBe("[REDACTED]");
    });

    it("should use custom redaction marker", () => {
      const customRedactor = new DataRedactor({
        redactionMarker: "***",
        logRedactions: false,
      });

      const payload = { email: "test@test.com" };
      const redacted = customRedactor.redactPayload(payload);

      expect(redacted.email).toBe("***");
    });
  });

  describe("isSensitiveField", () => {
    it("should detect sensitive field names (case insensitive)", () => {
      expect(redactor.isSensitiveField("email")).toBe(true);
      expect(redactor.isSensitiveField("EMAIL")).toBe(true);
      expect(redactor.isSensitiveField("userEmail")).toBe(true);
      expect(redactor.isSensitiveField("orderId")).toBe(false);
    });
  });

  describe("addSensitiveField/removeSensitiveField", () => {
    it("should add and remove custom sensitive fields", () => {
      redactor.addSensitiveField("customSecret");
      expect(redactor.isSensitiveField("customSecret")).toBe(true);

      redactor.removeSensitiveField("customSecret");
      expect(redactor.isSensitiveField("customSecret")).toBe(false);
    });
  });

  describe("getSensitiveFields", () => {
    it("should return all sensitive fields", () => {
      const fields = redactor.getSensitiveFields();
      expect(fields).toContain("email");
      expect(fields).toContain("phone");
      expect(fields).toContain("password");
    });
  });

  describe("createRedactedEvent", () => {
    it("should create a redacted copy of an event", () => {
      const event = OutboxEvent.reconstitute({
        id: 1n,
        trackingId: "track-123",
        aggregateId: "user-1",
        aggregateType: "User",
        eventType: "UserCreated",
        payload: { name: "John", email: "john@example.com" },
        status: "COMPLETED",
        retryCount: 0,
        maxRetries: 5,
        createdAt: new Date(),
      });

      const redactedEvent = redactor.createRedactedEvent(event);

      expect((redactedEvent.payload as Record<string, unknown>).email).toBe("[REDACTED]");
      expect((redactedEvent.payload as Record<string, unknown>).name).toBe("[REDACTED]");
    });
  });
});
