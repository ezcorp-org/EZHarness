import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { EncryptedBlobStore, EncryptedRecordCodec, InstallationDataKey, StaticMasterKeyProvider, type InstallationKeyWrap, type InstallationKeyWrapStore } from "../../src/factory/encryption";
import { DatabaseInstallationKeyWrapStore } from "../../src/factory/encryption-key-wrap-store";
import { createFactoryOrdinaryStorage } from "./helpers/factory-storage";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

class Wraps implements InstallationKeyWrapStore {
  rows: InstallationKeyWrap[] = [];
  async load(): Promise<readonly InstallationKeyWrap[]> { return this.rows; }
  async save(wrap: InstallationKeyWrap): Promise<void> { this.rows.push(wrap); }
}

function provider(id: string) { return new StaticMasterKeyProvider({ id, bytes: new Uint8Array(32).fill(id.charCodeAt(0)) }); }

describe("C06 real local ordinary S3 encryption", () => {
  test("real PostgreSQL concurrent bootstrap and different-master rewraps persist every reported version", async () => {
    const database = await setupFactoryPostgres();
    try {
      const store = new DatabaseInstallationKeyWrapStore(database.db);
      const schemaRows = await database.db.execute(sql`SELECT column_name FROM information_schema.columns WHERE table_name='factory_installation_key_wraps' ORDER BY column_name`);
      expect(schemaRows.map(row => row.column_name)).toEqual(["created_at", "installation_id", "master_key_id", "wrap_version", "wrapped_data_key"]);
      const [first, second] = await Promise.all([InstallationDataKey.loadOrCreate("installation", store, provider("old")), InstallationDataKey.loadOrCreate("installation", store, provider("old"))]);
      const bytes = Buffer.from("converged key"); const encrypted = new EncryptedRecordCodec(first, "archive").encode({ tenantId: "tenant", objectId: "object" }, bytes);
      expect(new EncryptedRecordCodec(second, "archive").decode({ tenantId: "tenant", objectId: "object" }, encrypted)).toEqual(bytes);
      const [firstRotation, secondRotation] = await Promise.all([first.rotate(store, provider("first-master")), second.rotate(store, provider("second-master"))]);
      const rows = await database.db.execute(sql`SELECT wrap_version, master_key_id FROM factory_installation_key_wraps WHERE installation_id='installation' ORDER BY wrap_version`);
      expect(rows).toHaveLength(3);
      expect(rows.map(row => row.wrap_version)).toEqual([1, 2, 3]);
      expect(new Set(rows.slice(1).map(row => row.master_key_id))).toEqual(new Set(["first-master", "second-master"]));
      expect([firstRotation.wrapVersion, secondRotation.wrapVersion].sort()).toEqual([2, 3]);
      const reloaded = await InstallationDataKey.loadOrCreate("installation", store, provider("second-master"));
      expect(new EncryptedRecordCodec(reloaded, "archive").decode({ tenantId: "tenant", objectId: "object" }, encrypted)).toEqual(bytes);
    } finally { await database.close(); }
  });

  test("round-trips authenticated tenant/object bytes and rotation keeps the immutable S3 object", async () => {
    const storage = await createFactoryOrdinaryStorage(`ordinary/factory-encryption/${randomUUID()}`);
    try {
      const wraps = new Wraps(); const first = await InstallationDataKey.loadOrCreate("installation", wraps, provider("old"));
      const blobs = new EncryptedBlobStore(storage.blobs, first, "tenant");
      const bytes = Buffer.from("real local S3 encrypted artifact");
      const digest = await blobs.putBound({ tenantId: "tenant", objectId: "artifact" }, bytes);
      const version = await blobs.version(digest);
      expect(await blobs.getVersion({ tenantId: "tenant", objectId: "artifact" }, digest, version)).toEqual(bytes);
      await expect(blobs.getBound({ tenantId: "other", objectId: "artifact" }, digest)).rejects.toMatchObject({ code: "factory_encryption_binding_invalid" });
      await expect(blobs.getBound({ tenantId: "tenant", objectId: "other" }, digest)).rejects.toMatchObject({ code: "factory_decryption_failed" });
      const rotated = await first.rotate(wraps, provider("new"));
      expect(await blobs.version(digest)).toBe(version);
      await expect(InstallationDataKey.loadOrCreate("installation", wraps, provider("lost"))).rejects.toMatchObject({ code: "factory_key_missing" });
      expect(new EncryptedRecordCodec(rotated, "backup").decode({ tenantId: "tenant", objectId: "backup" }, new EncryptedRecordCodec(rotated, "backup").encode({ tenantId: "tenant", objectId: "backup" }, bytes))).toEqual(bytes);
    } finally { storage.close(); }
  });
});
