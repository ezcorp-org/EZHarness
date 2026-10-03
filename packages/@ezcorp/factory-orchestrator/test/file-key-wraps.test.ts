import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, it } from "node:test";
import { defaultPayloadConverter } from "@temporalio/common";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { InstallationDataKey, StaticMasterKeyProvider, type FactoryDataKeyWrapper, type InstallationKeyWrap, type InstallationKeyWrapStore } from "../../../../src/factory/encryption.ts";
import { loadFactoryTemporalPayloadCodec, parseFactoryKeyWrapFile, readFactoryKeyWrapFile, type FactoryKeyWrapFile, type FactoryTemporalPayloadCodecFileConfig } from "../../../../src/factory/file-key-wraps.ts";

class Wraps implements InstallationKeyWrapStore {
  readonly values: InstallationKeyWrap[] = [];
  async load(): Promise<readonly InstallationKeyWrap[]> { return this.values; }
  async save(value: InstallationKeyWrap): Promise<void> { this.values.push(value); }
}

const roots: string[] = [];
after(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(): Promise<{ root: string; config: FactoryTemporalPayloadCodecFileConfig; writeWraps(file: FactoryKeyWrapFile | string): Promise<void> }> {
  const root = await mkdtemp(`/run/user/${process.getuid!()}/factory-node-key-wraps-`); roots.push(root); await chmod(root, 0o700);
  const master = new Uint8Array(32).fill(7), wraps = new Wraps();
  await InstallationDataKey.loadOrCreate("installation-a", wraps, new StaticMasterKeyProvider({ id: "operator-a", bytes: master }));
  const masterPath = join(root, "master.key"), wrappedKeyFilePath = join(root, "wraps.json");
  await writeFile(masterPath, master, { mode: 0o600 });
  const writeWraps = async (file: FactoryKeyWrapFile | string): Promise<void> => { await writeFile(wrappedKeyFilePath, typeof file === "string" ? file : JSON.stringify(file), { mode: 0o600 }); };
  await writeWraps({ schemaVersion: "factory.key-wraps.v1", installationId: "installation-a", wraps: wraps.values.map(wrap => ({ ...wrap, wrappedDataKey: Buffer.from(wrap.wrappedDataKey).toString("base64") })) });
  return { root, config: { installationId: "installation-a", tenantId: "tenant-a", wrappedKeyFilePath, masterKeyFilePath: masterPath, masterKeyId: "operator-a", grantableRoots: [] }, writeWraps };
}

it("loads a private pre-wrapped key in Node 24 and binds real Temporal workflow payloads", async () => {
  const { config } = await fixture();
  const codec = await loadFactoryTemporalPayloadCodec(config);
  const first = { type: "workflow" as const, namespace: "factory-tenant-a", workflowId: "tenant-a/run-a" };
  const second = { ...first, workflowId: "tenant-a/run-b" };
  const payload = defaultPayloadConverter.toPayload({ command: "resume", value: 7 }, first);
  const encoded = await codec.encode([payload], first);
  assert.notDeepEqual(encoded[0]!.data, payload.data);
  assert.deepEqual(defaultPayloadConverter.fromPayload((await codec.decode(encoded, first))[0]!, first), { command: "resume", value: 7 });
  await assert.rejects(() => codec.decode(encoded, second), { code: "factory_decryption_failed" });
});

it("fails Node readiness for missing, empty, foreign, malformed, private, and wrong-master wrap files", async () => {
  const { root, config, writeWraps } = await fixture();
  await assert.rejects(() => loadFactoryTemporalPayloadCodec({ ...config, wrappedKeyFilePath: join(root, "missing.json") }), { code: "factory_key_missing" });
  await writeWraps({ schemaVersion: "factory.key-wraps.v1", installationId: "installation-a", wraps: [] });
  await assert.rejects(() => loadFactoryTemporalPayloadCodec(config), { code: "factory_key_invalid" });
  await writeWraps({ schemaVersion: "factory.key-wraps.v1", installationId: "other-installation", wraps: [] });
  await assert.rejects(() => loadFactoryTemporalPayloadCodec(config), { code: "factory_key_invalid" });
  await writeWraps("{");
  await assert.rejects(() => loadFactoryTemporalPayloadCodec(config), { code: "factory_key_invalid" });
  await writeWraps({ schemaVersion: "factory.key-wraps.v1", installationId: "installation-a", wraps: [{ installationId: "installation-a", wrapVersion: 1, masterKeyId: "other-master", wrappedDataKey: Buffer.alloc(80).toString("base64") }] });
  await assert.rejects(() => loadFactoryTemporalPayloadCodec(config), { code: "factory_key_invalid" });
  await writeWraps({ schemaVersion: "factory.key-wraps.v1", installationId: "installation-a", wraps: [{ installationId: "installation-a", wrapVersion: 1, masterKeyId: "operator-a", wrappedDataKey: Buffer.alloc(80).toString("base64") }] });
  await assert.rejects(() => loadFactoryTemporalPayloadCodec(config), { code: "factory_key_missing" });
  await chmod(config.wrappedKeyFilePath, 0o644);
  await assert.rejects(() => loadFactoryTemporalPayloadCodec(config), { code: "factory_key_unsafe" });
  await chmod(config.wrappedKeyFilePath, 0o600);
  await assert.rejects(() => loadFactoryTemporalPayloadCodec({ ...config, grantableRoots: [root] }), { code: "factory_key_unsafe" });
});

/** A KMS-shaped wrapper: its key id is an ARN with slashes, and its wrap is larger than an operator wrap. */
function kmsShapedWrapper(keyId: string, padding = 300): FactoryDataKeyWrapper {
  const secret = randomBytes(32);
  return {
    async currentKeyId() { return keyId; },
    async wrap(dataKey, id, binding) {
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", secret, iv);
      cipher.setAAD(Buffer.from(`${binding.installationId}:${binding.wrapVersion}:${id}`));
      const body = Buffer.concat([cipher.update(dataKey), cipher.final()]);
      return new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), body, Buffer.alloc(padding)]));
    },
    async unwrap(wrapped, id, binding) {
      if (id !== keyId) return undefined;
      const blob = Buffer.from(wrapped), decipher = createDecipheriv("aes-256-gcm", secret, blob.subarray(0, 12));
      decipher.setAAD(Buffer.from(`${binding.installationId}:${binding.wrapVersion}:${id}`));
      decipher.setAuthTag(blob.subarray(12, 28));
      return new Uint8Array(Buffer.concat([decipher.update(blob.subarray(28, 60)), decipher.final()]));
    },
  };
}

it("holds a KMS wrap: a key ARN with slashes and a wrap larger than an operator wrap", async () => {
  const { root } = await fixture();
  const keyId = "arn:aws:kms:eu-west-1:111122223333:key/tenant";
  const wrapper = kmsShapedWrapper(keyId), wraps = new Wraps();
  const created = await InstallationDataKey.loadOrCreate("installation-a", wraps, wrapper);
  const path = join(root, "kms-wraps.json");
  const file = (values: readonly InstallationKeyWrap[]): string => JSON.stringify({ schemaVersion: "factory.key-wraps.v1", installationId: "installation-a", wraps: values.map(wrap => ({ ...wrap, wrappedDataKey: Buffer.from(wrap.wrappedDataKey).toString("base64") })) });
  await writeFile(path, file(wraps.values), { mode: 0o600 });
  const store = await readFactoryKeyWrapFile(path, "installation-a", keyId);
  assert.equal((await InstallationDataKey.loadExisting("installation-a", store, wrapper)).wrapVersion, created.wrapVersion);
  await assert.rejects(() => store.save(wraps.values[0]!), { code: "factory_key_unsafe" });
  await assert.rejects(() => store.load("installation-b"), { code: "factory_key_invalid" });
  // A wrapping key id is still one token, and a wrap has a ceiling.
  assert.throws(() => parseFactoryKeyWrapFile({}, "installation-a", "key with space"), { code: "factory_key_invalid" });
  await writeFile(path, file([{ ...wraps.values[0]!, wrappedDataKey: new Uint8Array(1_025) }]), { mode: 0o600 });
  await assert.rejects(() => readFactoryKeyWrapFile(path, "installation-a", keyId), { code: "factory_key_invalid" });
});
