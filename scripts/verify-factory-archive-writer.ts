#!/usr/bin/env bun
/**
 * W04a access-restriction and publication-readiness proof against the real
 * local SeaweedFS services.
 *
 * What this proves: the archive-writer role's conditional create, checksum,
 * version read, and inventory work on a real S3 service for all ten generated
 * tenant identities; no product or restore credential can read, overwrite, or
 * delete an archive object; and the archive keeps answering while the ordinary
 * product service is stopped, during which a real release provider cannot
 * verify a receipt, so product settlement waits.
 *
 * What this does NOT prove: an independent deployed failure domain. Both
 * services run on this host, so the result records
 * `failureDomain: "same-host-not-independent"` and carries the unmet criterion
 * by name. Separate volumes and separate credential files are credential
 * separation and nothing more.
 *
 * The member path (archiving every candidate, evidence, and request object
 * through W04's scoped reader) is proved against these same services by
 * `tests/postgres/factory-archive-writer.test.ts`, which has a database.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { canonicalJson } from "@ezcorp/extension-contract";
import { S3BlobStore } from "../src/extensions/v4/blobs";
import {
  FACTORY_ARCHIVE_DEPLOYED_INDEPENDENCE,
  FactoryArchiveWriter,
  S3FactoryArchiveInventory,
  factoryArchiveFailureDomain,
  type FactoryArchiveDenialAttempt,
} from "../src/factory/archive-writer";
import { S3FactoryReleaseArchive, S3FactoryReleaseProvider } from "../src/factory/release-adapters";
import type { FactoryReleaseClaim } from "../src/factory/releases";

interface CredentialEntry { readonly name: string; readonly credentials: readonly [{ readonly accessKey: string; readonly secretKey: string }] }
interface CredentialConfig { readonly identities: readonly CredentialEntry[] }
type Kind = "ordinary" | "archive";

const secretsDir = process.env.EZCORP_FACTORY_STORAGE_SECRETS_DIR;
if (!secretsDir) throw new Error("EZCORP_FACTORY_STORAGE_SECRETS_DIR is required. Run scripts/setup-factory-storage.sh up first.");
const endpoints: Record<Kind, string> = {
  ordinary: process.env.EZCORP_FACTORY_STORAGE_ORDINARY_S3_ENDPOINT ?? `http://127.0.0.1:${process.env.EZCORP_FACTORY_STORAGE_ORDINARY_S3_PORT ?? "18333"}`,
  archive: process.env.EZCORP_FACTORY_STORAGE_ARCHIVE_S3_ENDPOINT ?? `http://127.0.0.1:${process.env.EZCORP_FACTORY_STORAGE_ARCHIVE_S3_PORT ?? "18334"}`,
};
const outputPath = process.env.FACTORY_ARCHIVE_WRITER_PROOF_OUTPUT ?? "/tmp/factory-platform-evidence/w04a/archive-writer-real.json";

const config = async (kind: Kind): Promise<CredentialConfig> => Bun.file(`${secretsDir}/${kind}.json`).json() as Promise<CredentialConfig>;
const sets = { ordinary: await config("ordinary"), archive: await config("archive") };
if (sets.ordinary.identities.length !== 10 || sets.archive.identities.length !== 10) throw new Error("The proof requires exactly ten scoped identities in each credential set.");

const credentialsOf = (entry: CredentialEntry) => ({ accessKeyId: entry.credentials[0].accessKey, secretAccessKey: entry.credentials[0].secretKey });
const clientFor = (kind: Kind, entry: CredentialEntry) => new S3Client({ endpoint: endpoints[kind], region: "us-east-1", forcePathStyle: true, credentials: credentialsOf(entry), maxAttempts: 1 });
const bytesOf = (value: unknown) => new TextEncoder().encode(canonicalJson(value));
const base64Sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("base64");
const sameBytes = (left: Uint8Array, right: Uint8Array) => left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
const clients: S3Client[] = [];
const refusalStatuses = new Map<number, number>();
const track = <Value extends S3Client>(client: Value): Value => { clients.push(client); return client; };

/** A denial is any refusal that keeps the caller from reaching the object. */
async function denied(action: () => Promise<unknown>): Promise<number | "permitted"> {
  try { await action(); }
  catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 401 || status === 403 || status === 404) { refusalStatuses.set(status, (refusalStatuses.get(status) ?? 0) + 1); return status; }
    throw error;
  }
  return "permitted";
}

const compose = async (args: readonly string[]): Promise<void> => {
  const child = Bun.spawn(["docker", "compose", "-f", "compose.factory-storage.local.yml", "--profile", "factory-storage", ...args], {
    cwd: resolve(import.meta.dir, ".."),
    env: { ...process.env, COMPOSE_PROJECT_NAME: `ezcorp-factory-storage-${process.getuid?.() ?? "local"}` },
    stdout: "ignore", stderr: "ignore",
  });
  if (await child.exited !== 0) throw new Error(`Local SeaweedFS command failed: ${args.join(" ")}`);
};

const waitForRead = async (read: () => Promise<unknown>): Promise<void> => {
  let last: unknown;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    try { await read(); return; }
    catch (error) { last = error; }
    await Bun.sleep(250);
  }
  throw new Error(`The ordinary store never returned after its restart: ${(last as Error).name}`);
};

const failureDomain = factoryArchiveFailureDomain({
  productEndpoint: endpoints.ordinary, archiveEndpoint: endpoints.archive,
  productCredentialSet: "ordinary.json", archiveCredentialSet: "archive.json",
});
if (failureDomain.failureDomain !== "same-host-not-independent") throw new Error(`This host must classify as same-host-not-independent, not ${failureDomain.failureDomain}.`);

const stamp = `${Date.now()}-${randomUUID()}`;
const tenantResults: Array<Record<string, unknown>> = [];
let readinessPasses = 0;
let denials = 0;

for (const [index, archiveIdentity] of sets.archive.identities.entries()) {
  const ordinaryIdentity = sets.ordinary.identities[index]!;
  if (ordinaryIdentity.name !== archiveIdentity.name) throw new Error("The ordinary and archive identity order differs.");
  const tenant = archiveIdentity.name;
  const root = `archive/w04a-archive-writer/${stamp}/${index}`;
  const operationId = `factory-release:${createHash("sha256").update(`${stamp}:${tenant}`).digest("hex")}`;
  const archiveClient = track(clientFor("archive", archiveIdentity));
  const archive = new S3FactoryReleaseArchive({ endpoint: endpoints.archive, bucket: tenant, prefix: root, credentials: credentialsOf(archiveIdentity), client: archiveClient });
  const inventory = new S3FactoryArchiveInventory({ endpoint: endpoints.archive, bucket: tenant, root, credentials: credentialsOf(archiveIdentity), client: archiveClient });

  // Conditional create, checksum verification, and an exact version read.
  const intent = bytesOf({ purpose: "w04a-archive-writer", tenant, operationId, stamp });
  const object = await archive.writeImmutable(tenant, operationId, "intent", intent);
  if (!sameBytes(intent, await archive.read(object))) throw new Error(`${tenant}: the archive returned different intent bytes.`);
  const repeat = await archive.writeImmutable(tenant, operationId, "intent", intent);
  if (repeat.key !== object.key || repeat.versionId !== object.versionId) throw new Error(`${tenant}: a conditional create produced a second archive version.`);
  const head = await archiveClient.send(new HeadObjectCommand({ Bucket: tenant, Key: object.key, ChecksumMode: "ENABLED" })) as { ChecksumSHA256?: string };
  if (head.ChecksumSHA256 !== base64Sha(intent)) throw new Error(`${tenant}: the archive checksum does not match the written bytes.`);

  const receiptBytes = bytesOf({ purpose: "w04a-archive-receipt", tenant, operationId, stamp });
  const receiptObject = await archive.writeImmutable(tenant, operationId, "receipt", receiptBytes);
  if (!sameBytes(receiptBytes, await archive.read(receiptObject))) throw new Error(`${tenant}: the archive returned different receipt bytes.`);

  // The inventory finds what the operation holds, from a key it read rather than built.
  const operationPrefix = object.key.replace(/\/[0-9a-f]{64}$/, "");
  const listed = await inventory.list(operationPrefix);
  if (!listed.some(entry => entry.key === object.key && entry.digest === object.digest)) throw new Error(`${tenant}: the archive inventory did not list the operation's intent.`);

  // Neither the product nor the restore credential set reaches the archive.
  // This profile mints no separate restore identity: a restore runs with the
  // product credential set plus the database backups, so both probes use it.
  const probeClients: Record<"product" | "restore", S3Client> = { product: track(clientFor("archive", ordinaryIdentity)), restore: track(clientFor("archive", ordinaryIdentity)) };
  const attemptDenial = async (attempt: FactoryArchiveDenialAttempt): Promise<"denied" | "permitted"> => {
    const client = probeClients[attempt.credentialSet];
    const key = attempt.object.key;
    const verdict = await denied(() => client.send(
      attempt.operation === "read" ? new GetObjectCommand({ Bucket: tenant, Key: key })
        : attempt.operation === "overwrite" ? new PutObjectCommand({ Bucket: tenant, Key: key, Body: bytesOf({ overwritten: true }) })
          : new DeleteObjectCommand({ Bucket: tenant, Key: key }),
    ));
    if (verdict === "permitted") return "permitted";
    denials += 1;
    return "denied";
  };
  for (const credentialSet of ["product", "restore"] as const) {
    for (const operation of ["read", "overwrite", "delete"] as const) {
      if (await attemptDenial({ credentialSet, operation, object }) !== "denied") throw new Error(`${tenant}: ${credentialSet} credentials were permitted to ${operation} an archive object.`);
    }
  }
  // A foreign tenant's archive credential cannot reach this tenant's object.
  const foreign = sets.archive.identities[(index + 1) % sets.archive.identities.length]!;
  if (await denied(() => track(clientFor("archive", foreign)).send(new GetObjectCommand({ Bucket: tenant, Key: object.key }))) === "permitted") throw new Error(`${tenant}: ${foreign.name}'s archive credential read this tenant's object.`);
  denials += 1;
  // The object is still exactly what was written after every refused attempt.
  if (!sameBytes(intent, await archive.read(object))) throw new Error(`${tenant}: the archive object changed after the refused attempts.`);

  const writer = new FactoryArchiveWriter({
    archive, inventory, failureDomain,
    reader: { async read() { throw new Error("this proof archives no members; the PostgreSQL suite covers that path"); }, async readChunk() { throw new Error("unused"); } },
    publicationSet: { async plan() { return []; } },
    denialProbe: { attempt: attemptDenial },
  });
  const readiness = await writer.checkReadiness(tenant, operationId);
  if (!readiness.ready || readiness.publicationGrade || canonicalJson(readiness.unmetCriteria) !== canonicalJson([FACTORY_ARCHIVE_DEPLOYED_INDEPENDENCE])) {
    throw new Error(`${tenant}: readiness was ${canonicalJson({ ready: readiness.ready, publicationGrade: readiness.publicationGrade, unmetCriteria: readiness.unmetCriteria })}`);
  }
  readinessPasses += 1;
  tenantResults.push({ tenant, archivedObjects: 2, inventoryEntries: listed.length, readinessChecks: readiness.checks.length, ready: readiness.ready, publicationGrade: readiness.publicationGrade });
}

// The archive answers while the ordinary product service is stopped, and a real
// release provider cannot verify its receipt until that service returns.
const tenant = "tenant-01";
const ordinaryIdentity = sets.ordinary.identities[0]!;
const archiveIdentity = sets.archive.identities[0]!;
const ordinaryClient = track(clientFor("ordinary", ordinaryIdentity));
const ordinaryStore = new S3BlobStore({ endpoint: endpoints.ordinary, bucket: tenant, prefix: `ordinary/w04a-archive-writer/${stamp}`, credentials: credentialsOf(ordinaryIdentity), client: ordinaryClient });
const productBytes = bytesOf({ purpose: "w04a-product-object", stamp });
const productDigest = await ordinaryStore.put(productBytes);

const lossRoot = `archive/w04a-archive-writer/${stamp}/loss`;
const lossClient = track(clientFor("archive", archiveIdentity));
const lossArchive = new S3FactoryReleaseArchive({ endpoint: endpoints.archive, bucket: tenant, prefix: lossRoot, credentials: credentialsOf(archiveIdentity), client: lossClient });
const lossWriter = new FactoryArchiveWriter({
  archive: lossArchive, failureDomain,
  inventory: new S3FactoryArchiveInventory({ endpoint: endpoints.archive, bucket: tenant, root: lossRoot, credentials: credentialsOf(archiveIdentity), client: lossClient }),
  reader: { async read() { throw new Error("unused"); }, async readChunk() { throw new Error("unused"); } },
  publicationSet: { async plan() { return []; } },
});
const lossOperationId = `factory-release:${createHash("sha256").update(`${stamp}:loss`).digest("hex")}`;
const beforeLoss = await lossArchive.writeImmutable(tenant, lossOperationId, "intent", productBytes);

const publishedObject = `ordinary/w04a-archive-writer/${stamp}/published.json`;
const provider = new S3FactoryReleaseProvider({ endpoint: endpoints.ordinary, bucket: tenant, account: tenant, credentials: credentialsOf(ordinaryIdentity) });
const sha = (letter: string) => `sha256:${letter.repeat(64)}`;
const claim = {
  tenantId: tenant, projectId: "proof", operationId: lossOperationId, runId: "proof", nodeInstanceId: "release", candidateGeneration: 1,
  candidateDigest: sha("a"), decisionId: "proof", contractDigest: sha("b"), executionEpoch: 1, cancellationEpoch: 0, releaseEnableEpoch: 1,
  action: "publish", destination: { provider: "s3", account: tenant, object: publishedObject },
  request: { bytesBase64: Buffer.from(productBytes).toString("base64") }, destinationDigest: sha("c"), requestDigest: sha("d"),
  material: { decisionId: "proof", evidence: [{}], packageTrustDigest: sha("e"), validatorTrustDigest: sha("f") }, materialDigest: sha("a"),
  estimatedSpendMicros: 0, deadlineMs: Date.now() + 600_000, state: "executing", dispatchGeneration: 1, dispatchStarted: true,
  senderToken: "proof", archiveReady: true, authority: { kind: "approval", id: "proof" },
} satisfies FactoryReleaseClaim;
const receipt = await provider.publish(claim);
if (!await provider.verifyReceipt(claim, receipt, { operationId: lossOperationId, reason: "before the outage" })) throw new Error("The provider did not verify its own receipt before the outage.");

const reachable = async (): Promise<boolean> => { try { await ordinaryStore.get(productDigest); return true; } catch { return false; } };
let loss: Record<string, unknown>;
await compose(["stop", "factory-storage-ordinary"]);
try {
  if (await reachable()) throw new Error("The ordinary store answered after it was stopped.");
  const independence = await lossWriter.proveIndependentOfProductStore({ reachable }, tenant, lossOperationId);
  if (!independence.passed) throw new Error(`The archive did not answer while the ordinary store was down: ${independence.detail}`);
  if (!sameBytes(productBytes, await lossArchive.read(beforeLoss))) throw new Error("The archive returned different bytes while the ordinary store was down.");
  const settlement = await provider.verifyReceipt(claim, receipt, { operationId: lossOperationId, reason: "during the outage" })
    .then(() => "verified" as const, (error: Error) => `${error.name}: ${((error as { code?: string }).code ?? error.message).slice(0, 120)}`);
  if (settlement === "verified") throw new Error("The provider verified a receipt while its object store was stopped.");
  loss = { archiveReadableWhileProductStoreDown: true, productSettlementBlockedWith: settlement };
} finally {
  await compose(["up", "-d", "--wait", "factory-storage-ordinary"]);
  await waitForRead(() => ordinaryStore.get(productDigest));
}
if (!await provider.verifyReceipt(claim, receipt, { operationId: lossOperationId, reason: "after the outage" })) throw new Error("The provider did not verify its receipt after the ordinary store returned.");
loss.productSettlementResumed = true;

for (const client of clients) client.destroy();

const result = {
  testedAt: new Date().toISOString(),
  tenants: tenantResults.length,
  readinessPasses,
  refusedAttempts: denials,
  refusalStatuses: Object.fromEntries([...refusalStatuses].sort(([left], [right]) => left - right)),
  endpoints: [new URL(endpoints.ordinary).host, new URL(endpoints.archive).host],
  failureDomain: failureDomain.failureDomain,
  unmetCriteria: failureDomain.unmetCriteria,
  credentialsSeparated: failureDomain.credentialsSeparated,
  deployedIndependenceProven: failureDomain.deployedIndependenceProven,
  restoreCredentialNote: "this profile mints no separate restore identity; a restore runs with the product credential set, which both denial probes use",
  ordinaryStoreLoss: loss,
  perTenant: tenantResults,
};
await mkdir(dirname(outputPath), { recursive: true });
await Bun.write(outputPath, `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ...result, perTenant: undefined, receipt: outputPath })}\n`);
