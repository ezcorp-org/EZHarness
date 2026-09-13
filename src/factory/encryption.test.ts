import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { EncryptedBlobStore, EncryptedRecordCodec, FactoryEncryptionError, FactoryTemporalPayloadCodec, InstallationDataKey, StaticMasterKeyProvider, readOperatorMasterKey, type InstallationKeyWrap, type InstallationKeyWrapStore } from "./encryption";

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
    const recovered = await InstallationDataKey.loadOrCreate("install", wraps, new StaticMasterKeyProvider(master("a"), [master("a")]));
    expect(new EncryptedRecordCodec(recovered, "archive").decode({ tenantId: "tenant", objectId: "object" }, encrypted)).toEqual(Buffer.from("archive"));
    await expect(InstallationDataKey.loadOrCreate("install", wraps, new StaticMasterKeyProvider(master("z")))).rejects.toMatchObject({ code: "factory_key_missing" });
  });

  test("uses one encrypted BlobStore and rejects tamper, tenant, and object substitution", async () => {
    const wraps = new Wraps(); const key = await InstallationDataKey.loadOrCreate("install", wraps, new StaticMasterKeyProvider(master("a")));
    const inner = new Blobs(); const blobs = new EncryptedBlobStore(inner, key, "tenant");
    const id = await blobs.putBound({ tenantId: "tenant", objectId: "object" }, Buffer.from("object bytes"));
    expect(await blobs.getBound({ tenantId: "tenant", objectId: "object" }, id)).toEqual(Buffer.from("object bytes"));
    await expect(blobs.getBound({ tenantId: "other", objectId: "object" }, id)).rejects.toMatchObject({ code: "factory_decryption_failed" });
    await expect(blobs.getBound({ tenantId: "tenant", objectId: "other" }, id)).rejects.toMatchObject({ code: "factory_decryption_failed" });
    const tampered = inner.values.get(id)!; tampered[tampered.length - 1] ^= 1;
    await expect(blobs.getBound({ tenantId: "tenant", objectId: "object" }, id)).rejects.toMatchObject({ code: "factory_decryption_failed" });
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
    await writeFile(path, randomBytes(32), { mode: 0o600 }); expect((await readOperatorMasterKey(path, "operator-1")).bytes).toHaveLength(32);
    await chmod(path, 0o644); await expect(readOperatorMasterKey(path, "operator-1")).rejects.toMatchObject({ code: "factory_key_unsafe" });
    await expect(readOperatorMasterKey(join(root, "missing"), "operator-1")).rejects.toMatchObject({ code: "factory_key_missing" });
  });
});
