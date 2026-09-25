import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { InstallationKeyWrap, InstallationKeyWrapStore } from "../../factory/encryption.ts";
import type { FactoryCloudKmsClient } from "../../factory/key-management.ts";

/**
 * Test doubles for C06 key wrapping: an in-memory wrap store and a cloud KMS.
 * Node loads this file too (the orchestrator's tests), so it imports only
 * `node:` modules and types.
 */

/** The encryption context as the service authenticates it: its entries in key order. */
function contextBytes(context: Record<string, string>): Buffer {
  return Buffer.from(JSON.stringify(Object.keys(context).sort().map(key => [key, context[key]])));
}

export class MemoryWraps implements InstallationKeyWrapStore {
  readonly rows: InstallationKeyWrap[] = [];
  async load(installationId: string) { return this.rows.filter(row => row.installationId === installationId).sort((a, b) => b.wrapVersion - a.wrapVersion); }
  async save(wrap: InstallationKeyWrap) { if (!this.rows.some(row => row.installationId === wrap.installationId && row.wrapVersion === wrap.wrapVersion)) this.rows.push({ ...wrap, wrappedDataKey: Uint8Array.from(wrap.wrappedDataKey) }); }
}

/** A cloud KMS with the real service's contract: a key never leaves it, and the encryption context is authenticated. */
export class FakeCloudKms implements FactoryCloudKmsClient {
  private readonly keys = new Map<string, Buffer>();
  calls: string[] = [];
  key(id: string) { if (!this.keys.has(id)) this.keys.set(id, randomBytes(32)); return this.keys.get(id)!; }
  async encrypt(input: Parameters<FactoryCloudKmsClient["encrypt"]>[0]) {
    this.calls.push(`encrypt:${input.KeyId}`);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(input.KeyId), iv);
    cipher.setAAD(contextBytes(input.EncryptionContext));
    const body = Buffer.concat([cipher.update(input.Plaintext), cipher.final()]);
    return { CiphertextBlob: new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), body])), KeyId: input.KeyId };
  }
  async decrypt(input: Parameters<FactoryCloudKmsClient["decrypt"]>[0]) {
    this.calls.push(`decrypt:${input.KeyId}`);
    const blob = Buffer.from(input.CiphertextBlob);
    const decipher = createDecipheriv("aes-256-gcm", this.key(input.KeyId), blob.subarray(0, 12));
    decipher.setAAD(contextBytes(input.EncryptionContext));
    decipher.setAuthTag(blob.subarray(12, 28));
    return { Plaintext: new Uint8Array(Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()])), KeyId: input.KeyId };
  }
}
