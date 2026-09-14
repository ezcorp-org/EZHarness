import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { canonicalJson } from "@ezcorp/extension-contract";
import type { FactoryArtifactReference } from "@ezcorp/factory-sdk";
import { FactoryMemoryS3Store } from "../__tests__/helpers/factory-s3-memory-store";
import type { FactoryMaterialScope, FactoryScopedArtifactReader } from "./artifact-materials";
import {
  FACTORY_S3_MANIFEST_MEDIA_TYPE,
  FACTORY_S3_MANIFEST_NAME,
  FACTORY_S3_PUBLICATION_LIMITS,
  FACTORY_S3_PUBLICATION_MANIFEST_SCHEMA_VERSION,
  FACTORY_S3_PUBLICATION_RECEIPT_SCHEMA_VERSION,
  FACTORY_S3_PUBLICATION_REQUEST_SCHEMA_VERSION,
  S3FactoryManifestReleaseProvider,
  assertFactoryS3PublicationRequest,
  factoryS3PublicationDirectory,
  factoryS3PublicationIdentity,
  factoryS3PublicationManifestBytes,
  type FactoryS3ManifestReceipt,
  type FactoryS3PublicationMember,
  type FactoryS3PublicationSetRequest,
  type FactoryS3PublishedFile,
} from "./release-s3-publication";
import { FactoryReleaseError, type FactoryReleaseClaim, type FactoryReleaseOperation } from "./releases";

const TENANT = "publication-tenant";
const ATTEMPT = "publication-attempt";
const MATERIAL_OPERATION = "run-a:node-a:0:0";
const BUCKET = "tenant-01";
const ACCOUNT = "tenant-01";
const DIRECTORY = "releases/set-a";
const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const sha256 = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const encoder = new TextEncoder();

/** W04's scoped reader, holding member bytes as the chunks a material would. */
class MemoryReader implements FactoryScopedArtifactReader {
  readonly chunks = new Map<string, Uint8Array[]>();
  scopes: FactoryMaterialScope[] = [];
  denied = new Set<string>();
  async read(): Promise<Uint8Array> { throw new Error("the publication provider must read chunks, never a whole material"); }
  async readChunk(scope: FactoryMaterialScope, reference: FactoryArtifactReference, index: number): Promise<Uint8Array> {
    this.scopes.push(scope);
    if (this.denied.has(reference.artifactId)) throw new FactoryReleaseError("factory_artifact_unavailable");
    const parts = this.chunks.get(reference.artifactId);
    if (!parts || index >= parts.length) throw new FactoryReleaseError("factory_artifact_unavailable");
    return parts[index]!;
  }
}

interface Fixture {
  readonly store: FactoryMemoryS3Store;
  readonly reader: MemoryReader;
  readonly provider: S3FactoryManifestReleaseProvider;
  readonly attempts: { attemptFor(): Promise<string>; calls: number };
}

function fixture(options: { prefix?: string; attemptId?: string } = {}): Fixture {
  const store = new FactoryMemoryS3Store();
  const reader = new MemoryReader();
  const attempts = { calls: 0, async attemptFor() { attempts.calls += 1; return options.attemptId ?? ATTEMPT; } };
  const provider = new S3FactoryManifestReleaseProvider({
    endpoint: "http://127.0.0.1:18333", bucket: BUCKET, account: ACCOUNT, prefix: options.prefix,
    credentials: { accessKeyId: "ordinary-id", secretAccessKey: "ordinary-secret" }, client: store, reader, attempts,
  });
  return { store, reader, provider, attempts };
}

/** Registers one member's bytes as chunks and returns the frozen request entry. */
function member(reader: MemoryReader, name: string, chunks: readonly Uint8Array[], mediaType = "text/plain"): FactoryS3PublicationMember {
  const artifactId = `material-${name.replaceAll("/", "-")}`;
  reader.chunks.set(artifactId, chunks.map(chunk => Uint8Array.from(chunk)));
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const whole = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { whole.set(chunk, offset); offset += chunk.byteLength; }
  return { name, mediaType, digest: sha256(whole), totalBytes: total, chunkCount: chunks.length, artifact: { artifactId, digest: sha256(whole), encodedBytes: 1024 } };
}

function request(members: readonly FactoryS3PublicationMember[]): FactoryS3PublicationSetRequest {
  return { schemaVersion: FACTORY_S3_PUBLICATION_REQUEST_SCHEMA_VERSION, materialOperationId: MATERIAL_OPERATION, candidate: { artifactId: "material-candidate", digest: digest("c"), encodedBytes: 512 }, members };
}

function claim(overrides: Partial<FactoryReleaseClaim> = {}): FactoryReleaseClaim {
  return {
    tenantId: TENANT, projectId: "project-a", operationId: `factory-release:${"a".repeat(64)}`, runId: "run-a", nodeInstanceId: "node-a",
    candidateGeneration: 1, candidateDigest: digest("b"), decisionId: "decision-a", contractDigest: digest("c"), executionEpoch: 1,
    cancellationEpoch: 0, releaseEnableEpoch: 1, action: "publish-manifest",
    destination: { provider: "s3", account: ACCOUNT, object: DIRECTORY }, request: request([]),
    destinationDigest: digest("d"), requestDigest: digest("e"),
    material: { decisionId: "decision-a", evidence: [{}], packageTrustDigest: digest("a"), validatorTrustDigest: digest("b") },
    materialDigest: digest("f"), estimatedSpendMicros: 0, deadlineMs: Date.now() + 600_000, state: "executing",
    dispatchGeneration: 1, dispatchStarted: true, senderToken: "sender", archiveReady: true,
    authority: { kind: "approval", id: "approval-a" }, ...overrides,
  };
}

const text = (value: string) => encoder.encode(value);

test("a publication set stages every exact file privately and publishes the manifest last", async () => {
  const world = fixture();
  const members = [member(world.reader, "data/part-0.csv", [text("alpha"), text("beta")], "text/csv"), member(world.reader, "readme.txt", [text("read me")])];
  const operation = claim({ request: request(members) });

  const receipt = await world.provider.publish(operation) as FactoryS3ManifestReceipt;

  expect(receipt.schemaVersion).toBe(FACTORY_S3_PUBLICATION_RECEIPT_SCHEMA_VERSION);
  expect(receipt).toMatchObject({ provider: "s3", account: ACCOUNT, object: DIRECTORY, bucket: BUCKET, directory: DIRECTORY, manifestKey: `${DIRECTORY}/${FACTORY_S3_MANIFEST_NAME}`, operationId: operation.operationId, dispatchGeneration: 1 });
  expect(receipt.files.map(file => [file.name, file.key, file.digest, file.mediaType, file.encodedBytes, file.versionId])).toEqual([
    ["data/part-0.csv", `${DIRECTORY}/data/part-0.csv`, members[0]!.digest, "text/csv", 9, "version-1"],
    ["readme.txt", `${DIRECTORY}/readme.txt`, members[1]!.digest, "text/plain", 7, "version-2"],
  ]);
  // The manifest is the publication, and its digest is the one confirmed effect.
  expect(receipt.version).toBe("version-3");
  expect(receipt.effectDigest).toBe(sha256(factoryS3PublicationManifestBytes(operation, receipt.files)));
  expect(receipt.providerReceiptId).toBe(`s3:${BUCKET}:${DIRECTORY}/${FACTORY_S3_MANIFEST_NAME}:version-3`);
  // No ETag reaches the receipt, and the stored manifest names the same versions.
  expect(canonicalJson(receipt)).not.toContain("etag");
  const stored = JSON.parse(new TextDecoder().decode(world.store.current.get(receipt.manifestKey)!.bytes)) as { schemaVersion: string; files: FactoryS3PublishedFile[] };
  expect(stored.schemaVersion).toBe(FACTORY_S3_PUBLICATION_MANIFEST_SCHEMA_VERSION);
  expect(stored.files).toEqual(receipt.files as FactoryS3PublishedFile[]);
  // Every member is read under the verified attempt, never an attempt the request named.
  expect(world.reader.scopes.every(scope => scope.attemptId === ATTEMPT && scope.operationId === MATERIAL_OPERATION && scope.tenantId === TENANT)).toBe(true);
  expect(world.attempts.calls).toBe(1);
  expect(await world.provider.verifyReceipt(operation, receipt, { operationId: operation.operationId, reason: "lookup" })).toBe(true);
});

test("partial staging never appears published and resumes only under the same authorized identity", async () => {
  const world = fixture();
  const members = [member(world.reader, "a.txt", [text("first")]), member(world.reader, "b.txt", [text("second")])];
  const operation = claim({ request: request(members) });
  world.reader.denied.add(members[1]!.artifact.artifactId);

  await expect(world.provider.publish(operation)).rejects.toMatchObject({ code: "factory_artifact_unavailable" });
  expect(world.store.current.has(`${DIRECTORY}/a.txt`)).toBe(true);
  expect(world.store.current.has(`${DIRECTORY}/${FACTORY_S3_MANIFEST_NAME}`)).toBe(false);
  // An interrupted publication proves no effect: nothing under the directory is foreign.
  expect(await world.provider.proveNoEffect(operation, { operationId: operation.operationId, reason: "operator lookup" })).toBe(true);

  world.reader.denied.clear();
  const receipt = await world.provider.publish(operation) as FactoryS3ManifestReceipt;
  // The resumed member keeps its original object version: no second write of the same bytes.
  expect(receipt.files[0]!.versionId).toBe("version-1");
  expect(world.store.versions.size).toBe(3);
  // A confirmed publication is never repeated.
  await expect(world.provider.publish(operation)).rejects.toMatchObject({ code: "factory_s3_manifest_published" });
  expect(await world.provider.proveNoEffect(operation, { operationId: operation.operationId, reason: "operator lookup" })).toBe(false);
});

test("a prior object under another identity or with other content is a conflict, never a resume", async () => {
  const world = fixture();
  const members = [member(world.reader, "a.txt", [text("first")])];
  const operation = claim({ request: request(members) });
  const identity = factoryS3PublicationIdentity(operation);
  const key = `${DIRECTORY}/a.txt`;

  world.store.put(key, text("first"), { contentType: "text/plain", metadata: { "factory-identity": `sha256:${"9".repeat(64)}`, "factory-digest": members[0]!.digest } });
  await expect(world.provider.publish(operation)).rejects.toMatchObject({ code: "factory_s3_conflicting_content" });
  expect(await world.provider.proveNoEffect(operation, { operationId: operation.operationId, reason: "operator lookup" })).toBe(false);

  world.store.current.clear();
  world.store.put(key, text("changed"), { contentType: "text/plain", metadata: { "factory-identity": identity, "factory-digest": digest("0") } });
  await expect(world.provider.publish(operation)).rejects.toMatchObject({ code: "factory_s3_conflicting_content" });

  world.store.current.clear();
  world.store.put(key, text("first"), { contentType: "text/plain", metadata: {} });
  await expect(world.provider.publish(operation)).rejects.toMatchObject({ code: "factory_s3_conflicting_content" });

  // The same identity and digest but a store that reports no version is not usable either.
  world.store.current.clear();
  world.store.put(key, text("first"), { contentType: "text/plain", metadata: { "factory-identity": identity, "factory-digest": members[0]!.digest } });
  world.store.omitVersions = true;
  await expect(world.provider.publish(operation)).rejects.toMatchObject({ code: "factory_s3_version_missing" });
});

test("changed media, changed bytes, and a lost version are all refused before the manifest", async () => {
  const world = fixture();
  const members = [member(world.reader, "a.txt", [text("first")])];
  const operation = claim({ request: request(members) });
  const identity = factoryS3PublicationIdentity(operation);
  const key = `${DIRECTORY}/a.txt`;

  // A staged object whose media type drifted fails verification rather than publishing.
  world.store.put(key, text("first"), { contentType: "application/json", metadata: { "factory-identity": identity, "factory-digest": members[0]!.digest } });
  await expect(world.provider.publish(operation)).rejects.toMatchObject({ code: "factory_s3_member_unverified" });

  // Bytes that change between the write and the read-back never reach a manifest.
  const changed = fixture();
  member(changed.reader, "a.txt", [text("first")]);
  changed.store.corruptReads = true;
  await expect(changed.provider.publish(operation)).rejects.toMatchObject({ code: "factory_s3_member_unverified" });
  expect(changed.store.current.has(`${DIRECTORY}/${FACTORY_S3_MANIFEST_NAME}`)).toBe(false);

  // A write the store will not version is refused before anything is claimed.
  const unversioned = fixture();
  member(unversioned.reader, "a.txt", [text("first")]);
  unversioned.store.omitVersions = true;
  await expect(unversioned.provider.publish(operation)).rejects.toMatchObject({ code: "factory_s3_version_missing" });
});

test("a member whose chunks do not assemble to its pinned digest is never written", async () => {
  const world = fixture();
  const members = [member(world.reader, "a.txt", [text("first")])];
  const operation = claim({ request: request(members) });
  world.reader.chunks.set(members[0]!.artifact.artifactId, [text("other")]);
  await expect(world.provider.publish(operation)).rejects.toMatchObject({ code: "factory_s3_member_digest_mismatch" });
  expect(world.store.current.size).toBe(0);

  // Too few bytes and too many bytes both fail the same pinned total.
  world.reader.chunks.set(members[0]!.artifact.artifactId, [text("fir")]);
  await expect(world.provider.publish(operation)).rejects.toMatchObject({ code: "factory_s3_member_digest_mismatch" });
  world.reader.chunks.set(members[0]!.artifact.artifactId, [text("first and more")]);
  await expect(world.provider.publish(operation)).rejects.toMatchObject({ code: "factory_s3_member_digest_mismatch" });
  expect(world.store.current.size).toBe(0);
});

test("a member at or above the part size is exported as a real multipart upload", async () => {
  const world = fixture();
  const half = new Uint8Array(FACTORY_S3_PUBLICATION_LIMITS.partBytes / 2).fill(7);
  const tail = new Uint8Array(1024).fill(9);
  const members = [member(world.reader, "large.bin", [half, half, tail], "application/octet-stream")];
  const operation = claim({ request: request(members) });

  const receipt = await world.provider.publish(operation) as FactoryS3ManifestReceipt;

  expect(receipt.files[0]!.encodedBytes).toBe(FACTORY_S3_PUBLICATION_LIMITS.partBytes + 1024);
  expect(world.store.calls.filter(call => call === "UploadPartCommand")).toHaveLength(2);
  expect(world.store.calls).toContain("CompleteMultipartUploadCommand");
  expect(world.store.uploads.size).toBe(0);
  // The multipart ETag is a composite, so the receipt digest cannot have come from it.
  expect(world.store.current.get(receipt.files[0]!.key)!.etag).toContain("-2");
  expect(receipt.files[0]!.digest).toBe(members[0]!.digest);
  expect(await world.provider.verifyReceipt(operation, receipt, { operationId: operation.operationId, reason: "lookup" })).toBe(true);
});

test("a multipart export that cannot complete aborts its upload and writes no object", async () => {
  const half = new Uint8Array(FACTORY_S3_PUBLICATION_LIMITS.partBytes / 2).fill(7);

  const noUpload = fixture();
  const members = [member(noUpload.reader, "large.bin", [half, half], "application/octet-stream")];
  const operation = claim({ request: request(members) });
  noUpload.store.omitUploadId = true;
  await expect(noUpload.provider.publish(operation)).rejects.toMatchObject({ code: "factory_s3_multipart_unavailable" });

  const noPart = fixture();
  member(noPart.reader, "large.bin", [half, half], "application/octet-stream");
  noPart.store.omitPartETag = true;
  await expect(noPart.provider.publish(operation)).rejects.toMatchObject({ code: "factory_s3_multipart_unavailable" });
  expect(noPart.store.uploads.size).toBe(0);

  // A member whose bytes changed under the upload is aborted before it completes.
  const drifted = fixture();
  const large = member(drifted.reader, "large.bin", [half, half], "application/octet-stream");
  drifted.reader.chunks.set(large.artifact.artifactId, [half, Uint8Array.from(half).fill(3)]);
  await expect(drifted.provider.publish(operation)).rejects.toMatchObject({ code: "factory_s3_member_digest_mismatch" });
  expect(drifted.store.current.size).toBe(0);

  // An overlong stream is refused mid-upload, and a refused abort does not mask it.
  const overlong = fixture();
  const big = member(overlong.reader, "large.bin", [half, half], "application/octet-stream");
  overlong.reader.chunks.set(big.artifact.artifactId, [half, half, half]);
  overlong.store.failAbort = true;
  await expect(overlong.provider.publish(claim({ request: request([{ ...big, chunkCount: 3 }]) }))).rejects.toMatchObject({ code: "factory_s3_member_digest_mismatch" });
  expect(overlong.store.current.size).toBe(0);

  // A store that completes without a version, and one that loses the conditional race.
  const unversioned = fixture();
  member(unversioned.reader, "large.bin", [half, half], "application/octet-stream");
  unversioned.store.omitVersions = true;
  await expect(unversioned.provider.publish(operation)).rejects.toMatchObject({ code: "factory_s3_version_missing" });

  const raced = fixture();
  member(raced.reader, "large.bin", [half, half], "application/octet-stream");
  raced.store.put(`${DIRECTORY}/large.bin`, half, { contentType: "application/octet-stream", metadata: { "factory-identity": factoryS3PublicationIdentity(operation), "factory-digest": digest("1") } });
  await expect(raced.provider.publish(operation)).rejects.toMatchObject({ code: "factory_s3_conflicting_content" });
});

test("a manifest race and a lost write response leave the operation uncertain, not published twice", async () => {
  const world = fixture();
  const members = [member(world.reader, "a.txt", [text("first")])];
  const operation = claim({ request: request(members) });

  // Another writer takes the manifest key between the staging and the final write.
  world.store.put(`${DIRECTORY}/${FACTORY_S3_MANIFEST_NAME}`, text("{}"), { contentType: FACTORY_S3_MANIFEST_MEDIA_TYPE });
  await expect(world.provider.publish(operation)).rejects.toMatchObject({ code: "factory_s3_manifest_published" });

  const lost = fixture();
  member(lost.reader, "a.txt", [text("first")]);
  lost.store.losePutResponse = true;
  await expect(lost.provider.publish(operation)).rejects.toThrow("response lost");
  // The object exists, so the next attempt reconciles it rather than writing again.
  lost.store.losePutResponse = false;
  const receipt = await lost.provider.publish(operation) as FactoryS3ManifestReceipt;
  expect(receipt.files[0]!.versionId).toBe("version-1");
  expect(lost.store.versions.size).toBe(2);
});

test("a conditional loss and any other store fault are distinguished on the manifest write", async () => {
  const conflict = fixture();
  const members = [member(conflict.reader, "a.txt", [text("first")])];
  const operation = claim({ request: request(members) });
  // The manifest key appears only after the head check, so the conditional write loses.
  const original = conflict.store.send.bind(conflict.store);
  let staged = false;
  conflict.store.send = async (command: unknown, options?: unknown) => {
    const result = await original(command, options);
    if (!staged && (command as { constructor: { name: string } }).constructor.name === "PutObjectCommand") {
      staged = true;
      conflict.store.put(`${DIRECTORY}/${FACTORY_S3_MANIFEST_NAME}`, text("{}"), { contentType: FACTORY_S3_MANIFEST_MEDIA_TYPE });
    }
    return result;
  };
  await expect(conflict.provider.publish(operation)).rejects.toMatchObject({ code: "factory_s3_version_changed" });

  const broken = fixture();
  member(broken.reader, "a.txt", [text("first")]);
  broken.store.failHeadWith = { name: "ServiceUnavailable", $metadata: { httpStatusCode: 503 } };
  await expect(broken.provider.publish(operation)).rejects.toMatchObject({ name: "ServiceUnavailable" });
});

test("a receipt verifies only against the exact live manifest and its exact file versions", async () => {
  const world = fixture();
  const members = [member(world.reader, "a.txt", [text("first")]), member(world.reader, "b.txt", [text("second")])];
  const operation = claim({ request: request(members) });
  const receipt = await world.provider.publish(operation) as FactoryS3ManifestReceipt;
  const evidence = { operationId: operation.operationId, reason: "verify recorded version" };
  const signal = new AbortController().signal;

  expect(await world.provider.verifyReceipt(operation, receipt, evidence, signal)).toBe(true);
  expect(world.store.lastAbortSignal).toBe(signal);
  for (const forged of [
    { ...receipt, version: "" }, { ...receipt, version: "missing-version" }, { ...receipt, effectDigest: digest("0") },
    { ...receipt, providerReceiptId: "forged-receipt" }, { ...receipt, account: "foreign" }, { ...receipt, bucket: "foreign" },
    { ...receipt, files: receipt.files.slice(0, 1) }, { ...receipt, files: [{ ...receipt.files[0]!, versionId: "version-9" }, receipt.files[1]!] },
    { ...receipt, version: "x".repeat(513) },
  ]) {
    expect(await world.provider.verifyReceipt(operation, forged as FactoryS3ManifestReceipt, evidence)).toBe(false);
  }
  // A receipt for an operation whose request no longer matches the manifest is refused.
  await expect(world.provider.verifyReceipt({ ...operation, requestDigest: digest("9") }, receipt, evidence)).rejects.toMatchObject({ code: "factory_s3_receipt_corrupt" });
  await expect(world.provider.verifyReceipt({ ...operation, dispatchGeneration: 2 }, receipt, evidence)).rejects.toMatchObject({ code: "factory_s3_receipt_corrupt" });

  // A store fault that is not an absence propagates rather than reading as unverified.
  world.store.failHeadWith = { name: "ServiceUnavailable", $metadata: { httpStatusCode: 503 } };
  expect(await world.provider.proveNoEffect(operation, evidence).catch((error: Error) => error.name)).toBe("ServiceUnavailable");
});

test("a doctored manifest cannot rebuild a receipt", async () => {
  const world = fixture();
  const members = [member(world.reader, "a.txt", [text("first")])];
  const operation = claim({ request: request(members) });
  const receipt = await world.provider.publish(operation) as FactoryS3ManifestReceipt;
  const key = receipt.manifestKey;
  const evidence = { operationId: operation.operationId, reason: "verify" };

  /** Restores one publishable directory and returns the file entries a fresh manifest would name. */
  const reset = (): FactoryS3PublishedFile[] => {
    world.store.current.clear();
    world.store.versions.clear();
    return receipt.files.map(file => ({ ...file, versionId: world.store.put(file.key, text("first"), { contentType: file.mediaType }).version }));
  };
  const write = (value: unknown, contentType = FACTORY_S3_MANIFEST_MEDIA_TYPE): string => {
    const bytes = typeof value === "string" ? text(value) : encoder.encode(canonicalJson(value));
    return world.store.put(key, bytes, { contentType }).version;
  };
  const manifest = (files: readonly FactoryS3PublishedFile[]) => ({ schemaVersion: FACTORY_S3_PUBLICATION_MANIFEST_SCHEMA_VERSION, operationId: operation.operationId, dispatchGeneration: 1, requestDigest: operation.requestDigest, files });

  const doctors: ReadonlyArray<(files: readonly FactoryS3PublishedFile[]) => unknown> = [
    () => "not json",
    files => ({ ...manifest(files), schemaVersion: "other" }),
    files => ({ ...manifest(files), files: "not-an-array" }),
    files => ({ ...manifest(files), files: [{ ...files[0]!, encodedBytes: "many" }] }),
    files => ({ ...manifest(files), files: [{ ...files[0]!, versionId: "" }] }),
    files => ({ ...manifest(files), operationId: "other" }),
    files => ({ ...manifest(files), dispatchGeneration: 7 }),
    files => ({ ...manifest(files), requestDigest: digest("7") }),
    () => manifest([]),
    files => ({ ...manifest(files), files: [{ ...files[0]!, name: "other.txt" }] }),
    files => ({ ...manifest(files), files: [{ ...files[0]!, key: "elsewhere/a.txt" }] }),
    files => ({ ...manifest(files), files: [{ ...files[0]!, digest: digest("8") }] }),
    files => ({ ...manifest(files), files: [{ ...files[0]!, mediaType: "application/json" }] }),
    files => ({ ...manifest(files), files: [{ ...files[0]!, encodedBytes: 99 }] }),
    files => ({ ...manifest(files), extra: "field" }),
  ];
  for (const doctor of doctors) {
    const version = write(doctor(reset()));
    await expect(world.provider.verifyReceipt(operation, { ...receipt, version }, evidence)).rejects.toMatchObject({ code: "factory_s3_receipt_corrupt" });
  }
  // A manifest served with another media type, and one served with no readable body.
  const wrongType = write(manifest(reset()), "text/plain");
  await expect(world.provider.verifyReceipt(operation, { ...receipt, version: wrongType }, evidence)).rejects.toMatchObject({ code: "factory_s3_receipt_corrupt" });
  const files = reset();
  const bytes = factoryS3PublicationManifestBytes(operation, files);
  const version = world.store.put(key, bytes, { contentType: FACTORY_S3_MANIFEST_MEDIA_TYPE }).version;
  const restaged: FactoryS3ManifestReceipt = { ...receipt, version, providerReceiptId: `s3:${BUCKET}:${key}:${version}`, effectDigest: sha256(bytes), files };
  world.store.bodyKind = "none";
  await expect(world.provider.verifyReceipt(operation, restaged, evidence)).rejects.toMatchObject({ code: "factory_s3_receipt_unreadable" });
  // A body that only buffers is read the same way a streaming one is.
  world.store.bodyKind = "buffer";
  expect(await world.provider.verifyReceipt(operation, restaged, evidence)).toBe(true);
  // A manifest larger than one chunk bound is refused rather than held.
  reset();
  const huge = write("x".repeat(FACTORY_S3_PUBLICATION_LIMITS.partBytes + 1));
  await expect(world.provider.verifyReceipt(operation, { ...receipt, version: huge }, evidence)).rejects.toMatchObject({ code: "factory_s3_receipt_corrupt" });
  world.store.bodyKind = "stream";
  await expect(world.provider.verifyReceipt(operation, { ...receipt, version: huge }, evidence)).rejects.toMatchObject({ code: "factory_s3_receipt_corrupt" });
});

test("absence is proved only for this operation's own untouched directory", async () => {
  const world = fixture();
  const members = [member(world.reader, "a.txt", [text("first")])];
  const operation = claim({ request: request(members) });
  const evidence = { operationId: operation.operationId, reason: "operator lookup" };

  expect(await world.provider.proveNoEffect(operation, evidence)).toBe(true);
  expect(await world.provider.proveNoEffect(operation, null)).toBe(false);
  expect(await world.provider.proveNoEffect(operation, { operationId: "foreign", reason: "x" })).toBe(false);
  expect(await world.provider.proveNoEffect(operation, { operationId: operation.operationId })).toBe(false);
  expect(await world.provider.proveNoEffect({ ...operation, destination: { ...operation.destination, expectedVersion: "v1" } }, evidence)).toBe(false);

  // A foreign object at a member key keeps the outcome uncertain.
  world.store.put(`${DIRECTORY}/a.txt`, text("foreign"), { contentType: "text/plain", metadata: {} });
  expect(await world.provider.proveNoEffect(operation, evidence)).toBe(false);
});

test("a foreign target, a mutable target, and a malformed request never reach a write", async () => {
  const world = fixture();
  const members = [member(world.reader, "a.txt", [text("first")])];
  const base = claim({ request: request(members) });

  await expect(world.provider.publish({ ...base, destination: { ...base.destination, expectedVersion: "v1" } })).rejects.toMatchObject({ code: "factory_s3_immutable_target" });
  for (const object of ["../escape", "releases//set", "releases/set-a/", "releases/./set", "-leading", ""]) {
    await expect(world.provider.publish({ ...base, destination: { provider: "s3", account: ACCOUNT, object } })).rejects.toMatchObject({ code: "factory_s3_foreign_target" });
  }
  await expect(world.provider.publish({ ...base, destination: { ...base.destination, account: "foreign" } })).rejects.toMatchObject({ code: "factory_s3_foreign_target" });
  await expect(world.provider.publish({ ...base, destination: { ...base.destination, provider: "github" } })).rejects.toMatchObject({ code: "factory_s3_foreign_target" });
  expect(world.store.current.size).toBe(0);
});

test("every publication-request rule is enforced before an operation can be published", () => {
  const valid = request([{ name: "a.txt", mediaType: "text/plain", digest: digest("a"), totalBytes: 5, chunkCount: 1, artifact: { artifactId: "material-a", digest: digest("a"), encodedBytes: 5 } }]);
  expect(assertFactoryS3PublicationRequest(valid, DIRECTORY).members).toHaveLength(1);

  const bad = (value: unknown) => expect(() => assertFactoryS3PublicationRequest(value, DIRECTORY)).toThrow("factory_s3_request_invalid");
  for (const value of [null, "text", [], { ...valid, schemaVersion: "other" }, { ...valid, extra: 1 }]) bad(value);
  for (const materialOperationId of [1, "", "x".repeat(513), "with\0nul"]) bad({ ...valid, materialOperationId });
  for (const candidate of [null, [], { artifactId: "a" }, { artifactId: "a", digest: "bad", encodedBytes: 1 }, { artifactId: "a", digest: digest("a"), encodedBytes: 0 }]) bad({ ...valid, candidate });
  for (const members of [null, [], "list", new Array(FACTORY_S3_PUBLICATION_LIMITS.maxMembers + 1).fill(valid.members[0])]) bad({ ...valid, members });
  for (const member of [null, "entry", {}, { ...valid.members[0], extra: 1 }]) bad({ ...valid, members: [member] });
  for (const name of [1, "", "x".repeat(257), FACTORY_S3_MANIFEST_NAME, "../escape", "./here", "/leading", "trailing/", "with space"]) bad({ ...valid, members: [{ ...valid.members[0]!, name }] });
  bad({ ...valid, members: [valid.members[0]!, valid.members[0]!] });
  bad({ ...valid, members: [{ ...valid.members[0]!, name: "b.txt" }, { ...valid.members[0]!, name: "a.txt" }] });
  for (const mediaType of [1, "", "TEXT/PLAIN", "text"]) bad({ ...valid, members: [{ ...valid.members[0]!, mediaType }] });
  for (const value of [1, "sha1:abc", digest("A")]) bad({ ...valid, members: [{ ...valid.members[0]!, digest: value }] });
  for (const totalBytes of [0, -1, 1.5, FACTORY_S3_PUBLICATION_LIMITS.maxMemberBytes + 1]) bad({ ...valid, members: [{ ...valid.members[0]!, totalBytes }] });
  for (const chunkCount of [0, 1.5, FACTORY_S3_PUBLICATION_LIMITS.maxChunks + 1]) bad({ ...valid, members: [{ ...valid.members[0]!, chunkCount }] });
  bad({ ...valid, members: [{ ...valid.members[0]!, artifact: { artifactId: "", digest: digest("a"), encodedBytes: 1 } }] });
  // A member name that fits on its own but overflows the S3 key under a long directory.
  expect(() => assertFactoryS3PublicationRequest(valid, "d".repeat(1100))).toThrow("factory_s3_request_invalid");
});

test("the operation directory, the staging identity, and the manifest bytes are exact", () => {
  const operation = claim() as FactoryReleaseOperation;
  expect(factoryS3PublicationDirectory(operation.destination, ACCOUNT)).toBe(DIRECTORY);
  expect(factoryS3PublicationDirectory(operation.destination, ACCOUNT, "/published/")).toBe(`published/${DIRECTORY}`);
  expect(factoryS3PublicationIdentity(operation)).toMatch(/^sha256:[a-f0-9]{64}$/);
  // The identity moves with the tenant, the project, the account, the operation, and the request.
  const identities = new Set([
    factoryS3PublicationIdentity(operation),
    factoryS3PublicationIdentity({ ...operation, tenantId: "other" }),
    factoryS3PublicationIdentity({ ...operation, projectId: "other" }),
    factoryS3PublicationIdentity({ ...operation, operationId: "other" }),
    factoryS3PublicationIdentity({ ...operation, requestDigest: digest("9") }),
    factoryS3PublicationIdentity({ ...operation, destination: { ...operation.destination, account: "other" } }),
  ]);
  expect(identities.size).toBe(6);
  const files: FactoryS3PublishedFile[] = [{ name: "a.txt", key: `${DIRECTORY}/a.txt`, mediaType: "text/plain", digest: digest("a"), encodedBytes: 5, versionId: "v1" }];
  expect(JSON.parse(new TextDecoder().decode(factoryS3PublicationManifestBytes(operation, files)))).toEqual({
    schemaVersion: FACTORY_S3_PUBLICATION_MANIFEST_SCHEMA_VERSION, operationId: operation.operationId, dispatchGeneration: 1, requestDigest: operation.requestDigest, files,
  });
});

test("the provider refuses an incomplete configuration and builds one non-retrying client", async () => {
  const reader = new MemoryReader();
  const attempts = { async attemptFor() { return ATTEMPT; } };
  const base = { endpoint: "http://127.0.0.1:18333", bucket: BUCKET, account: ACCOUNT, credentials: { accessKeyId: "id", secretAccessKey: "secret" }, reader, attempts };
  for (const broken of [{ ...base, bucket: "" }, { ...base, account: "" }, { ...base, credentials: { accessKeyId: "", secretAccessKey: "s" } }, { ...base, credentials: { accessKeyId: "id", secretAccessKey: "" } }]) {
    expect(() => new S3FactoryManifestReleaseProvider(broken)).toThrow("factory_s3_configuration_invalid");
  }
  const provider = new S3FactoryManifestReleaseProvider(base);
  expect(await (provider as unknown as { client: { config: { maxAttempts(): Promise<number> } } }).client.config.maxAttempts()).toBe(1);
});

test("a cancelled publication stops reading chunks and writes nothing further", async () => {
  const world = fixture();
  const half = new Uint8Array(FACTORY_S3_PUBLICATION_LIMITS.partBytes / 2).fill(7);
  const members = [member(world.reader, "large.bin", [half, half, half], "application/octet-stream")];
  const operation = claim({ request: request(members) });
  const controller = new AbortController();
  const original = world.reader.readChunk.bind(world.reader);
  world.reader.readChunk = async (scope, reference, index) => {
    if (index === 1) controller.abort();
    return original(scope, reference, index);
  };
  await expect(world.provider.publish(operation, controller.signal)).rejects.toThrow();
  expect(world.store.current.has(`${DIRECTORY}/large.bin`)).toBe(false);
  expect(world.store.uploads.size).toBe(0);
});

test("the live directory describes the publication it actually holds, and nothing more", async () => {
  const world = fixture();
  const members = [member(world.reader, "a.txt", [text("first")])];
  const operation = claim({ request: request(members) });

  expect(await world.provider.describePublication(operation)).toBeNull();
  const receipt = await world.provider.publish(operation) as FactoryS3ManifestReceipt;
  expect(canonicalJson(await world.provider.describePublication(operation))).toBe(canonicalJson(receipt));
  // A store that will not name the manifest's version supports no receipt at all.
  world.store.omitVersions = true;
  await expect(world.provider.describePublication(operation)).rejects.toMatchObject({ code: "factory_s3_version_missing" });
});
