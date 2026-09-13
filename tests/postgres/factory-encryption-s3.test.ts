import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { EncryptedBlobStore, EncryptedRecordCodec, InstallationDataKey, StaticMasterKeyProvider, type InstallationKeyWrap, type InstallationKeyWrapStore } from "../../src/factory/encryption";
import { createFactoryOrdinaryStorage } from "./helpers/factory-storage";

class Wraps implements InstallationKeyWrapStore {
  rows: InstallationKeyWrap[] = [];
  async load(): Promise<readonly InstallationKeyWrap[]> { return this.rows; }
  async save(wrap: InstallationKeyWrap): Promise<void> { this.rows.push(wrap); }
}

function provider(id: string) { return new StaticMasterKeyProvider({ id, bytes: new Uint8Array(32).fill(id.charCodeAt(0)) }); }

describe("C06 real local ordinary S3 encryption", () => {
  test("round-trips authenticated tenant/object bytes and rotation keeps the immutable S3 object", async () => {
    const storage = await createFactoryOrdinaryStorage(`ordinary/factory-encryption/${randomUUID()}`);
    try {
      const wraps = new Wraps(); const first = await InstallationDataKey.loadOrCreate("installation", wraps, provider("old"));
      const blobs = new EncryptedBlobStore(storage.blobs, first, "tenant");
      const bytes = Buffer.from("real local S3 encrypted artifact");
      const digest = await blobs.putBound({ tenantId: "tenant", objectId: "artifact" }, bytes);
      const version = await blobs.version(digest);
      expect(await blobs.getVersion({ tenantId: "tenant", objectId: "artifact" }, digest, version)).toEqual(bytes);
      await expect(blobs.getBound({ tenantId: "other", objectId: "artifact" }, digest)).rejects.toMatchObject({ code: "factory_decryption_failed" });
      await expect(blobs.getBound({ tenantId: "tenant", objectId: "other" }, digest)).rejects.toMatchObject({ code: "factory_decryption_failed" });
      const rotated = await first.rotate(wraps, provider("new"));
      expect(await blobs.version(digest)).toBe(version);
      await expect(InstallationDataKey.loadOrCreate("installation", wraps, provider("lost"))).rejects.toMatchObject({ code: "factory_key_missing" });
      expect(new EncryptedRecordCodec(rotated, "backup").decode({ tenantId: "tenant", objectId: "backup" }, new EncryptedRecordCodec(rotated, "backup").encode({ tenantId: "tenant", objectId: "backup" }, bytes))).toEqual(bytes);
    } finally { storage.close(); }
  });
});
