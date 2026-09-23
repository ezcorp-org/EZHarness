import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeCloudKms, MemoryWraps } from "../__tests__/helpers/factory-kms-doubles";
import { InstallationDataKey, StaticMasterKeyProvider } from "./encryption";
import { loadFactoryTemporalPayloadCodec, parseFactoryKeyWrapFile, readFactoryKeyWrapFile } from "./file-key-wraps";
import { FactoryCloudKmsWrapper } from "./key-management";

const installationId = "wrap-installation";
let directory: string;
beforeAll(async () => { directory = await mkdtemp(join(process.env.HOME!, ".w15-wrap-file-")); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

async function wrapFile(name: string, wraps: MemoryWraps): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, JSON.stringify({ schemaVersion: "factory.key-wraps.v1", installationId, wraps: wraps.rows.map(row => ({ installationId, wrapVersion: row.wrapVersion, masterKeyId: row.masterKeyId, wrappedDataKey: Buffer.from(row.wrappedDataKey).toString("base64") })) }), { mode: 0o600 });
  return path;
}

describe("the private key-wrap file", () => {
  test("holds a KMS wrap: a key ARN with slashes and a ciphertext larger than an operator wrap", async () => {
    const wraps = new MemoryWraps();
    const kms = new FactoryCloudKmsWrapper({ keyId: "arn:aws:kms:eu-west-1:111122223333:key/tenant", client: new FakeCloudKms() });
    const created = await InstallationDataKey.loadOrCreate(installationId, wraps, kms);
    const store = await readFactoryKeyWrapFile(await wrapFile("kms.json", wraps), installationId, "arn:aws:kms:eu-west-1:111122223333:key/tenant");
    expect((await store.load(installationId)).map(row => row.masterKeyId)).toEqual(["arn:aws:kms:eu-west-1:111122223333:key/tenant"]);
    expect((await InstallationDataKey.loadExisting(installationId, store, kms)).wrapVersion).toBe(created.wrapVersion);
    await expect(store.save()).rejects.toMatchObject({ code: "factory_key_unsafe" });
    await expect(store.load("another-installation")).rejects.toMatchObject({ code: "factory_key_invalid" });
    // A wrapping key id is still one token: whitespace or an empty id is refused.
    expect(() => parseFactoryKeyWrapFile({}, installationId, "key with space")).toThrow();
  });

  test("a missing, unreadable, or malformed file is refused by name", async () => {
    await expect(readFactoryKeyWrapFile(join(directory, "absent.json"), installationId, "operator-1")).rejects.toMatchObject({ code: "factory_key_missing" });
    const garbage = join(directory, "garbage.json");
    await writeFile(garbage, "{not json", { mode: 0o600 });
    await expect(readFactoryKeyWrapFile(garbage, installationId, "operator-1")).rejects.toMatchObject({ code: "factory_key_invalid" });
    const open = join(directory, "world-readable.json");
    await writeFile(open, "{}");
    await chmod(open, 0o644);
    await expect(readFactoryKeyWrapFile(open, installationId, "operator-1")).rejects.toMatchObject({ code: "factory_key_unsafe" });
  });

  test("the orchestrator codec opens the data key from the same file with the operator key", async () => {
    const wraps = new MemoryWraps();
    const master = { id: "operator-1", bytes: new Uint8Array(32).fill(4) };
    await InstallationDataKey.loadOrCreate(installationId, wraps, new StaticMasterKeyProvider(master));
    const masterKeyFilePath = join(directory, "master.key");
    await writeFile(masterKeyFilePath, master.bytes, { mode: 0o600 });
    const codec = await loadFactoryTemporalPayloadCodec({ installationId, tenantId: "wrap-tenant", wrappedKeyFilePath: await wrapFile("operator.json", wraps), masterKeyFilePath, masterKeyId: "operator-1", grantableRoots: ["/srv/project"] });
    expect(codec).toBeDefined();
  });
});
