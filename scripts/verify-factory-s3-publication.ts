#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { FactoryArtifactReference } from "@ezcorp/factory-sdk";
import type { FactoryMaterialScope, FactoryScopedArtifactReader } from "../src/factory/artifact-materials";
import type { S3ClientLike } from "../src/factory/release-adapters";
import { FACTORY_S3_MANIFEST_NAME, FACTORY_S3_PUBLICATION_REQUEST_SCHEMA_VERSION, S3FactoryManifestReleaseProvider, type FactoryS3ManifestReceipt, type FactoryS3PublicationSetRequest } from "../src/factory/release-s3-publication";
import type { FactoryReleaseClaim } from "../src/factory/releases";

/**
 * Measures tenant isolation for the S3 publication set on the real local store.
 *
 * Every one of the ten generated tenant identities publishes an approved set
 * into its own bucket, verifies its own receipt, refuses four fabricated ones,
 * and is then denied on every neighbouring tenant's objects. The denial statuses
 * are recorded rather than assumed, so the receipt says what the service
 * actually answered.
 *
 * What this script does NOT prove, stated in its own receipt fields: the
 * database-backed attempt provenance and the archive-before-claim order. Those
 * run against real PostgreSQL in `tests/postgres/factory-s3-publication.test.ts`;
 * here the scoped reader and the attempt source are in-script stubs so the
 * subject is the store's authorization behaviour alone.
 */

interface CredentialEntry {
  readonly name: string;
  readonly credentials: readonly [{ readonly accessKey: string; readonly secretKey: string }];
}
interface CredentialConfig { readonly identities: readonly CredentialEntry[] }

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const configPath = requiredEnvironment("FACTORY_RELEASE_S3_ORDINARY_CONFIG");
const archivePath = requiredEnvironment("FACTORY_RELEASE_S3_ARCHIVE_CONFIG");
const endpoint = process.env.FACTORY_RELEASE_S3_ORDINARY_ENDPOINT ?? "http://127.0.0.1:18333";
const outputPath = process.env.FACTORY_S3_PUBLICATION_PROOF_OUTPUT ?? "/tmp/factory-platform-evidence/w08/publication-s3-real.json";

const credentials = (entry: CredentialEntry) => ({ accessKeyId: entry.credentials[0].accessKey, secretAccessKey: entry.credentials[0].secretKey });
const sha = (letter: string): string => `sha256:${letter.repeat(64)}`;
const sha256 = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const encoder = new TextEncoder();

const ordinary = JSON.parse(await readFile(configPath, "utf8")) as CredentialConfig;
const archive = JSON.parse(await readFile(archivePath, "utf8")) as CredentialConfig;
if (ordinary.identities.length !== 10 || archive.identities.length !== 10) throw new Error("The proof requires exactly ten scoped identities in each credential set.");

/** Serves member bytes from memory, so this script measures the store, not W04. */
class StubReader implements FactoryScopedArtifactReader {
  constructor(private readonly chunks: ReadonlyMap<string, readonly Uint8Array[]>) {}
  async read(_scope: FactoryMaterialScope, reference: FactoryArtifactReference): Promise<Uint8Array> {
    return (this.chunks.get(reference.artifactId) ?? [])[0]!;
  }
  async readChunk(_scope: FactoryMaterialScope, reference: FactoryArtifactReference, index: number): Promise<Uint8Array> {
    const parts = this.chunks.get(reference.artifactId);
    if (!parts || index >= parts.length) throw new Error("no such chunk");
    return parts[index]!;
  }
}

const stamp = `${Date.now()}-${crypto.randomUUID()}`;
const publications: Array<{ tenant: string; key: string; manifestKey: string }> = [];
let verifiedReceipts = 0;
let rejectedReceipts = 0;
let publishedFiles = 0;

for (const [index, identity] of ordinary.identities.entries()) {
  const tenantId = identity.name;
  const client = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials: credentials(identity), maxAttempts: 1 });
  const first = encoder.encode(`tenant ${tenantId} part one\n`);
  const second = encoder.encode(`tenant ${tenantId} part two\n`);
  const chunks = new Map<string, readonly Uint8Array[]>([["material-a", [first]], ["material-b", [second]]]);
  const reference = (artifactId: string, bytes: Uint8Array): FactoryArtifactReference => ({ artifactId, digest: sha256(bytes), encodedBytes: bytes.byteLength });
  const request: FactoryS3PublicationSetRequest = {
    schemaVersion: FACTORY_S3_PUBLICATION_REQUEST_SCHEMA_VERSION,
    materialOperationId: `proof:${stamp}:${index}`,
    candidate: reference("material-a", first),
    members: [
      { name: "data/part-0.txt", mediaType: "text/plain", digest: sha256(first), totalBytes: first.byteLength, chunkCount: 1, artifact: reference("material-a", first) },
      { name: "data/part-1.txt", mediaType: "text/plain", digest: sha256(second), totalBytes: second.byteLength, chunkCount: 1, artifact: reference("material-b", second) },
    ],
  };
  const object = `ordinary/publication-proof/${stamp}/${index}`;
  const operationId = `factory-release:${createHash("sha256").update(`${stamp}:${index}`).digest("hex")}`;
  const claim = {
    tenantId, projectId: "proof", operationId, runId: "proof", nodeInstanceId: "release", candidateGeneration: 1,
    candidateDigest: sha("a"), decisionId: "proof", contractDigest: sha("b"), executionEpoch: 1, cancellationEpoch: 0,
    releaseEnableEpoch: 1, action: "publish-manifest", destination: { provider: "s3", account: tenantId, object },
    request: request as unknown as FactoryReleaseClaim["request"],
    destinationDigest: sha("c"), requestDigest: sha("d"),
    material: { decisionId: "proof", evidence: [{}], packageTrustDigest: sha("e"), validatorTrustDigest: sha("f") },
    materialDigest: sha("a"), estimatedSpendMicros: 0, deadlineMs: Date.now() + 600_000, state: "executing",
    dispatchGeneration: 1, dispatchStarted: true, senderToken: "proof", archiveReady: true, authority: { kind: "approval", id: "proof" },
  } satisfies FactoryReleaseClaim;

  const provider = new S3FactoryManifestReleaseProvider({
    endpoint, bucket: tenantId, account: tenantId, credentials: credentials(identity),
    client: client as unknown as S3ClientLike, reader: new StubReader(chunks),
    attempts: { async attemptFor() { return `verified-attempt-${index}`; } },
  });

  const receipt = await provider.publish(claim) as FactoryS3ManifestReceipt;
  if (receipt.operationId !== operationId || receipt.files.length !== 2 || receipt.manifestKey !== `${object}/${FACTORY_S3_MANIFEST_NAME}`) throw new Error("The publication receipt does not match its operation.");
  for (const file of receipt.files) {
    if (!file.versionId || !/^sha256:[a-f0-9]{64}$/.test(file.digest)) throw new Error("A published file has no version or no content digest.");
    publishedFiles += 1;
  }
  const evidence = { operationId, reason: "actual provider lookup" };
  if (!await provider.verifyReceipt(claim, receipt, evidence)) throw new Error("The provider did not verify its exact publication receipt.");
  verifiedReceipts += 1;
  for (const forged of [
    { ...receipt, version: "missing-version" },
    { ...receipt, effectDigest: sha("0") },
    { ...receipt, providerReceiptId: "forged-receipt" },
    { ...receipt, files: [receipt.files[0]!] },
  ]) {
    if (await provider.verifyReceipt(claim, forged, evidence).catch(() => false)) throw new Error("The provider accepted a fabricated receipt.");
    rejectedReceipts += 1;
  }
  // A second publication of the same confirmed set is refused, not repeated.
  const repeated = await provider.publish(claim).then(() => "PUBLISHED", (error: { code?: string }) => error.code);
  if (repeated !== "factory_s3_manifest_published") throw new Error(`A confirmed publication was repeated: ${repeated}`);
  publications.push({ tenant: tenantId, key: receipt.files[0]!.key, manifestKey: receipt.manifestKey });
  client.destroy();
}

const statuses: Record<string, number> = {};
let deniedAttempts = 0;

/** One cross-credential attempt, recorded by the status the service answered. */
async function expectDenied(entry: CredentialEntry, bucket: string, key: string, action: "read" | "overwrite" | "delete"): Promise<void> {
  const client = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials: credentials(entry), maxAttempts: 1 });
  const command = action === "read" ? new GetObjectCommand({ Bucket: bucket, Key: key })
    : action === "overwrite" ? new PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.from("foreign overwrite") })
      : new DeleteObjectCommand({ Bucket: bucket, Key: key });
  try {
    await client.send(command);
    throw new Error(`A foreign credential completed a ${action} on ${bucket}.`);
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === undefined) throw error;
    statuses[String(status)] = (statuses[String(status)] ?? 0) + 1;
    deniedAttempts += 1;
  } finally {
    client.destroy();
  }
}

for (const [index, published] of publications.entries()) {
  const neighbour = ordinary.identities[(index + 1) % ordinary.identities.length]!;
  const archiveIdentity = archive.identities[index]!;
  for (const action of ["read", "overwrite", "delete"] as const) {
    await expectDenied(neighbour, published.tenant, published.key, action);
    await expectDenied(neighbour, published.tenant, published.manifestKey, action);
  }
  // The archive credential set is not a publication credential either.
  await expectDenied(archiveIdentity, published.tenant, published.manifestKey, "read");
}

// Each tenant still reads its own manifest, so the denials are scope, not outage.
let selfReads = 0;
for (const [index, published] of publications.entries()) {
  const client = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials: credentials(ordinary.identities[index]!), maxAttempts: 1 });
  const head = await client.send(new HeadObjectCommand({ Bucket: published.tenant, Key: published.manifestKey })) as { VersionId?: string };
  if (!head.VersionId) throw new Error("A tenant's own manifest has no object version.");
  selfReads += 1;
  client.destroy();
}

const result = {
  testedAt: new Date().toISOString(),
  tenants: ordinary.identities.length,
  publications: publications.length,
  publishedFiles,
  verifiedReceipts,
  rejectedReceipts,
  repeatedPublicationsRefused: publications.length,
  crossTenantAttempts: deniedAttempts,
  crossTenantDenialStatuses: statuses,
  selfReads,
  endpoint: new URL(endpoint).host,
  failureDomain: "same-host-not-independent",
  provenanceSource: "in-script stub; the database-backed attempt provenance runs in tests/postgres/factory-s3-publication.test.ts",
  archiveOrder: "not exercised here; archive-before-claim and receipt-before-settlement run in the PostgreSQL suite",
};
await mkdir(dirname(outputPath), { recursive: true });
await Bun.write(outputPath, JSON.stringify(result, null, 2));
process.stdout.write(JSON.stringify({ ...result, receipt: outputPath }));
