import { expect, test } from "bun:test";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { FactoryMemoryS3Store } from "../__tests__/helpers/factory-s3-memory-store";
import { canonicalProviderReceipt, s3ReleaseRequest, S3FactoryReleaseArchive, S3FactoryReleaseProvider } from "./release-adapters";
import { FactoryReleaseError, type FactoryReleaseClaim } from "./releases";

function claim(overrides: Partial<FactoryReleaseClaim> = {}): FactoryReleaseClaim {
  const request = { bytesBase64: Buffer.from("release bytes").toString("base64"), contentType: "text/plain" };
  return {
    tenantId: "tenant-a", projectId: "project-a", operationId: `factory-release:${"a".repeat(64)}`, runId: "run-a", nodeInstanceId: "node-a", candidateGeneration: 1, candidateDigest: `sha256:${"b".repeat(64)}`,
    decisionId: "decision-a", contractDigest: `sha256:${"c".repeat(64)}`, executionEpoch: 1, cancellationEpoch: 0, releaseEnableEpoch: 1, action: "publish",
    destination: { provider: "s3", account: "tenant-a", object: "releases/result.txt" }, request, destinationDigest: `sha256:${"d".repeat(64)}`, requestDigest: `sha256:${"e".repeat(64)}`,
    material: { decisionId: "decision-a", evidence: [{}], packageTrustDigest: `sha256:${"a".repeat(64)}`, validatorTrustDigest: `sha256:${"b".repeat(64)}` }, materialDigest: `sha256:${"f".repeat(64)}`,
    estimatedSpendMicros: 0, deadlineMs: Date.now() + 10_000, state: "executing", dispatchGeneration: 1, dispatchStarted: true, senderToken: "sender", archiveReady: true,
    authority: { kind: "approval", id: "approval-a" }, ...overrides,
  };
}

test("S3 release archive conditionally writes exact operation prefixes and reads the returned version", async () => {
  const client = new FactoryMemoryS3Store();
  const archive = new S3FactoryReleaseArchive({ endpoint: "http://127.0.0.1", bucket: "archive", prefix: "recovery", credentials: { accessKeyId: "archive-id", secretAccessKey: "archive-secret" }, client });
  const bytes = new TextEncoder().encode("sealed intent");
  const reference = await archive.writeImmutable("tenant-a", `factory-release:${"a".repeat(64)}`, "intent", bytes);
  expect(reference.key).toContain("recovery/dGVuYW50LWE/");
  expect(reference.versionId).toBe("version-1");
  expect(await archive.read(reference)).toEqual(bytes);
  expect(await archive.writeImmutable("tenant-a", `factory-release:${"a".repeat(64)}`, "intent", bytes)).toMatchObject({ key: reference.key });
  await expect(archive.read({ ...reference, versionId: undefined })).rejects.toMatchObject({ code: "factory_release_archive_version_missing" });
  await expect(archive.read({ ...reference, key: reference.key.replace("recovery/", "foreign/") })).rejects.toMatchObject({ code: "factory_release_archive_foreign" });
  client.corruptReads = true;
  await expect(archive.read(reference)).rejects.toThrow();
  client.corruptReads = false; client.omitVersions = true;
  await expect(archive.writeImmutable("tenant-a", `factory-release:${"b".repeat(64)}`, "intent", bytes)).rejects.toMatchObject({ code: "factory_release_archive_version_missing" });
});

test("S3 provider binds target, condition, returned version, and verified bytes into its receipt", async () => {
  const client = new FactoryMemoryS3Store();
  const provider = new S3FactoryReleaseProvider({ endpoint: "http://127.0.0.1", bucket: "ordinary", account: "tenant-a", prefix: "published", credentials: { accessKeyId: "ordinary-id", secretAccessKey: "ordinary-secret" }, client });
  const productionProvider = new S3FactoryReleaseProvider({ endpoint: "http://127.0.0.1", bucket: "ordinary", account: "tenant-a", credentials: { accessKeyId: "ordinary-id", secretAccessKey: "ordinary-secret" } });
  const productionArchive = new S3FactoryReleaseArchive({ endpoint: "http://127.0.0.1", bucket: "archive", prefix: "recovery", credentials: { accessKeyId: "archive-id", secretAccessKey: "archive-secret" } });
  expect(await (productionProvider as unknown as { client: { config: { maxAttempts(): Promise<number> } } }).client.config.maxAttempts()).toBe(1);
  expect(await (productionArchive as unknown as { client: { config: { maxAttempts(): Promise<number> } } }).client.config.maxAttempts()).toBe(1);
  const operation = claim();
  const receipt = await provider.publish(operation);
  expect(receipt).toMatchObject({ provider: "s3", account: "tenant-a", object: "releases/result.txt", operationId: operation.operationId, dispatchGeneration: 1, version: "version-1" });
  expect(receipt.effectDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(canonicalProviderReceipt(receipt)).toContain(receipt.providerReceiptId);
  expect(s3ReleaseRequest(new TextEncoder().encode("x"), "text/plain")).toEqual({ bytesBase64: "eA==", contentType: "text/plain" });
  expect(s3ReleaseRequest(new TextEncoder().encode("x"))).toEqual({ bytesBase64: "eA==" });
  await expect(provider.publish(operation)).rejects.toMatchObject({ code: "factory_s3_version_changed" });
  await expect(provider.publish(claim({ destination: { ...operation.destination, object: "mutable.txt", expectedVersion: "old-version" } }))).rejects.toMatchObject({ code: "factory_s3_immutable_target" });
  await expect(provider.publish(claim({ destination: { ...operation.destination, account: "foreign" } }))).rejects.toBeInstanceOf(FactoryReleaseError);
  await expect(provider.publish(claim({ request: { bytesBase64: "not base64" } }))).rejects.toMatchObject({ code: "factory_s3_request_invalid" });
  const missingVersionClient = new FactoryMemoryS3Store(); missingVersionClient.omitVersions = true;
  const missingVersionProvider = new S3FactoryReleaseProvider({ endpoint: "http://127.0.0.1", bucket: "ordinary", account: "tenant-a", credentials: { accessKeyId: "ordinary-id", secretAccessKey: "ordinary-secret" }, client: missingVersionClient });
  await expect(missingVersionProvider.publish(claim({ destination: { provider: "s3", account: "tenant-a", object: "missing-version.txt" } }))).rejects.toMatchObject({ code: "factory_s3_receipt_missing" });
});

test("S3 response loss exposes uncertainty and an exact live lookup proves effect or absence", async () => {
  const client = new FactoryMemoryS3Store();
  const provider = new S3FactoryReleaseProvider({ endpoint: "http://127.0.0.1", bucket: "ordinary", account: "tenant-a", credentials: { accessKeyId: "ordinary-id", secretAccessKey: "ordinary-secret" }, client });
  client.losePutResponse = true;
  const operation = claim({ destination: { provider: "s3", account: "tenant-a", object: "lost.txt" } });
  await expect(provider.publish(operation)).rejects.toThrow("response lost");
  client.losePutResponse = false;
  await expect(provider.publish(operation)).rejects.toMatchObject({ code: "factory_s3_version_changed" });
  expect(await provider.proveNoEffect(operation, { operationId: operation.operationId, reason: "operator lookup" })).toBe(false);
  const absent = claim({ destination: { provider: "s3", account: "tenant-a", object: "absent.txt" } });
  const controller = new AbortController();
  expect(await provider.proveNoEffect(absent, { operationId: absent.operationId, reason: "operator lookup" }, controller.signal)).toBe(true);
  expect(client.lastAbortSignal).toBe(controller.signal);
  expect(await provider.proveNoEffect(absent, { operationId: "foreign", reason: "operator lookup" })).toBe(false);
});


test("S3 reconciliation verifies a provider receipt against exact version bytes without another write", async () => {
  const client = new FactoryMemoryS3Store();
  const provider = new S3FactoryReleaseProvider({ endpoint: "http://127.0.0.1", bucket: "ordinary", account: "tenant-a", prefix: "published", credentials: { accessKeyId: "ordinary-id", secretAccessKey: "ordinary-secret" }, client });
  const operation = claim();
  const receipt = await provider.publish(operation);
  const evidence = { operationId: operation.operationId, reason: "verify recorded version" };
  const signal = new AbortController().signal;
  expect(await provider.verifyReceipt(operation, receipt, evidence, signal)).toBe(true);
  expect(client.lastAbortSignal).toBe(signal);
  for (const forged of [{ ...receipt, version: "" }, { ...receipt, version: "missing-version" }, { ...receipt, effectDigest: `sha256:${"0".repeat(64)}` }, { ...receipt, providerReceiptId: "forged-receipt" }, { ...receipt, account: "foreign" }]) {
    expect(await provider.verifyReceipt(operation, forged, evidence)).toBe(false);
  }
  expect(client.versions.size).toBe(1);
  const replaced = await client.send(new PutObjectCommand({ Bucket: "ordinary", Key: "published/releases/result.txt", Body: Buffer.from("release bytes"), ContentType: "application/octet-stream" }));
  expect(await provider.verifyReceipt(operation, receipt, evidence)).toBe(true);
  await expect(provider.verifyReceipt(operation, { ...receipt, version: String(replaced.VersionId) }, evidence)).rejects.toMatchObject({ code: "factory_s3_receipt_corrupt" });
  client.corruptReads = true;
  await expect(provider.verifyReceipt(operation, receipt, evidence)).rejects.toMatchObject({ code: "factory_s3_receipt_corrupt" });
});
