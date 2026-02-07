/**
 * Event Encryption (v0.9)
 *
 * Optional payload encryption at rest using Node.js crypto.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import type { CipherGCM, DecipherGCM } from "crypto";

export interface EncryptionConfig {
  /** Encryption key (32 bytes for AES-256) */
  key: string;
  /** Algorithm to use */
  algorithm?: string;
  /** Include metadata in encryption */
  encryptMetadata?: boolean;
}

export interface EncryptedPayload {
  /** Encrypted data (base64) */
  data: string;
  /** Initialization vector (base64) */
  iv: string;
  /** Authentication tag (base64) */
  tag: string;
  /** Algorithm used */
  algorithm: string;
  /** Version for future compatibility */
  version: number;
}

export class EventEncryption {
  private readonly key: Buffer;
  private readonly algorithm: "aes-256-gcm";
  private readonly encryptMetadata: boolean;

  constructor(config: EncryptionConfig) {
    // Derive a 32-byte key from the provided key using scrypt
    this.key = scryptSync(config.key, "pg-outbox-salt", 32);
    this.algorithm = "aes-256-gcm";
    this.encryptMetadata = config.encryptMetadata ?? false;
  }

  /**
   * Encrypt a payload
   */
  encrypt(payload: object): EncryptedPayload {
    const iv = randomBytes(16);
    const cipher = createCipheriv(this.algorithm, this.key, iv) as CipherGCM;

    const jsonPayload = JSON.stringify(payload);
    let encrypted = cipher.update(jsonPayload, "utf8", "base64");
    encrypted += cipher.final("base64");

    // Get auth tag for GCM mode
    const tag = cipher.getAuthTag();

    return {
      data: encrypted,
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      algorithm: this.algorithm,
      version: 1,
    };
  }

  /**
   * Decrypt a payload
   */
  decrypt<T = object>(encrypted: EncryptedPayload): T {
    const iv = Buffer.from(encrypted.iv, "base64");
    const tag = Buffer.from(encrypted.tag, "base64");

    const decipher = createDecipheriv(this.algorithm, this.key, iv) as DecipherGCM;
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(encrypted.data, "base64", "utf8");
    decrypted += decipher.final("utf8");

    return JSON.parse(decrypted) as T;
  }

  /**
   * Check if a payload is encrypted
   */
  isEncrypted(payload: unknown): payload is EncryptedPayload {
    return (
      typeof payload === "object" &&
      payload !== null &&
      "data" in payload &&
      "iv" in payload &&
      "tag" in payload &&
      "algorithm" in payload &&
      "version" in payload
    );
  }

  /**
   * Encrypt payload if not already encrypted
   */
  ensureEncrypted(payload: object): EncryptedPayload {
    if (this.isEncrypted(payload)) {
      return payload;
    }
    return this.encrypt(payload);
  }

  /**
   * Decrypt payload if encrypted, otherwise return as-is
   */
  ensureDecrypted<T = object>(payload: object | EncryptedPayload): T {
    if (this.isEncrypted(payload)) {
      return this.decrypt<T>(payload);
    }
    return payload as T;
  }

  /**
   * Rotate encryption key - re-encrypt with new key
   */
  rotateKey(
    encrypted: EncryptedPayload,
    newEncryption: EventEncryption,
  ): EncryptedPayload {
    // Decrypt with current key
    const decrypted = this.decrypt(encrypted);
    // Re-encrypt with new key
    return newEncryption.encrypt(decrypted);
  }

  /**
   * Check if encryption should be applied to metadata
   */
  shouldEncryptMetadata(): boolean {
    return this.encryptMetadata;
  }
}

/**
 * Factory function to create encryption instance
 */
export function createEncryption(key: string): EventEncryption {
  return new EventEncryption({ key });
}
