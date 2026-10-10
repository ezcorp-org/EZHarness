import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DeleteObjectsCommand, ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import { S3BlobStore, s3ObjectKey } from "../../../src/extensions/v4/blobs";
import { S3FactoryArchiveInventory, type FactoryArchiveInventory } from "../../../src/factory/archive-writer";
import { S3FactoryReleaseArchive } from "../../../src/factory/release-adapters";
import type { FactoryArchiveObject, FactoryReleaseArchive } from "../../../src/factory/releases";

interface S3Config {
  readonly identities: ReadonlyArray<{ readonly name: string; readonly credentials: ReadonlyArray<{ readonly accessKey: string; readonly secretKey: string }> }>;
}

export type FactoryStorageKind = "ordinary" | "archive";

export interface FactoryOrdinaryStorage {
  readonly blobs: S3BlobStore;
  readonly client: S3Client;
  readonly bucket: string;
  readonly prefix: string;
  /**
   * Permanently removes every version and delete marker the run left under its
   * prefix and the prefixes it owns, then destroys the client. The buckets keep
   * every version, so a run that only deletes keys still leaves its bytes (W15d).
   */
  close(): Promise<void>;
}

export interface FactoryArchiveStorage extends FactoryReleaseArchive, FactoryArchiveInventory {
  readonly bucket: string;
  readonly root: string;
  close(): void;
}

const DEFAULT_PORT: Readonly<Record<FactoryStorageKind, string>> = { ordinary: "18333", archive: "18334" };

function config(kind: FactoryStorageKind): { readonly path: string; readonly endpoint: string } {
  const secretsDir = process.env.EZCORP_FACTORY_STORAGE_SECRETS_DIR;
  if (!secretsDir) throw new Error("EZCORP_FACTORY_STORAGE_SECRETS_DIR is required for PostgreSQL factory storage proofs.");
  const endpoint = process.env[`EZCORP_FACTORY_STORAGE_${kind.toUpperCase()}_S3_ENDPOINT`]
    ?? `http://127.0.0.1:${process.env[`EZCORP_FACTORY_STORAGE_${kind.toUpperCase()}_S3_PORT`] ?? DEFAULT_PORT[kind]}`;
  try { new URL(endpoint); } catch { throw new Error(`EZCORP_FACTORY_STORAGE_${kind.toUpperCase()}_S3_ENDPOINT must be an absolute URL.`); }
  return { path: join(secretsDir, `${kind}.json`), endpoint };
}

/** Reads one generated tenant identity. Credential values never leave this helper. */
export async function factoryStorageCredentials(kind: FactoryStorageKind, tenant = "tenant-01"): Promise<{ accessKeyId: string; secretAccessKey: string }> {
  const parsed = JSON.parse(await readFile(config(kind).path, "utf8")) as S3Config;
  const credential = parsed.identities.find(identity => identity.name === tenant)?.credentials[0];
  if (!credential) throw new Error(`Generated ${kind} storage ${tenant} credentials are missing.`);
  return { accessKeyId: credential.accessKey, secretAccessKey: credential.secretKey };
}

export function factoryStorageEndpoint(kind: FactoryStorageKind): string { return config(kind).endpoint; }

function normalizedPrefix(prefix: string): string { return s3ObjectKey(prefix, "0".repeat(64)).slice(0, -65); }

/** One stored version or delete marker. */
export interface FactoryStoredVersion { readonly key: string; readonly versionId: string }

/** The narrow S3 surface the run cleanup sends through. */
export interface FactoryRunCleanupClient { send(command: ListObjectVersionsCommand | DeleteObjectsCommand): Promise<unknown> }

/** The most versions one DeleteObjects call may name (the S3 limit). */
export const FACTORY_RUN_DELETE_BATCH = 1_000;

interface VersionPage {
  Versions?: { Key?: string; VersionId?: string }[];
  DeleteMarkers?: { Key?: string; VersionId?: string }[];
  IsTruncated?: boolean;
  NextKeyMarker?: string;
  NextVersionIdMarker?: string;
}

/**
 * The `a/b/` form of a prefix a run owns. It must name at least two path
 * segments, so a cleanup can never reach a bucket root or the shared `ordinary/`
 * root that installations write to; the caller's prefix is run-unique (a UUID).
 */
export function factoryRunPrefix(prefix: string): string {
  const segments = prefix.split("/").filter(segment => segment.length > 0);
  if (segments.length < 2 || segments.some(segment => segment === "." || segment === "..")) {
    throw new Error(`refusing to clean "${prefix}": a run prefix needs at least two path segments`);
  }
  return `${segments.join("/")}/`;
}

/** Every version and delete marker under the run's prefix, across every page. */
export async function listFactoryRunVersions(client: FactoryRunCleanupClient, bucket: string, prefix: string): Promise<FactoryStoredVersion[]> {
  const owned = factoryRunPrefix(prefix);
  const all: FactoryStoredVersion[] = [];
  let marker: { KeyMarker: string; VersionIdMarker: string } | undefined;
  do {
    const page = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: owned, MaxKeys: 1_000, ...marker })) as VersionPage;
    for (const item of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) {
      if (item.Key?.startsWith(owned) && item.VersionId) all.push({ key: item.Key, versionId: item.VersionId });
    }
    marker = undefined;
    if (page.IsTruncated) {
      // A truncated page without a continuation would end the listing early and leave objects behind silently.
      if (page.NextKeyMarker === undefined || page.NextVersionIdMarker === undefined) throw new Error(`the store truncated the version listing of ${bucket}/${owned} without a continuation marker`);
      marker = { KeyMarker: page.NextKeyMarker, VersionIdMarker: page.NextVersionIdMarker };
    }
  } while (marker !== undefined);
  return all;
}

/**
 * Permanently removes every version and delete marker under the run's prefix;
 * returns how many. One DeleteObjects call per thousand versions, so a close()
 * inside an afterEach stays short under load; any per-key refusal fails it.
 */
export async function removeFactoryRunObjects(client: FactoryRunCleanupClient, bucket: string, prefix: string): Promise<number> {
  const versions = await listFactoryRunVersions(client, bucket, prefix);
  for (let start = 0; start < versions.length; start += FACTORY_RUN_DELETE_BATCH) {
    const batch = versions.slice(start, start + FACTORY_RUN_DELETE_BATCH);
    const result = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch.map(version => ({ Key: version.key, VersionId: version.versionId })), Quiet: true } })) as { Errors?: { Key?: string; Code?: string }[] };
    const refused = result.Errors ?? [];
    if (refused.length > 0) throw new Error(`the store refused ${refused.length} of ${batch.length} deletes under ${bucket}/${factoryRunPrefix(prefix)} (first: ${refused[0]!.Code ?? "unknown"} ${refused[0]!.Key ?? ""})`);
  }
  return versions.length;
}

/**
 * Opens one tenant-scoped ordinary S3 client from the test environment.
 * `owns` names further run-unique prefixes the run writes to (a publication
 * destination, for example); `close()` removes those too.
 */
export async function createFactoryOrdinaryStorage(prefix: string, tenant = "tenant-01", owns: readonly string[] = []): Promise<FactoryOrdinaryStorage> {
  const normalized = normalizedPrefix(prefix);
  const storage = config("ordinary");
  const credentials = await factoryStorageCredentials("ordinary", tenant);
  const client = new S3Client({ endpoint: storage.endpoint, region: "us-east-1", forcePathStyle: true, credentials });
  return {
    blobs: new S3BlobStore({ endpoint: storage.endpoint, bucket: tenant, prefix: normalized, credentials, client }), client, bucket: tenant, prefix: normalized,
    async close() {
      try { for (const owned of [normalized, ...owns.map(normalizedPrefix)]) await removeFactoryRunObjects(client, tenant, owned); }
      finally { client.destroy(); }
    },
  };
}

/**
 * Opens the separately credentialed archive service as one store that both
 * writes immutable objects and lists them. The archive credential set is the
 * only one this object ever holds.
 */
export async function createFactoryArchiveStorage(prefix: string, tenant = "tenant-01"): Promise<FactoryArchiveStorage> {
  const root = normalizedPrefix(prefix);
  const storage = config("archive");
  const credentials = await factoryStorageCredentials("archive", tenant);
  const client = new S3Client({ endpoint: storage.endpoint, region: "us-east-1", forcePathStyle: true, credentials, maxAttempts: 1 });
  const archive = new S3FactoryReleaseArchive({ endpoint: storage.endpoint, bucket: tenant, prefix: root, credentials, client });
  const inventory = new S3FactoryArchiveInventory({ endpoint: storage.endpoint, bucket: tenant, root, credentials, client });
  return {
    bucket: tenant, root,
    writeImmutable: (tenantId: string, operationId: string, name: "intent" | "material" | "receipt" | "reconciliation", bytes: Uint8Array) => archive.writeImmutable(tenantId, operationId, name, bytes),
    read: (reference: FactoryArchiveObject) => archive.read(reference),
    list: (listPrefix: string, signal?: AbortSignal) => inventory.list(listPrefix, signal),
    close: () => client.destroy(),
  };
}
