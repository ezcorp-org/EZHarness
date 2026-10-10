import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startFactoryKeyServiceDouble, type FactoryKeyServiceDouble } from "../__tests__/helpers/factory-key-service-double";
import { FakeCloudKms, MemoryWraps } from "../__tests__/helpers/factory-kms-doubles";
import { InstallationDataKey, type FactoryDataKeyWrapper } from "./encryption";
import { loadFactoryDataKeyFromFiles, type FactoryDataKeyFileReferences } from "./file-key-wraps";
import { composeFactoryDataKeyWrapper, factoryAwsKmsClient, wellFormedFactoryKeyManagement, type FactoryKeyManagement } from "./key-composition";
import { makeFactoryTempPrivateRoot } from "../__tests__/helpers/factory-private-root";

/**
 * The one key-service unit, from the product process: each kind the startup
 * document can select opens the data key from the private wrap file, against
 * the same local key-service double the orchestrator's Node tests use.
 */

const installationId = "key-installation";
const aad = { tenantId: "tenant-key", objectId: "object-1", payloadKind: "archive" as const };
const token = "transit-token-for-tests";
let directory: string;
let service: FactoryKeyServiceDouble;

beforeAll(async () => {
  directory = await makeFactoryTempPrivateRoot("w15b-keys-");
  service = await startFactoryKeyServiceDouble({ transitToken: token });
});
afterAll(async () => { await service.stop(); await rm(directory, { recursive: true, force: true }); });

async function secret(name: string, content: string | Uint8Array): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, content, { mode: 0o600 });
  return path;
}

function references(keyManagement?: FactoryKeyManagement, wrappedKeyFilePath = join(directory, "wraps.json")): FactoryDataKeyFileReferences {
  return { installationId, masterKeyFilePath: join(directory, "master.key"), masterKeyId: "operator-1", wrappedKeyFilePath, grantableRoots: ["/srv/project"], ...(keyManagement === undefined ? {} : { keyManagement }) };
}

/** Creates the data key under `wrapper` and writes its wraps in the provisioner's private file format. */
async function provision(wrapper: FactoryDataKeyWrapper, file: string): Promise<InstallationDataKey> {
  const wraps = new MemoryWraps();
  const key = await InstallationDataKey.loadOrCreate(installationId, wraps, wrapper);
  await secret(file, JSON.stringify({
    schemaVersion: "factory.key-wraps.v1", installationId,
    wraps: wraps.rows.map(row => ({ installationId, wrapVersion: row.wrapVersion, masterKeyId: row.masterKeyId, wrappedDataKey: Buffer.from(row.wrappedDataKey).toString("base64") })),
  }));
  return key;
}

function sameKey(left: InstallationDataKey, right: InstallationDataKey): void {
  expect(new TextDecoder().decode(right.decrypt(left.encrypt(new TextEncoder().encode("same key"), aad), aad))).toBe("same key");
}

describe("the selected key service opens the data key", () => {
  test("absent or explicit, the operator master key file", async () => {
    await secret("master.key", new Uint8Array(32).fill(7));
    const wrapper = await composeFactoryDataKeyWrapper(references());
    expect(await wrapper.currentKeyId()).toBe("operator-1");
    const created = await provision(wrapper, "wraps.json");
    sameKey(created, await loadFactoryDataKeyFromFiles(references()));
    sameKey(created, await loadFactoryDataKeyFromFiles(references({ kind: "operator-master-key" })));
  });

  test("a hosted cloud KMS, through the AWS SDK client against the double", async () => {
    const selected: FactoryKeyManagement = { kind: "cloud-kms", keyId: "arn:aws:kms:eu-west-1:111122223333:key/tenant", region: "eu-west-1", credentialsPath: await secret("kms.json", JSON.stringify({ accessKeyId: "AKIDTEST", secretAccessKey: "test-secret" })), endpoint: service.endpoint };
    const created = await provision(await composeFactoryDataKeyWrapper(references(), selected), "kms-wraps.json");
    const before = service.calls.length;
    sameKey(created, await loadFactoryDataKeyFromFiles(references(selected, join(directory, "kms-wraps.json"))));
    expect(service.calls.slice(before)).toEqual([`kms:decrypt:${(selected as { keyId: string }).keyId}`]);
  });

  test("a self-hosted transit engine, with its token read by reference", async () => {
    const selected: FactoryKeyManagement = { kind: "transit", endpoint: service.endpoint, keyName: "factory-data-key", mount: "transit-2", tokenPath: await secret("transit.token", token) };
    const created = await provision(await composeFactoryDataKeyWrapper(references(), selected), "transit-wraps.json");
    const before = service.calls.length;
    sameKey(created, await loadFactoryDataKeyFromFiles(references(selected, join(directory, "transit-wraps.json"))));
    expect(service.calls.slice(before)).toEqual(["transit:decrypt:transit-2/factory-data-key"]);
  });

  test("a mismatched service fails closed with a typed error", async () => {
    // Wraps made under the cloud KMS key, opened with transit: the wrap file names another key.
    const transit: FactoryKeyManagement = { kind: "transit", endpoint: service.endpoint, keyName: "factory-data-key", tokenPath: join(directory, "transit.token") };
    await expect(loadFactoryDataKeyFromFiles(references(transit, join(directory, "kms-wraps.json")))).rejects.toMatchObject({ name: "FactoryEncryptionError", code: "factory_key_invalid" });
    // The right key id, but a KMS key the service never wrapped with: the service refuses, typed, with its cause.
    const wrongKey: FactoryKeyManagement = { kind: "cloud-kms", keyId: "arn:aws:kms:eu-west-1:111122223333:key/tenant", region: "eu-west-1", credentialsPath: join(directory, "kms.json"), endpoint: service.endpoint };
    const other = await startFactoryKeyServiceDouble({ transitToken: token });
    try {
      const refused = await loadFactoryDataKeyFromFiles(references({ ...wrongKey, endpoint: other.endpoint }, join(directory, "kms-wraps.json"))).then(() => null, (error: unknown) => error as { name?: string; code?: string; cause?: unknown });
      expect(refused).toMatchObject({ name: "FactoryEncryptionError", code: "factory_key_missing" });
      expect(refused?.cause).toBeInstanceOf(AggregateError);
    } finally { await other.stop(); }
    // A wrong transit token is refused by the service, typed.
    const badToken = { ...transit, tokenPath: await secret("bad.token", "not-the-token") } as FactoryKeyManagement;
    await expect(loadFactoryDataKeyFromFiles(references(badToken, join(directory, "transit-wraps.json")))).rejects.toMatchObject({ name: "FactoryEncryptionError" });
    // A malformed selection never reaches a service.
    await expect(loadFactoryDataKeyFromFiles(references({ kind: "hsm" } as never))).rejects.toMatchObject({ code: "factory_key_invalid" });
  });

  test("an injected client receives the region, endpoint, and credentials; a malformed credential file is refused", async () => {
    const seen: unknown[] = [];
    const credentialsPath = await secret("kms-2.json", JSON.stringify({ accessKeyId: "AKIDTEST", secretAccessKey: "test-secret" }));
    const kms = new FakeCloudKms();
    await composeFactoryDataKeyWrapper(references(), { kind: "cloud-kms", keyId: "k", region: "us-east-1", credentialsPath }, { cloudKmsClient: options => { seen.push(options); return kms; } });
    expect(seen).toEqual([{ region: "us-east-1", credentials: { accessKeyId: "AKIDTEST", secretAccessKey: "test-secret" } }]);
    expect(factoryAwsKmsClient({ region: "us-east-1", credentials: { accessKeyId: "a", secretAccessKey: "b" } })).toMatchObject({ encrypt: expect.any(Function), decrypt: expect.any(Function) });
    for (const [name, content] of [["kms-bad.json", "{not json"], ["kms-empty.json", JSON.stringify({ accessKeyId: "a" })]] as const) {
      await expect(composeFactoryDataKeyWrapper(references(), { kind: "cloud-kms", keyId: "k", region: "us-east-1", credentialsPath: await secret(name, content) })).rejects.toMatchObject({ code: "factory_key_invalid" });
    }
    await expect(composeFactoryDataKeyWrapper(references(), { kind: "cloud-kms", keyId: "k", region: "us-east-1", credentialsPath: join(directory, "absent.json") })).rejects.toMatchObject({ code: "factory_key_invalid" });
  });

  test("a transit CA is read by reference, and an unreadable one is refused before any call", async () => {
    const tls: unknown[] = [];
    const fetcher = (async (input: URL, init: RequestInit & { tls?: unknown }) => { tls.push(init.tls); return fetch(input, init); }) as unknown as typeof fetch;
    const selected: FactoryKeyManagement = { kind: "transit", endpoint: service.endpoint, keyName: "factory-data-key", tokenPath: join(directory, "transit.token"), caPath: await secret("vault-ca.pem", "-----BEGIN CERTIFICATE-----") };
    await provision(await composeFactoryDataKeyWrapper(references(), selected, { fetch: fetcher }), "transit-ca-wraps.json");
    expect(tls.every(value => (value as { ca?: string }).ca === "-----BEGIN CERTIFICATE-----")).toBe(true);
    expect(tls.length).toBeGreaterThan(0);
    await expect(composeFactoryDataKeyWrapper(references(), { ...selected, caPath: join(directory, "absent-ca.pem") } as FactoryKeyManagement)).rejects.toMatchObject({ code: "factory_key_unsafe" });
  });

  test("the validator accepts each kind with only its own fields", () => {
    const cloud = { kind: "cloud-kms", keyId: "arn:aws:kms:eu-west-1:1:key/k", region: "eu-west-1", credentialsPath: "/run/secrets/kms.json" };
    const transit = { kind: "transit", endpoint: "https://vault.internal:8200", keyName: "k", tokenPath: "/run/secrets/t" };
    for (const accepted of [{ kind: "operator-master-key" }, cloud, { ...cloud, endpoint: "https://kms.internal" }, transit, { ...transit, mount: "m", caPath: "/ca.pem" }]) expect(wellFormedFactoryKeyManagement(accepted)).toBe(true);
    for (const refused of ["cloud-kms", { kind: "hsm" }, { kind: "operator-master-key", x: 1 }, { ...cloud, secretAccessKey: "inline" }, { ...cloud, endpoint: "ftp://x" }, { ...transit, token: "inline" }, { ...transit, mount: "bad mount" }]) expect(wellFormedFactoryKeyManagement(refused)).toBe(false);
  });
});
