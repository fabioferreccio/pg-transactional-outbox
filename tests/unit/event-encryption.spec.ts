import { describe, it, expect, beforeEach } from "vitest";
import {
  EventEncryption,
  createEncryption,
} from "../../src/core/domain/services/event-encryption";

describe("EventEncryption", () => {
  let encryption: EventEncryption;

  beforeEach(() => {
    encryption = new EventEncryption({ key: "test-encryption-key-32-bytes!!" });
  });

  describe("encrypt/decrypt", () => {
    it("should encrypt and decrypt a payload", () => {
      const payload = { userId: "123", amount: 100 };

      const encrypted = encryption.encrypt(payload);
      const decrypted = encryption.decrypt(encrypted);

      expect(decrypted).toEqual(payload);
    });

    it("should produce different ciphertext for same payload", () => {
      const payload = { test: "data" };

      const encrypted1 = encryption.encrypt(payload);
      const encrypted2 = encryption.encrypt(payload);

      expect(encrypted1.data).not.toBe(encrypted2.data);
      expect(encrypted1.iv).not.toBe(encrypted2.iv);
    });

    it("should include algorithm and version in output", () => {
      const payload = { test: "data" };
      const encrypted = encryption.encrypt(payload);

      expect(encrypted.algorithm).toBe("aes-256-gcm");
      expect(encrypted.version).toBe(1);
    });
  });

  describe("isEncrypted", () => {
    it("should detect encrypted payloads", () => {
      const encrypted = encryption.encrypt({ test: "data" });
      expect(encryption.isEncrypted(encrypted)).toBe(true);
    });

    it("should return false for plain objects", () => {
      expect(encryption.isEncrypted({ test: "data" })).toBe(false);
      expect(encryption.isEncrypted(null)).toBe(false);
      expect(encryption.isEncrypted("string")).toBe(false);
    });
  });

  describe("ensureEncrypted", () => {
    it("should encrypt unencrypted payload", () => {
      const payload = { test: "data" };
      const result = encryption.ensureEncrypted(payload);

      expect(encryption.isEncrypted(result)).toBe(true);
    });

    it("should return already encrypted payload as-is", () => {
      const encrypted = encryption.encrypt({ test: "data" });
      const result = encryption.ensureEncrypted(encrypted);

      expect(result).toBe(encrypted);
    });
  });

  describe("ensureDecrypted", () => {
    it("should decrypt encrypted payload", () => {
      const payload = { test: "data" };
      const encrypted = encryption.encrypt(payload);
      const result = encryption.ensureDecrypted(encrypted);

      expect(result).toEqual(payload);
    });

    it("should return plain payload as-is", () => {
      const payload = { test: "data" };
      const result = encryption.ensureDecrypted(payload);

      expect(result).toBe(payload);
    });
  });

  describe("rotateKey", () => {
    it("should re-encrypt with new key", () => {
      const payload = { secret: "value" };
      const encrypted = encryption.encrypt(payload);

      const newEncryption = new EventEncryption({ key: "new-encryption-key-32-bytes!!!" });
      const rotated = encryption.rotateKey(encrypted, newEncryption);

      // Old key can't decrypt
      expect(() => encryption.decrypt(rotated)).toThrow();

      // New key can decrypt
      const decrypted = newEncryption.decrypt(rotated);
      expect(decrypted).toEqual(payload);
    });
  });

  describe("createEncryption helper", () => {
    it("should create encryption instance", () => {
      const enc = createEncryption("my-secret-key");
      expect(enc).toBeInstanceOf(EventEncryption);
    });
  });
});
