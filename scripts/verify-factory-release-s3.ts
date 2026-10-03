#!/usr/bin/env bun
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { S3FactoryReleaseArchive, S3FactoryReleaseProvider } from "../src/factory/release-adapters";
import type { FactoryReleaseClaim } from "../src/factory/releases";

interface CredentialEntry {
  readonly name: string;
  readonly credentials: readonly [{ readonly accessKey: string; readonly secretKey: string }];
}

interface CredentialConfig {
  readonly identities: readonly CredentialEntry[];
}

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};

const parseConfig = async (path: string): Promise<CredentialConfig> => JSON.parse(await readFile(path, "utf8")) as CredentialConfig;
const credentials = (entry: CredentialEntry) => ({ accessKeyId: entry.credentials[0].accessKey, secretAccessKey: entry.credentials[0].secretKey });
const sha = (letter: string): string => `sha256:${letter.repeat(64)}`;

const ordinaryPath = requiredEnvironment("FACTORY_RELEASE_S3_ORDINARY_CONFIG");
const archivePath = requiredEnvironment("FACTORY_RELEASE_S3_ARCHIVE_CONFIG");
const ordinaryEndpoint = process.env.FACTORY_RELEASE_S3_ORDINARY_ENDPOINT ?? "http://127.0.0.1:18333";
const archiveEndpoint = process.env.FACTORY_RELEASE_S3_ARCHIVE_ENDPOINT ?? "http://127.0.0.1:18334";
const outputPath = process.env.FACTORY_RELEASE_S3_PROOF_OUTPUT ?? "/tmp/factory-platform-evidence/release-s3-real.json";
const ordinary = await parseConfig(ordinaryPath);
const archive = await parseConfig(archivePath);
if (ordinary.identities.length !== 10 || archive.identities.length !== 10) throw new Error("The proof requires exactly ten scoped identities in each credential set.");

let verifiedReceipts = 0;
let rejectedReceipts = 0;
const stamp = `${Date.now()}-${crypto.randomUUID()}`;
for (let index = 0; index < ordinary.identities.length; index += 1) {
  const ordinaryIdentity = ordinary.identities[index]!;
  const archiveIdentity = archive.identities[index]!;
  if (ordinaryIdentity.name !== archiveIdentity.name) throw new Error("The ordinary and archive identity order differs.");
  const tenantId = ordinaryIdentity.name;
  const operationId = `factory-release-${stamp}-${index}`;
  const object = `ordinary/release-proof/${stamp}/${index}.txt`;
  const request = { bytesBase64: Buffer.from(`tenant release ${index}`).toString("base64") };
  const claim = {
    tenantId, projectId: "proof", operationId, runId: "proof", nodeInstanceId: "release", candidateGeneration: 1,
    candidateDigest: sha("a"), decisionId: "proof", contractDigest: sha("b"), executionEpoch: 1, cancellationEpoch: 0,
    releaseEnableEpoch: 1, action: "publish", destination: { provider: "s3", account: tenantId, object }, request,
    destinationDigest: sha("c"), requestDigest: sha("d"), material: { decisionId: "proof", evidence: [{}], packageTrustDigest: sha("e"), validatorTrustDigest: sha("f") },
    materialDigest: sha("a"), estimatedSpendMicros: 0, deadlineMs: Date.now() + 60_000, state: "executing",
    dispatchGeneration: 1, dispatchStarted: true, senderToken: "proof", archiveReady: true, authority: { kind: "approval", id: "proof" },
  } satisfies FactoryReleaseClaim;
  const provider = new S3FactoryReleaseProvider({ endpoint: ordinaryEndpoint, bucket: tenantId, account: tenantId, credentials: credentials(ordinaryIdentity) });
  const receipt = await provider.publish(claim);
  if (receipt.operationId !== operationId || receipt.object !== object || !receipt.version) throw new Error("The publication receipt does not match its operation.");
  const evidence = { operationId, reason: "actual provider lookup" };
  if (!await provider.verifyReceipt(claim, receipt, evidence)) throw new Error("The provider did not verify its exact publication receipt.");
  verifiedReceipts += 1;
  for (const forged of [{ ...receipt, version: "missing-version" }, { ...receipt, effectDigest: sha("0") }, { ...receipt, providerReceiptId: "forged-receipt" }, { ...receipt, account: "foreign" }]) {
    if (await provider.verifyReceipt(claim, forged, evidence)) throw new Error("The provider accepted a fabricated receipt.");
    rejectedReceipts += 1;
  }
  const store = new S3FactoryReleaseArchive({ endpoint: archiveEndpoint, bucket: tenantId, prefix: "archive/release-archive-proof", credentials: credentials(archiveIdentity) });
  const bytes = new TextEncoder().encode(JSON.stringify({ operationId, receipt }));
  const reference = await store.writeImmutable(tenantId, operationId, "receipt", bytes);
  const restored = await store.read(reference);
  if (restored.byteLength !== bytes.byteLength || !restored.every((value, offset) => value === bytes[offset])) throw new Error("The archive did not return the exact receipt bytes.");
}

const expectForeignDenial = async (endpoint: string, bucket: string, identity: CredentialEntry, key: string): Promise<void> => {
  const client = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials: credentials(identity), maxAttempts: 1 });
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 401 || status === 403 || status === 404) return;
    throw error;
  }
  throw new Error("A foreign credential reached the target.");
};

await expectForeignDenial(ordinaryEndpoint, "tenant-01", ordinary.identities[1]!, `ordinary/release-proof/${stamp}/0.txt`);
await expectForeignDenial(archiveEndpoint, "tenant-01", ordinary.identities[0]!, "archive/release-archive-proof/foreign");
await expectForeignDenial(ordinaryEndpoint, "tenant-01", archive.identities[0]!, `ordinary/release-proof/${stamp}/0.txt`);

const result = {
  testedAt: new Date().toISOString(), tenants: 10, publications: 10, archives: 10, foreignDenials: 3, versionedReceipts: true, verifiedReceipts, rejectedReceipts,
  endpoints: [new URL(ordinaryEndpoint).host, new URL(archiveEndpoint).host], failureDomain: "same-host-not-independent",
};
await mkdir(dirname(outputPath), { recursive: true });
await Bun.write(outputPath, JSON.stringify(result));
process.stdout.write(JSON.stringify({ ...result, receipt: outputPath }));
