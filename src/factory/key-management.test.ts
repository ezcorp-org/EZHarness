import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "@ezcorp/extension-contract";
import { InstallationDataKey, StaticMasterKeyProvider, type InstallationKeyWrap, type InstallationKeyWrapStore } from "./encryption";
import { FactoryCloudKmsWrapper, FactoryTransitKmsWrapper, type FactoryCloudKmsClient } from "./key-management";

class MemoryWraps implements InstallationKeyWrapStore {
  readonly rows: InstallationKeyWrap[] = [];
  async load(installationId: string) { return this.rows.filter(row => row.installationId === installationId).sort((a, b) => b.wrapVersion - a.wrapVersion); }
  async save(wrap: InstallationKeyWrap) { if (!this.rows.some(row => row.installationId === wrap.installationId && row.wrapVersion === wrap.wrapVersion)) this.rows.push({ ...wrap, wrappedDataKey: Uint8Array.from(wrap.wrappedDataKey) }); }
}

/** A cloud KMS with the real service's contract: a key never leaves it, and the encryption context is authenticated. */
class FakeCloudKms implements FactoryCloudKmsClient {
  private readonly keys = new Map<string, Buffer>();
  calls: string[] = [];
  key(id: string) { if (!this.keys.has(id)) this.keys.set(id, randomBytes(32)); return this.keys.get(id)!; }
  async encrypt(input: Parameters<FactoryCloudKmsClient["encrypt"]>[0]) {
    this.calls.push(`encrypt:${input.KeyId}`);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(input.KeyId), iv);
    cipher.setAAD(Buffer.from(canonicalJson(input.EncryptionContext)));
    const body = Buffer.concat([cipher.update(input.Plaintext), cipher.final()]);
    return { CiphertextBlob: new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), body])), KeyId: input.KeyId };
  }
  async decrypt(input: Parameters<FactoryCloudKmsClient["decrypt"]>[0]) {
    this.calls.push(`decrypt:${input.KeyId}`);
    const blob = Buffer.from(input.CiphertextBlob);
    const decipher = createDecipheriv("aes-256-gcm", this.key(input.KeyId), blob.subarray(0, 12));
    decipher.setAAD(Buffer.from(canonicalJson(input.EncryptionContext)));
    decipher.setAuthTag(blob.subarray(12, 28));
    return { Plaintext: new Uint8Array(Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()])), KeyId: input.KeyId };
  }
}

const installationId = "kms-installation";

describe("hosted cloud KMS wrapping", () => {
  test("wraps under the KMS key, rotates by adding a wrap, and opens a retained wrap only with its key", async () => {
    const kms = new FakeCloudKms();
    const wraps = new MemoryWraps();
    const first = new FactoryCloudKmsWrapper({ keyId: "arn:kms:key/one", client: kms });
    const created = await InstallationDataKey.loadOrCreate(installationId, wraps, first);
    const secret = created.encrypt(new TextEncoder().encode("archived before rotation"), { tenantId: "tenant-kms", objectId: "archive-1", payloadKind: "archive" });
    expect(wraps.rows).toHaveLength(1);
    expect(wraps.rows[0]!.masterKeyId).toBe("arn:kms:key/one");
    const second = new FactoryCloudKmsWrapper({ keyId: "arn:kms:key/two", retainedKeyIds: ["arn:kms:key/one"], client: kms });
    const rotated = await created.rotate(wraps, second);
    expect(rotated.wrapVersion).toBe(2);
    expect(wraps.rows.map(row => [row.wrapVersion, row.masterKeyId])).toEqual([[1, "arn:kms:key/one"], [2, "arn:kms:key/two"]]);
    const reopened = await InstallationDataKey.loadExisting(installationId, wraps, new FactoryCloudKmsWrapper({ keyId: "arn:kms:key/two", client: kms }));
    expect(new TextDecoder().decode(reopened.decrypt(secret, { tenantId: "tenant-kms", objectId: "archive-1", payloadKind: "archive" }))).toBe("archived before rotation");
    // Only the retained wrap is left: a wrapper that knows only the new key cannot open it, one that retains the old key can.
    wraps.rows.splice(1, 1);
    await expect(InstallationDataKey.loadExisting(installationId, wraps, new FactoryCloudKmsWrapper({ keyId: "arn:kms:key/two", client: kms }))).rejects.toMatchObject({ code: "factory_key_missing" });
    expect((await InstallationDataKey.loadExisting(installationId, wraps, second)).wrapVersion).toBe(1);
  });

  test("the encryption context binds the wrap to its installation and version", async () => {
    const kms = new FakeCloudKms();
    const wrapper = new FactoryCloudKmsWrapper({ keyId: "key-a", client: kms });
    const wrapped = await wrapper.wrap(new Uint8Array(32).fill(4), "key-a", { installationId, wrapVersion: 1 });
    await expect(wrapper.unwrap(wrapped, "key-a", { installationId: "other", wrapVersion: 1 })).rejects.toThrow();
    await expect(wrapper.unwrap(wrapped, "key-a", { installationId, wrapVersion: 2 })).rejects.toThrow();
    expect(await wrapper.unwrap(wrapped, "key-z", { installationId, wrapVersion: 1 })).toBeUndefined();
    await expect(wrapper.wrap(new Uint8Array(32), "key-b", { installationId, wrapVersion: 1 })).rejects.toMatchObject({ code: "factory_key_conflict" });
    await expect(wrapper.wrap(new Uint8Array(31), "key-a", { installationId, wrapVersion: 1 })).rejects.toMatchObject({ code: "factory_key_invalid" });
    const empty = new FactoryCloudKmsWrapper({ keyId: "key-a", client: { encrypt: async () => ({}), decrypt: async () => ({ Plaintext: new Uint8Array(3) }) } });
    await expect(empty.wrap(new Uint8Array(32), "key-a", { installationId, wrapVersion: 1 })).rejects.toMatchObject({ code: "factory_key_invalid" });
    await expect(empty.unwrap(new Uint8Array(3), "key-a", { installationId, wrapVersion: 1 })).rejects.toMatchObject({ code: "factory_key_invalid" });
    expect(() => new FactoryCloudKmsWrapper({ keyId: "", client: kms })).toThrow();
  });

  test("a master-key wrap and a KMS wrap coexist: rotation moves an installation from the operator key to a KMS", async () => {
    const wraps = new MemoryWraps();
    const master = { id: "master-1", bytes: new Uint8Array(32).fill(1) };
    const created = await InstallationDataKey.loadOrCreate(installationId, wraps, new StaticMasterKeyProvider(master));
    const kms = new FakeCloudKms();
    await created.rotate(wraps, new FactoryCloudKmsWrapper({ keyId: "kms-key", client: kms }));
    expect((await InstallationDataKey.loadExisting(installationId, wraps, new FactoryCloudKmsWrapper({ keyId: "kms-key", client: kms }))).wrapVersion).toBe(2);
    expect((await InstallationDataKey.loadExisting(installationId, wraps, new StaticMasterKeyProvider(master))).wrapVersion).toBe(1);
  });
});

describe("self-hosted external KMS (transit engine)", () => {
  let server: ReturnType<typeof Bun.serve>;
  let directory: string;
  let tokenPath: string;
  const keyVersions: Buffer[] = [randomBytes(32)];
  const seen: string[] = [];
  const token = "transit-token-for-tests";

  beforeAll(async () => {
    directory = await mkdtemp(join(process.env.HOME!, ".w15-transit-"));
    await chmod(directory, 0o700);
    tokenPath = join(directory, "token");
    await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
    await chmod(tokenPath, 0o600);
    // The transit engine's HTTP contract: versioned keys, `vault:vN:` ciphertexts, the token in a header.
    server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        seen.push(url.pathname);
        if (request.headers.get("x-vault-token") !== token) return Response.json({ errors: ["permission denied"] }, { status: 403 });
        const body = await request.json() as { plaintext?: string; ciphertext?: string };
        if (url.pathname === "/v1/transit/encrypt/factory-data-key") {
          const version = keyVersions.length, iv = randomBytes(12);
          const cipher = createCipheriv("aes-256-gcm", keyVersions[version - 1]!, iv);
          const encrypted = Buffer.concat([cipher.update(Buffer.from(body.plaintext!, "base64")), cipher.final()]);
          return Response.json({ data: { ciphertext: `vault:v${version}:${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64")}` } });
        }
        if (url.pathname === "/v1/transit/decrypt/factory-data-key") {
          const match = /^vault:v(\d+):(.+)$/.exec(body.ciphertext ?? "");
          const key = match ? keyVersions[Number(match[1]) - 1] : undefined;
          if (!match || !key) return Response.json({ errors: ["invalid ciphertext"] }, { status: 400 });
          const raw = Buffer.from(match[2]!, "base64");
          try {
            const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
            decipher.setAuthTag(raw.subarray(12, 28));
            return Response.json({ data: { plaintext: Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("base64") } });
          } catch { return Response.json({ errors: ["cipher: message authentication failed"] }, { status: 400 }); }
        }
        if (url.pathname === "/v1/transit/encrypt/broken") return new Response("not json", { status: 200 });
        return Response.json({ errors: ["no handler"] }, { status: 404 });
      },
    });
  });
  afterAll(async () => { server?.stop(true); await rm(directory, { recursive: true, force: true }); });

  const wrapper = (keyName = "factory-data-key", path = () => tokenPath) => new FactoryTransitKmsWrapper({ endpoint: `http://127.0.0.1:${server.port}`, keyName, tokenPath: path() });

  test("a transit key rotation keeps prior versions, so a wrap made before it still opens", async () => {
    const wraps = new MemoryWraps();
    const created = await InstallationDataKey.loadOrCreate(installationId, wraps, wrapper());
    expect(wraps.rows[0]!.masterKeyId).toBe("transit:transit/factory-data-key");
    expect(new TextDecoder().decode(wraps.rows[0]!.wrappedDataKey)).toMatch(/^vault:v1:/);
    keyVersions.push(randomBytes(32));
    const rotated = await created.rotate(wraps, wrapper());
    expect(new TextDecoder().decode(wraps.rows[1]!.wrappedDataKey)).toMatch(/^vault:v2:/);
    const reopened = await InstallationDataKey.loadExisting(installationId, wraps, wrapper());
    expect(reopened.wrapVersion).toBe(rotated.wrapVersion);
    wraps.rows.splice(1, 1);
    expect((await InstallationDataKey.loadExisting(installationId, wraps, wrapper())).wrapVersion).toBe(1);
    expect(seen.every(path => path.startsWith("/v1/transit/"))).toBe(true);
  });

  test("the sealed binding, the token, and the service's answers are all checked", async () => {
    const transit = wrapper();
    const wrapped = await transit.wrap(new Uint8Array(32).fill(8), "transit:transit/factory-data-key", { installationId, wrapVersion: 3 });
    await expect(transit.unwrap(wrapped, "transit:transit/factory-data-key", { installationId, wrapVersion: 4 })).rejects.toMatchObject({ code: "factory_decryption_failed" });
    expect(await transit.unwrap(wrapped, "transit:transit/other", { installationId, wrapVersion: 3 })).toBeUndefined();
    await expect(transit.unwrap(new TextEncoder().encode("vault:v9:AAAA"), "transit:transit/factory-data-key", { installationId, wrapVersion: 3 })).rejects.toMatchObject({ code: "factory_decryption_failed" });
    await expect(transit.wrap(new Uint8Array(32), "transit:transit/elsewhere", { installationId, wrapVersion: 1 })).rejects.toMatchObject({ code: "factory_key_conflict" });
    await writeFile(tokenPath, "wrong-token", { mode: 0o600 });
    await expect(transit.wrap(new Uint8Array(32), "transit:transit/factory-data-key", { installationId, wrapVersion: 1 })).rejects.toMatchObject({ code: "factory_key_missing" });
    await writeFile(tokenPath, token, { mode: 0o600 });
    await expect(wrapper("broken").wrap(new Uint8Array(32), "transit:transit/broken", { installationId, wrapVersion: 1 })).rejects.toMatchObject({ code: "factory_key_missing" });
    const bad = new FactoryTransitKmsWrapper({ endpoint: "http://127.0.0.1:9", keyName: "factory-data-key", tokenPath, timeoutMs: 1_000 });
    await expect(bad.wrap(new Uint8Array(32), "transit:transit/factory-data-key", { installationId, wrapVersion: 1 })).rejects.toMatchObject({ code: "factory_key_missing" });
    const lying = new FactoryTransitKmsWrapper({ endpoint: "http://unused.invalid", keyName: "factory-data-key", tokenPath, fetch: (async () => Response.json({ data: { ciphertext: "plain", plaintext: Buffer.from("{not json").toString("base64") } })) as unknown as typeof fetch });
    await expect(lying.wrap(new Uint8Array(32), "transit:transit/factory-data-key", { installationId, wrapVersion: 1 })).rejects.toMatchObject({ code: "factory_key_invalid" });
    await expect(lying.unwrap(new TextEncoder().encode("vault:v1:x"), "transit:transit/factory-data-key", { installationId, wrapVersion: 1 })).rejects.toMatchObject({ code: "factory_decryption_failed" });
    expect(() => new FactoryTransitKmsWrapper({ endpoint: "http://x", keyName: "bad name", tokenPath })).toThrow();
    expect(() => new FactoryTransitKmsWrapper({ endpoint: "http://x", keyName: "ok", mount: "../escape", tokenPath })).toThrow();
  });
});
