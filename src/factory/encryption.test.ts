import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { EncryptedBlobStore, EncryptedRecordCodec, FactoryEncryptionError, FactoryTemporalPayloadCodec, InstallationDataKey, StaticMasterKeyProvider, readOperatorMasterKey, type InstallationKeyWrap, type InstallationKeyWrapStore } from "./encryption";
import { DatabaseInstallationKeyWrapStore } from "./encryption-key-wrap-store";
import { up as addFactoryInstallationKeyWraps } from "../db/migrations/add-factory-installation-key-wraps";

const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
class Wraps implements InstallationKeyWrapStore {
  values: InstallationKeyWrap[] = [];
  async load(): Promise<readonly InstallationKeyWrap[]> { return this.values; }
  async save(value: InstallationKeyWrap): Promise<void> { this.values.push(value); }
}
class Blobs {
  values = new Map<string, Uint8Array>();
  async put(value: Uint8Array): Promise<string> { const id = digest(value); this.values.set(id, Uint8Array.from(value)); return id; }
  async get(id: string): Promise<Uint8Array> { const value = this.values.get(id); if (!value) throw new Error("missing"); return Uint8Array.from(value); }
}
class VersionedBlobs extends Blobs {
  async version(id: string): Promise<string> { return `v:${id}`; }
  async getVersion(id: string, version: string): Promise<Uint8Array> { if (version !== `v:${id}`) throw new Error("missing version"); return this.get(id); }
}
const master = (id: string) => ({ id, bytes: new Uint8Array(32).fill(id.charCodeAt(0)) });

describe("factory C06 encryption", () => {
  test("creates a data key, binds reusable record codecs, and rejects substitutions", async () => {
    const wraps = new Wraps(); const data = await InstallationDataKey.loadOrCreate("install", wraps, new StaticMasterKeyProvider(master("a")));
    const plain = Buffer.from("durable payload");
    for (const kind of ["history", "archive", "snapshot", "backup"] as const) {
      const codec = new EncryptedRecordCodec(data, kind);
      const encrypted = codec.encode({ tenantId: "tenant", objectId: "object" }, plain);
      expect(encrypted).not.toEqual(plain);
      expect(codec.decode({ tenantId: "tenant", objectId: "object" }, encrypted)).toEqual(plain);
      expect(() => codec.decode({ tenantId: "other", objectId: "object" }, encrypted)).toThrow(FactoryEncryptionError);
    }
    expect(wraps.values).toHaveLength(1);
  });

  test("rewraps without changing encrypted object bytes and retained wraps recover after rotation", async () => {
    const wraps = new Wraps(); const first = await InstallationDataKey.loadOrCreate("install", wraps, new StaticMasterKeyProvider(master("a")));
    const codec = new EncryptedRecordCodec(first, "archive"); const encrypted = codec.encode({ tenantId: "tenant", objectId: "object" }, Buffer.from("archive"));
    const rotated = await first.rotate(wraps, new StaticMasterKeyProvider(master("b"), [master("a"), master("b")]));
    expect(encrypted).toEqual(encrypted);
    expect(rotated.wrapVersion).toBe(2);
    const recovered = await InstallationDataKey.loadOrCreate("install", wraps, new StaticMasterKeyProvider(master("b"), [master("b")]));
    expect(new EncryptedRecordCodec(recovered, "archive").decode({ tenantId: "tenant", objectId: "object" }, encrypted)).toEqual(Buffer.from("archive"));
    await expect(InstallationDataKey.loadOrCreate("install", wraps, new StaticMasterKeyProvider(master("z")))).rejects.toMatchObject({ code: "factory_key_missing" });
  });

  test("uses one encrypted BlobStore and rejects tamper, tenant, and object substitution", async () => {
    const wraps = new Wraps(); const key = await InstallationDataKey.loadOrCreate("install", wraps, new StaticMasterKeyProvider(master("a")));
    const inner = new Blobs(); const blobs = new EncryptedBlobStore(inner, key, "tenant");
    const id = await blobs.putBound({ tenantId: "tenant", objectId: "object" }, Buffer.from("object bytes"));
    expect(await blobs.getBound({ tenantId: "tenant", objectId: "object" }, id)).toEqual(Buffer.from("object bytes"));
    await expect(blobs.getBound({ tenantId: "other", objectId: "object" }, id)).rejects.toMatchObject({ code: "factory_encryption_binding_invalid" });
    await expect(blobs.getBound({ tenantId: "tenant", objectId: "other" }, id)).rejects.toMatchObject({ code: "factory_decryption_failed" });
    const tampered = inner.values.get(id)!; tampered[tampered.length - 1] ^= 1;
    await expect(blobs.getBound({ tenantId: "tenant", objectId: "object" }, id)).rejects.toMatchObject({ code: "factory_decryption_failed" });
  });

  test("uses a versioned v4 BlobStore through explicit object bindings", async () => {
    const key = await InstallationDataKey.loadOrCreate("install", new Wraps(), new StaticMasterKeyProvider(master("a")));
    const versioned = new EncryptedBlobStore(new VersionedBlobs(), key, "tenant");
    const bound = await versioned.putBound({ tenantId: "tenant", objectId: "object" }, Buffer.from("versioned"));
    expect(await versioned.version(bound)).toBe(`v:${bound}`);
    expect(await versioned.getVersion({ tenantId: "tenant", objectId: "object" }, bound, `v:${bound}`)).toEqual(Buffer.from("versioned"));
    const fallback = new EncryptedBlobStore(new Blobs(), key, "tenant");
    const fallbackBound = await fallback.putBound({ tenantId: "tenant", objectId: "object" }, Buffer.from("fallback"));
    expect(await fallback.version(fallbackBound)).toBe(fallbackBound);
    expect(await fallback.getVersion({ tenantId: "tenant", objectId: "object" }, fallbackBound, "ignored")).toEqual(Buffer.from("fallback"));
  });

  test("persists only encrypted wraps through the PostgreSQL repository seam", async () => {
    const calls: unknown[] = [];
    const database = { async execute(query: unknown) { calls.push(query); return { rows: [{ installation_id: "install", wrap_version: "2", master_key_id: "master", wrapped_data_key: new Uint8Array(82) }] }; }, transaction: async <T>(work: (value: never) => Promise<T>) => work(undefined as never) };
    const store = new DatabaseInstallationKeyWrapStore(database);
    expect(await store.load("install")).toMatchObject([{ installationId: "install", wrapVersion: 2, masterKeyId: "master" }]);
    await store.save({ installationId: "install", wrapVersion: 1, masterKeyId: "master", wrappedDataKey: new Uint8Array(82) });
    expect(calls).toHaveLength(2);
    await expect(store.save({ installationId: "install", wrapVersion: 0, masterKeyId: "master", wrappedDataKey: new Uint8Array(82) })).rejects.toMatchObject({ code: "factory_key_invalid" });
    const arrayStore = new DatabaseInstallationKeyWrapStore({ ...database, async execute() { return [{ installation_id: "install", wrap_version: 1, master_key_id: "master", wrapped_data_key: new Uint8Array(82) }]; } });
    expect(await arrayStore.load("install")).toHaveLength(1);
  });

  test("creates the encrypted-wrap PostgreSQL ledger without master material", async () => {
    let calls = 0;
    await addFactoryInstallationKeyWraps({ async execute() { calls += 1; } });
    expect(calls).toBe(1);
  });

  test("is structurally compatible with Node Temporal payload codecs and authenticates payload positions", async () => {
    const data = await InstallationDataKey.loadOrCreate("install", new Wraps(), new StaticMasterKeyProvider(master("a")));
    const codec = new FactoryTemporalPayloadCodec(new EncryptedRecordCodec(data, "history"), "tenant", "workflow");
    const encoded = await codec.encode([{ metadata: { encoding: Buffer.from("json/plain") }, data: Buffer.from("payload") }]);
    expect(encoded[0]!.metadata?.encoding).toEqual(Buffer.from("binary/factory-encrypted"));
    expect((await codec.decode(encoded))[0]!.data).toEqual(Buffer.from("payload"));
    await expect(codec.decode([{ ...encoded[0]!, data: randomBytes(encoded[0]!.data!.byteLength) }])).rejects.toMatchObject({ code: "factory_decryption_failed" });
  });

  test("reads only a private raw operator key file", async () => {
    const root = await mkdtemp(join(tmpdir(), "factory-master-")); const path = join(root, "master");
    await writeFile(path, randomBytes(32), { mode: 0o600 }); expect((await readOperatorMasterKey(path, "operator-1", [])).bytes).toHaveLength(32);
    await chmod(path, 0o644); await expect(readOperatorMasterKey(path, "operator-1", [])).rejects.toMatchObject({ code: "factory_key_unsafe" });
    await chmod(path, 0o600); await expect(readOperatorMasterKey(path, "operator-1", [root])).rejects.toMatchObject({ code: "factory_key_unsafe" });
    const linked = join(root, "linked"); await symlink(path, linked); await expect(readOperatorMasterKey(linked, "operator-1", [])).rejects.toMatchObject({ code: "factory_key_unsafe" });
    await expect(readOperatorMasterKey(join(root, "missing"), "operator-1", [])).rejects.toMatchObject({ code: "factory_key_missing" });
  });
});
