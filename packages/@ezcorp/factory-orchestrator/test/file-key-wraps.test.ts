import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, it } from "node:test";
import { defaultPayloadConverter } from "@temporalio/common";
import { InstallationDataKey, StaticMasterKeyProvider, type InstallationKeyWrap, type InstallationKeyWrapStore } from "../../../../src/factory/encryption.ts";
import { loadFactoryTemporalPayloadCodec, type FactoryKeyWrapFile, type FactoryTemporalPayloadCodecFileConfig } from "../../../../src/factory/file-key-wraps.ts";

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
