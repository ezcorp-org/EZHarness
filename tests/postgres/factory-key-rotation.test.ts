import { afterAll, beforeAll, expect, test } from "bun:test";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ListObjectVersionsCommand } from "@aws-sdk/client-s3";
import { canonicalJson } from "@ezcorp/extension-contract";
import { EncryptedBlobStore, EncryptedRecordCodec, InstallationDataKey, StaticMasterKeyProvider } from "../../src/factory/encryption";
import { DatabaseInstallationKeyWrapStore } from "../../src/factory/encryption-key-wrap-store";
import { FactoryCheckpointCoordinator, factoryKeyWrapDigest, latestFactoryCheckpoint } from "../../src/factory/checkpoint-barrier";
import { FactoryCloudKmsWrapper, type FactoryCloudKmsClient } from "../../src/factory/key-management";
import { FactoryRecords } from "../../src/factory/records";
import { factoryRecoveryStorage } from "./helpers/factory-recovery-storage";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

/**
 * C06 key rotation against the real product database and the real ordinary
 * and archive stores: rotation rewraps the data key, every prior wrap is kept,
 * data archived and checkpointed before the rotation still reads, and no
 * object is rewritten in place — each keeps its one original version.
 */

const tenantId = "rotation-tenant", installationId = "rotation-installation";
let fixture: Awaited<ReturnType<typeof setupFactoryPostgres>>;
let storage: Awaited<ReturnType<typeof factoryRecoveryStorage>>;

/** A cloud KMS double with the service's contract: the key never leaves it and the context is authenticated. */
function cloudKms(): FactoryCloudKmsClient {
  const key = randomBytes(32);
  return {
    async encrypt(input) {
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(canonicalJson(input.EncryptionContext)));
      const body = Buffer.concat([cipher.update(input.Plaintext), cipher.final()]);
      return { CiphertextBlob: new Uint8Array(Buffer.concat([iv, cipher.getAuthTag(), body])) };
    },
    async decrypt(input) {
      const blob = Buffer.from(input.CiphertextBlob), decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(0, 12));
      decipher.setAAD(Buffer.from(canonicalJson(input.EncryptionContext)));
      decipher.setAuthTag(blob.subarray(12, 28));
      return { Plaintext: new Uint8Array(Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()])) };
    },
  };
}

async function versionsUnder(client: typeof storage.ordinaryClient, prefix: string) {
  const listed = await client.send(new ListObjectVersionsCommand({ Bucket: storage.tenant, Prefix: `${prefix}/` }));
  const byKey = new Map<string, string[]>();
  for (const version of listed.Versions ?? []) byKey.set(version.Key!, [...(byKey.get(version.Key!) ?? []), version.VersionId!]);
  return byKey;
}

beforeAll(async () => {
  fixture = await setupFactoryPostgres();
  storage = await factoryRecoveryStorage();
  await new FactoryRecords(fixture.db, tenantId).bindInstallation();
});
afterAll(async () => {
  await storage?.cleanup().then(result => console.log(`w15 rotation storage cleanup ${JSON.stringify(result)}`));
  await fixture?.close();
});

test("rotation rewraps the data key, keeps every wrap, and leaves archived and checkpointed data readable and unrewritten", async () => {
  const wraps = new DatabaseInstallationKeyWrapStore(fixture.db);
  const first = { id: "master-1", bytes: new Uint8Array(32).fill(1) }, second = { id: "master-2", bytes: new Uint8Array(32).fill(2) };
  const original = await InstallationDataKey.loadOrCreate(installationId, wraps, new StaticMasterKeyProvider(first));

  // Encrypted product objects and an encrypted archive record, written under the original wrap.
  const blobs = new EncryptedBlobStore(storage.blobs, original, tenantId);
  const objectDigests: string[] = [];
  for (let index = 0; index < 3; index += 1) objectDigests.push(await blobs.putBound({ tenantId, objectId: `object-${index}` }, new TextEncoder().encode(`product object ${index}`)));
  const records = new EncryptedRecordCodec(original, "archive");
  const archived = await storage.archive.write(tenantId, "audit", "rotation-run", records.encode({ tenantId, objectId: "rotation-run" }, new TextEncoder().encode("archived audit page")));
  const checkpoint = await new FactoryCheckpointCoordinator({ database: fixture.db, tenantId, installationId, archive: storage.archive }).run();
  expect(checkpoint.kind).toBe("sealed");
  const manifest = (await latestFactoryCheckpoint(storage.archive, tenantId))!.manifest;
  expect(manifest.keys).toMatchObject({ wrapVersion: 1, masterKeyId: "master-1" });
  const ordinaryBefore = await versionsUnder(storage.ordinaryClient, storage.ordinaryPrefix);
  const archiveBefore = await versionsUnder(storage.archiveClient, storage.archiveOptions.prefix);

  // Rotate twice: to a new operator master key, then to a hosted cloud KMS key.
  const rotated = await original.rotate(wraps, new StaticMasterKeyProvider(second, [first, second]));
  const kms = cloudKms();
  await rotated.rotate(wraps, new FactoryCloudKmsWrapper({ keyId: "arn:kms:rotation-key", client: kms }));
  expect((await wraps.load(installationId)).map(row => [row.wrapVersion, row.masterKeyId])).toEqual([[3, "arn:kms:rotation-key"], [2, "master-2"], [1, "master-1"]]);

  // A process holding only the newest key opens the data key and reads everything written before.
  const reopened = await InstallationDataKey.loadExisting(installationId, wraps, new FactoryCloudKmsWrapper({ keyId: "arn:kms:rotation-key", client: kms }));
  expect(reopened.wrapVersion).toBe(3);
  const readBack = new EncryptedBlobStore(storage.blobs, reopened, tenantId);
  for (let index = 0; index < 3; index += 1) expect(new TextDecoder().decode(await readBack.getBound({ tenantId, objectId: `object-${index}` }, objectDigests[index]!))).toBe(`product object ${index}`);
  expect(new TextDecoder().decode(new EncryptedRecordCodec(reopened, "archive").decode({ tenantId, objectId: "rotation-run" }, await storage.archive.read(archived)))).toBe("archived audit page");
  // The checkpoint's recorded wrap is still in the ledger byte for byte, so a restore to it passes its key check.
  expect((await factoryKeyWrapDigest(fixture.db, installationId, 1))!.wrappedDigest).toBe(manifest.keys.wrappedDigest!);

  // Nothing was rewritten: every object still has exactly its one original version.
  expect(await versionsUnder(storage.ordinaryClient, storage.ordinaryPrefix)).toEqual(ordinaryBefore);
  expect(await versionsUnder(storage.archiveClient, storage.archiveOptions.prefix)).toEqual(archiveBefore);
  for (const versions of [...ordinaryBefore.values(), ...archiveBefore.values()]) expect(versions).toHaveLength(1);
});
