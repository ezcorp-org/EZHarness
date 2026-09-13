import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
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
  close(): void;
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

/** Opens one tenant-scoped ordinary S3 client from the test environment. */
export async function createFactoryOrdinaryStorage(prefix: string, tenant = "tenant-01"): Promise<FactoryOrdinaryStorage> {
  const normalized = normalizedPrefix(prefix);
  const storage = config("ordinary");
  const credentials = await factoryStorageCredentials("ordinary", tenant);
  const client = new S3Client({ endpoint: storage.endpoint, region: "us-east-1", forcePathStyle: true, credentials });
  return { blobs: new S3BlobStore({ endpoint: storage.endpoint, bucket: tenant, prefix: normalized, credentials, client }), client, bucket: tenant, prefix: normalized, close: () => client.destroy() };
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
