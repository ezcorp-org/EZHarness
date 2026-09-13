import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { EncryptedBlobStore, EncryptedRecordCodec, FACTORY_TEMPORAL_ENCRYPTED_PAYLOAD_LIMIT, FactoryEncryptionError, FactoryTemporalPayloadCodec, InstallationDataKey, StaticMasterKeyProvider, factoryTemporalPayloadDataBytesLimit, factoryTemporalPayloadWireBytes, readOperatorMasterKey, type InstallationKeyWrap, type InstallationKeyWrapStore } from "./encryption";

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
    expect(encrypted).not.toEqual(Buffer.from("archive"));
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

  test("requires an SDK serialization context and binds long factory workflow identities", async () => {
    const data = await InstallationDataKey.loadOrCreate("install", new Wraps(), new StaticMasterKeyProvider(master("a")));
    const codec = new FactoryTemporalPayloadCodec(new EncryptedRecordCodec(data, "history"), "tenant");
    const context = { type: "workflow" as const, namespace: "factory-tenant", workflowId: `tenant/${"logical-run-".repeat(32)}` };
    const payload = { metadata: { encoding: Buffer.from("json/plain") }, data: Buffer.from(JSON.stringify({ command: "start_run", workflowId: context.workflowId, body: { source: "client" } })) };
    const encoded = await codec.encode([payload], context);
    expect(encoded[0]!.metadata?.encoding).toEqual(Buffer.from("binary/factory-encrypted"));
    expect(JSON.parse(Buffer.from((await codec.decode(encoded, context))[0]!.data!).toString())).toEqual({ command: "start_run", workflowId: context.workflowId, body: { source: "client" } });
    await expect(codec.decode(encoded, { ...context, workflowId: "tenant/other-run" })).rejects.toMatchObject({ code: "factory_decryption_failed" });
    const activity = { type: "activity" as const, namespace: context.namespace, workflowId: context.workflowId, activityId: "partition-notification", isLocal: false };
    expect(JSON.parse(Buffer.from((await codec.decode(await codec.encode([payload], activity), activity))[0]!.data!).toString())).toEqual({ command: "start_run", workflowId: context.workflowId, body: { source: "client" } });
    await expect(codec.encode([payload])).rejects.toMatchObject({ code: "factory_encryption_binding_invalid" });
    await expect(codec.decode([{ ...encoded[0]!, data: randomBytes(encoded[0]!.data!.byteLength) }], context)).rejects.toMatchObject({ code: "factory_decryption_failed" });
  });

  test("uses the exact compact-envelope C08 payload allowance", async () => {
    const data = await InstallationDataKey.loadOrCreate("install", new Wraps(), new StaticMasterKeyProvider(master("a")));
    const codec = new FactoryTemporalPayloadCodec(new EncryptedRecordCodec(data, "history"), "tenant");
    const metadata = { encoding: Buffer.from("json/plain") }, context = { type: "workflow" as const, namespace: "factory-tenant", workflowId: "tenant/logical-run" };
    const bytes = factoryTemporalPayloadDataBytesLimit(metadata), maximum = { metadata, data: new Uint8Array(bytes) };
    expect(factoryTemporalPayloadWireBytes(maximum)).toBe(FACTORY_TEMPORAL_ENCRYPTED_PAYLOAD_LIMIT);
    expect((await codec.encode([maximum], context))[0]!.data).toHaveLength(FACTORY_TEMPORAL_ENCRYPTED_PAYLOAD_LIMIT);
    await expect(codec.encode([{ metadata, data: new Uint8Array(bytes + 1) }], context)).rejects.toMatchObject({ code: "factory_payload_too_large" });
  });

  test("reads only an owned private raw operator key file through its directory descriptor", async () => {
    const root = await mkdtemp(join(`/run/user/${process.getuid?.()}`, "factory-master-")); await chmod(root, 0o700); const path = join(root, "master");
    await writeFile(path, randomBytes(32), { mode: 0o600 }); expect((await readOperatorMasterKey(path, "operator-1", [])).bytes).toHaveLength(32);
    await chmod(path, 0o644); await expect(readOperatorMasterKey(path, "operator-1", [])).rejects.toMatchObject({ code: "factory_key_unsafe" });
    await chmod(path, 0o600); await expect(readOperatorMasterKey(path, "operator-1", [root])).rejects.toMatchObject({ code: "factory_key_unsafe" });
    const linked = join(root, "linked"); await symlink(path, linked); await expect(readOperatorMasterKey(linked, "operator-1", [])).rejects.toMatchObject({ code: "factory_key_unsafe" });
    const privateDirectory = join(root, "private"); await mkdir(privateDirectory, { mode: 0o700 }); await chmod(privateDirectory, 0o700); await writeFile(join(privateDirectory, "master"), randomBytes(32), { mode: 0o600 });
    const parentLink = join(root, "linked-parent"); await symlink(privateDirectory, parentLink); await expect(readOperatorMasterKey(join(parentLink, "master"), "operator-1", [])).rejects.toMatchObject({ code: "factory_key_unsafe" });
    const fifo = join(root, "fifo"); const fifoProcess = Bun.spawn(["mkfifo", fifo]); expect(await fifoProcess.exited).toBe(0); await expect(readOperatorMasterKey(fifo, "operator-1", [])).rejects.toMatchObject({ code: "factory_key_unsafe" });
    await expect(readOperatorMasterKey(join(root, "missing"), "operator-1", [])).rejects.toMatchObject({ code: "factory_key_missing" });
  });
});
