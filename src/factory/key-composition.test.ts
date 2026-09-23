import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FakeCloudKms, MemoryWraps } from "../__tests__/helpers/factory-kms-doubles";
import { InstallationDataKey, type FactoryDataKeyWrapper } from "./encryption";
import { composeFactoryDataKeyWrapper, factoryAwsKmsClient, loadFactoryInstallationDataKey } from "./key-composition";
import type { FactoryStartupConfig } from "./startup-config";

const installationId = "key-installation";
const aad = { tenantId: "tenant-key", objectId: "object-1", payloadKind: "archive" as const };
let directory: string;

beforeAll(async () => { directory = await mkdtemp(join(process.env.HOME!, ".w15-keys-")); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

async function secret(name: string, content: string | Uint8Array): Promise<string> {
  const path = join(directory, name);
  await writeFile(path, content, { mode: 0o600 });
  return path;
}

function config(keyManagement?: FactoryStartupConfig["keyManagement"], wrappedKeyFilePath = join(directory, "wraps.json")): Pick<FactoryStartupConfig, "installationId" | "keys" | "keyManagement"> {
  return {
    installationId,
    keys: { masterKeyFilePath: join(directory, "master.key"), masterKeyId: "operator-1", wrappedKeyFilePath, grantableRoots: ["/srv/project"] },
    ...(keyManagement === undefined ? {} : { keyManagement }),
  };
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

/** Proves two handles are the same data key: one encrypts, the other decrypts. */
function sameKey(left: InstallationDataKey, right: InstallationDataKey): void {
  expect(new TextDecoder().decode(right.decrypt(left.encrypt(new TextEncoder().encode("same key"), aad), aad))).toBe("same key");
}

describe("the startup document selects the data-key wrapping service", () => {
  test("absent or explicit, the operator master key opens the data key from its wrap file", async () => {
    await secret("master.key", new Uint8Array(32).fill(7));
    const wrapper = await composeFactoryDataKeyWrapper(config());
    expect(await wrapper.currentKeyId()).toBe("operator-1");
    const created = await provision(wrapper, "wraps.json");
    sameKey(created, await loadFactoryInstallationDataKey(config(), wrapper));
    sameKey(created, await loadFactoryInstallationDataKey(config(), await composeFactoryDataKeyWrapper(config({ kind: "operator-master-key" }))));
  });

  describe("a hosted cloud KMS, through the AWS SDK client", () => {
    const kms = new FakeCloudKms();
    let server: ReturnType<typeof Bun.serve>;
    const targets: string[] = [];
    beforeAll(() => {
      // The KMS JSON protocol: the operation in `x-amz-target`, blobs base64 in the body.
      server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(request) {
          const target = request.headers.get("x-amz-target") ?? "";
          targets.push(target);
          const body = await request.json() as { KeyId: string; Plaintext?: string; CiphertextBlob?: string; EncryptionContext: Record<string, string> };
          const reply = target === "TrentService.Encrypt"
            ? { CiphertextBlob: Buffer.from((await kms.encrypt({ KeyId: body.KeyId, Plaintext: Buffer.from(body.Plaintext!, "base64"), EncryptionContext: body.EncryptionContext })).CiphertextBlob!).toString("base64"), KeyId: body.KeyId }
            : { Plaintext: Buffer.from((await kms.decrypt({ KeyId: body.KeyId, CiphertextBlob: Buffer.from(body.CiphertextBlob!, "base64"), EncryptionContext: body.EncryptionContext })).Plaintext!).toString("base64"), KeyId: body.KeyId };
          return Response.json(reply, { headers: { "content-type": "application/x-amz-json-1.1" } });
        },
      });
    });
    afterAll(() => { server.stop(true); });

    test("wraps and opens the data key with the credential file named by reference", async () => {
      const selected = { kind: "cloud-kms" as const, keyId: "arn:aws:kms:eu-west-1:111122223333:key/tenant", region: "eu-west-1", credentialsPath: await secret("kms.json", JSON.stringify({ accessKeyId: "AKIDTEST", secretAccessKey: "test-secret" })), endpoint: `http://127.0.0.1:${server.port}` };
      const wrapper = await composeFactoryDataKeyWrapper(config(selected));
      const created = await provision(wrapper, "kms-wraps.json");
      sameKey(created, await loadFactoryInstallationDataKey(config(selected, join(directory, "kms-wraps.json")), wrapper));
      // Creation wraps and reopens its own wrap; the load opens it again.
      expect(targets).toEqual(["TrentService.Encrypt", "TrentService.Decrypt", "TrentService.Decrypt"]);
      expect(kms.calls).toEqual([`encrypt:${selected.keyId}`, `decrypt:${selected.keyId}`, `decrypt:${selected.keyId}`]);
    });

    test("an injected client receives the region, endpoint, and credentials; a malformed credential file is refused", async () => {
      const seen: unknown[] = [];
      const credentialsPath = await secret("kms-2.json", JSON.stringify({ accessKeyId: "AKIDTEST", secretAccessKey: "test-secret" }));
      await composeFactoryDataKeyWrapper(config({ kind: "cloud-kms", keyId: "k", region: "us-east-1", credentialsPath }), { cloudKmsClient: options => { seen.push(options); return kms; } });
      expect(seen).toEqual([{ region: "us-east-1", credentials: { accessKeyId: "AKIDTEST", secretAccessKey: "test-secret" } }]);
      expect(factoryAwsKmsClient({ region: "us-east-1", credentials: { accessKeyId: "a", secretAccessKey: "b" } })).toMatchObject({ encrypt: expect.any(Function), decrypt: expect.any(Function) });
      for (const [name, content] of [["kms-bad.json", "{not json"], ["kms-empty.json", JSON.stringify({ accessKeyId: "a" })]] as const) {
        await expect(composeFactoryDataKeyWrapper(config({ kind: "cloud-kms", keyId: "k", region: "us-east-1", credentialsPath: await secret(name, content) }))).rejects.toMatchObject({ code: "factory_key_invalid" });
      }
      await expect(composeFactoryDataKeyWrapper(config({ kind: "cloud-kms", keyId: "k", region: "us-east-1", credentialsPath: join(directory, "absent.json") }))).rejects.toMatchObject({ code: "factory_key_invalid" });
    });
  });

  test("a self-hosted transit engine wraps and opens the data key, trusting the named CA", async () => {
    const tls: unknown[] = [];
    const transit = (async (input: URL, init: RequestInit & { tls?: unknown }) => {
      tls.push(init.tls);
      const body = JSON.parse(String(init.body)) as { plaintext?: string; ciphertext?: string };
      return input.pathname.includes("/encrypt/")
        ? Response.json({ data: { ciphertext: `vault:v1:${body.plaintext}` } })
        : Response.json({ data: { plaintext: body.ciphertext!.slice("vault:v1:".length) } });
    }) as unknown as typeof fetch;
    const selected = { kind: "transit" as const, endpoint: "https://vault.internal:8200", keyName: "factory-data-key", mount: "transit-2", tokenPath: await secret("transit.token", "transit-token"), caPath: await secret("vault-ca.pem", "-----BEGIN CERTIFICATE-----") };
    const wrapper = await composeFactoryDataKeyWrapper(config(selected), { fetch: transit });
    expect(await wrapper.currentKeyId()).toBe("transit:transit-2/factory-data-key");
    const created = await provision(wrapper, "transit-wraps.json");
    sameKey(created, await loadFactoryInstallationDataKey(config(selected, join(directory, "transit-wraps.json")), wrapper));
    expect(tls).toEqual(Array.from({ length: 3 }, () => ({ ca: "-----BEGIN CERTIFICATE-----" })));
    // Without a CA the wrapper uses the system trust store; an unreadable CA file is refused before any call.
    expect(await (await composeFactoryDataKeyWrapper(config({ kind: "transit", endpoint: "https://vault.internal:8200", keyName: "k", tokenPath: selected.tokenPath }))).currentKeyId()).toBe("transit:transit/k");
    await expect(composeFactoryDataKeyWrapper(config({ ...selected, caPath: join(directory, "absent-ca.pem") }))).rejects.toMatchObject({ code: "factory_key_unsafe" });
  });
});
