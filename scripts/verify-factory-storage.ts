import { createHash, randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, ListObjectVersionsCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { S3BlobStore } from "../src/extensions/v4/blobs";

interface Identity { name: string; credentials: Array<{ accessKey: string; secretKey: string }> }
interface S3Config { identities: Identity[] }

const secretsDir = process.env.EZCORP_FACTORY_STORAGE_SECRETS_DIR;
if (!secretsDir) throw new Error("EZCORP_FACTORY_STORAGE_SECRETS_DIR is required. Run scripts/setup-factory-storage.sh up first.");

const config = async (name: "ordinary" | "archive") => Bun.file(`${secretsDir}/${name}.json`).json() as Promise<S3Config>;
const tenantCredentials = async (name: "ordinary" | "archive", tenant = "01") => {
  const identity = (await config(name)).identities.find((entry) => entry.name === `tenant-${tenant}`);
  const credential = identity?.credentials[0];
  if (!credential) throw new Error(`Missing generated ${name} tenant-${tenant} credentials.`);
  return { accessKeyId: credential.accessKey, secretAccessKey: credential.secretKey };
};
const endpoint = (kind: "ordinary" | "archive") => `http://127.0.0.1:${kind === "ordinary" ? process.env.EZCORP_FACTORY_STORAGE_ORDINARY_S3_PORT ?? "18333" : process.env.EZCORP_FACTORY_STORAGE_ARCHIVE_S3_PORT ?? "18334"}`;
const client = (kind: "ordinary" | "archive", credentials: { accessKeyId: string; secretAccessKey: string }) => new S3Client({ endpoint: endpoint(kind), region: "us-east-1", forcePathStyle: true, credentials });
const bytes = (size: number) => new Uint8Array(randomBytes(size));
const sha256 = (value: Uint8Array) => createHash("sha256").update(value).digest("base64");
const expectRejected = async (action: () => Promise<unknown>, message: string) => {
  try { await action(); }
  catch (error) {
    const denial = error as { $metadata?: { httpStatusCode?: number } };
    if (denial.$metadata?.httpStatusCode === 403) return;
    throw error;
  }
  throw new Error(message);
};
const bodyBytes = async (body: unknown) => {
  if (!body || typeof (body as { transformToByteArray?: unknown }).transformToByteArray !== "function") throw new Error("S3 response had no readable body.");
  return (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
};
const run = async (args: string[]) => {
  const child = Bun.spawn(["docker", ...args], {
    cwd: resolve(import.meta.dir, ".."),
    env: { ...process.env, COMPOSE_PROJECT_NAME: `ezcorp-factory-storage-${process.getuid?.() ?? "local"}` },
    stdout: "ignore",
    stderr: "ignore",
  });
  if (await child.exited !== 0) throw new Error("Local SeaweedFS restart failed.");
};
const waitForReadAfterRestart = async (read: () => Promise<Uint8Array>) => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { return await read(); }
    catch (error) { lastError = error; }
    await Bun.sleep(250);
  }
  throw new Error(`S3 remained unavailable after restart: ${(lastError as Error).name}`);
};

// Read denials target existing foreign objects, so a missing object or a
// server failure cannot be mistaken for a successful authorization check.
const tenantObjects: Array<{ tenant: string; kind: "ordinary" | "archive"; digest: string; content: Uint8Array }> = [];
for (let number = 1; number <= 10; number += 1) {
  const tenant = String(number).padStart(2, "0");
  for (const kind of ["ordinary", "archive"] as const) {
    const credentials = await tenantCredentials(kind, tenant);
    const storageClient = client(kind, credentials);
    const store = new S3BlobStore({ endpoint: endpoint(kind), bucket: `tenant-${tenant}`, prefix: kind, credentials, client: storageClient });
    const content = bytes(128);
    const tenantDigest = await store.put(content);
    if (Buffer.compare(Buffer.from(await store.get(tenantDigest)), Buffer.from(content)) !== 0) throw new Error(`Tenant ${tenant} ${kind} round trip failed.`);
    tenantObjects.push({ tenant, kind, digest: tenantDigest, content });
    storageClient.destroy();
  }
}
for (const object of tenantObjects) {
  const other = String(Number(object.tenant) % 10 + 1).padStart(2, "0");
  const foreign = tenantObjects.find((entry) => entry.tenant === other && entry.kind === object.kind)!;
  const storageClient = client(object.kind, await tenantCredentials(object.kind, object.tenant));
  const target = { Bucket: `tenant-${other}`, Key: `${object.kind}/${foreign.digest}` };
  await expectRejected(() => storageClient.send(new PutObjectCommand({ ...target, Body: object.content })), `Tenant ${object.tenant} wrote tenant ${other} storage.`);
  await expectRejected(() => storageClient.send(new GetObjectCommand(target)), `Tenant ${object.tenant} read tenant ${other} storage.`);
  await expectRejected(() => storageClient.send(new DeleteObjectCommand(target)), `Tenant ${object.tenant} deleted tenant ${other} storage.`);
  storageClient.destroy();
}

const ordinaryCredentials = await tenantCredentials("ordinary");
const archiveCredentials = await tenantCredentials("archive");
const ordinaryClient = client("ordinary", ordinaryCredentials);
const archiveClient = client("archive", archiveCredentials);
const ordinary = new S3BlobStore({ endpoint: endpoint("ordinary"), bucket: "tenant-01", prefix: "ordinary", credentials: ordinaryCredentials, client: ordinaryClient });
const archive = new S3BlobStore({ endpoint: endpoint("archive"), bucket: "tenant-01", prefix: "archive", credentials: archiveCredentials, client: archiveClient });

const immutable = bytes(1024);
const digest = await ordinary.put(immutable);
const racers = Array.from({ length: 12 }, () => new S3BlobStore({ endpoint: endpoint("ordinary"), bucket: "tenant-01", prefix: "ordinary", credentials: ordinaryCredentials, client: client("ordinary", ordinaryCredentials) }).put(immutable));
if (!(await Promise.all(racers)).every((result) => result === digest)) throw new Error("Conditional create race returned a different digest.");
if (Buffer.compare(Buffer.from(await ordinary.get(digest)), Buffer.from(immutable)) !== 0) throw new Error("S3 content-addressed read changed bytes.");
if (await ordinary.checksum(digest) !== sha256(immutable)) throw new Error("S3 checksum does not match stored bytes.");
const immutableVersions = await ordinaryClient.send(new ListObjectVersionsCommand({ Bucket: "tenant-01", Prefix: `ordinary/${digest}` }));
if (immutableVersions.Versions?.filter((entry) => entry.Key === `ordinary/${digest}`).length !== 1) throw new Error("Conditional create race produced more than one object version.");

const versionKey = `ordinary/version-proof-${randomUUID()}`;
const first = bytes(32);
const firstVersion = await ordinaryClient.send(new PutObjectCommand({ Bucket: "tenant-01", Key: versionKey, Body: first, ChecksumSHA256: sha256(first) }));
const second = bytes(32);
await ordinaryClient.send(new PutObjectCommand({ Bucket: "tenant-01", Key: versionKey, Body: second, ChecksumSHA256: sha256(second) }));
if (!firstVersion.VersionId) throw new Error("S3 versioning did not return a version identity.");
const prior = await ordinaryClient.send(new GetObjectCommand({ Bucket: "tenant-01", Key: versionKey, VersionId: firstVersion.VersionId, ChecksumMode: "ENABLED" }));
if (Buffer.compare(Buffer.from(await bodyBytes(prior.Body)), Buffer.from(first)) !== 0) throw new Error("S3 version read did not return the prior object bytes.");

const multipart = bytes(5 * 1024 * 1024 + 1024);
const multipartStore = new S3BlobStore({ endpoint: endpoint("ordinary"), bucket: "tenant-01", prefix: "ordinary", credentials: ordinaryCredentials, client: ordinaryClient, multipartThresholdBytes: 5 * 1024 * 1024, multipartPartBytes: 5 * 1024 * 1024 });
const multipartDigest = await multipartStore.put(multipart);
if (Buffer.compare(Buffer.from(await multipartStore.get(multipartDigest)), Buffer.from(multipart)) !== 0) throw new Error("Multipart upload changed bytes.");
const multipartRacers = await Promise.all(Array.from({ length: 2 }, () => new S3BlobStore({ endpoint: endpoint("ordinary"), bucket: "tenant-01", prefix: "ordinary", credentials: ordinaryCredentials, client: client("ordinary", ordinaryCredentials), multipartThresholdBytes: 5 * 1024 * 1024, multipartPartBytes: 5 * 1024 * 1024 }).put(multipart)));
if (!multipartRacers.every((result) => result === multipartDigest)) throw new Error("Multipart conditional create race returned a different digest.");
const multipartVersions = await ordinaryClient.send(new ListObjectVersionsCommand({ Bucket: "tenant-01", Prefix: `ordinary/${multipartDigest}` }));
if (multipartVersions.Versions?.filter((entry) => entry.Key === `ordinary/${multipartDigest}`).length !== 1) throw new Error("Multipart conditional create race produced more than one object version.");

await expectRejected(() => ordinaryClient.send(new PutObjectCommand({ Bucket: "tenant-01", Key: `outside/${randomUUID()}`, Body: bytes(8) })), "Prefix credentials wrote outside ordinary/.");
const archiveDigest = await archive.put(bytes(64));
const foreignArchiveClient = client("archive", ordinaryCredentials);
await expectRejected(() => foreignArchiveClient.send(new PutObjectCommand({ Bucket: "tenant-01", Key: `archive/${randomUUID()}`, Body: bytes(8) })), "Ordinary credentials wrote the archive service.");
await expectRejected(() => foreignArchiveClient.send(new DeleteObjectCommand({ Bucket: "tenant-01", Key: `archive/${archiveDigest}` })), "Ordinary credentials deleted an archive object.");

await run(["compose", "-f", "compose.factory-storage.local.yml", "--profile", "factory-storage", "stop", "factory-storage-ordinary"]);
await run(["compose", "-f", "compose.factory-storage.local.yml", "--profile", "factory-storage", "up", "-d", "--wait", "factory-storage-ordinary"]);
if (Buffer.compare(Buffer.from(await waitForReadAfterRestart(() => ordinary.get(digest))), Buffer.from(immutable)) !== 0) throw new Error("S3 object did not survive a service restart.");

console.log("Factory local S3 conformance passed for 10 tenant identities across ordinary and archive storage.");
