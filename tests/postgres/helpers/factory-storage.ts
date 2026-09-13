import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { S3Client } from "@aws-sdk/client-s3";
import { S3BlobStore, s3ObjectKey } from "../../../src/extensions/v4/blobs";

interface S3Config {
  readonly identities: ReadonlyArray<{ readonly name: string; readonly credentials: ReadonlyArray<{ readonly accessKey: string; readonly secretKey: string }> }>;
}

export interface FactoryOrdinaryStorage {
  readonly blobs: S3BlobStore;
  readonly client: S3Client;
  readonly bucket: string;
  readonly prefix: string;
  close(): void;
}

function config(): { readonly path: string; readonly endpoint: string } {
  const secretsDir = process.env.EZCORP_FACTORY_STORAGE_SECRETS_DIR;
  if (!secretsDir) throw new Error("EZCORP_FACTORY_STORAGE_SECRETS_DIR is required for PostgreSQL factory storage proofs.");
  const endpoint = process.env.EZCORP_FACTORY_STORAGE_ORDINARY_S3_ENDPOINT ?? `http://127.0.0.1:${process.env.EZCORP_FACTORY_STORAGE_ORDINARY_S3_PORT ?? "18333"}`;
  try { new URL(endpoint); } catch { throw new Error("EZCORP_FACTORY_STORAGE_ORDINARY_S3_ENDPOINT must be an absolute URL."); }
  return { path: join(secretsDir, "ordinary.json"), endpoint };
}

/** Opens one tenant-scoped ordinary S3 client from the test environment. */
export async function createFactoryOrdinaryStorage(prefix: string): Promise<FactoryOrdinaryStorage> {
  const normalizedPrefix = s3ObjectKey(prefix, "0".repeat(64)).slice(0, -65);
  const storage = config();
  const parsed = JSON.parse(await readFile(storage.path, "utf8")) as S3Config;
  const credential = parsed.identities.find(identity => identity.name === "tenant-01")?.credentials[0];
  if (!credential) throw new Error("Generated ordinary storage tenant-01 credentials are missing.");
  const credentials = { accessKeyId: credential.accessKey, secretAccessKey: credential.secretKey };
  const client = new S3Client({ endpoint: storage.endpoint, region: "us-east-1", forcePathStyle: true, credentials });
  const bucket = "tenant-01";
  return { blobs: new S3BlobStore({ endpoint: storage.endpoint, bucket, prefix: normalizedPrefix, credentials, client }), client, bucket, prefix: normalizedPrefix, close: () => client.destroy() };
}
