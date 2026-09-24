import { randomUUID } from "node:crypto";
import { DeleteObjectCommand, ListObjectVersionsCommand, S3Client } from "@aws-sdk/client-s3";
import { S3BlobStore } from "../../../src/extensions/v4/blobs";
import { S3FactoryReleaseArchive } from "../../../src/factory/release-adapters";
import { S3FactoryRecoveryArchive } from "../../../src/factory/recovery-archive";
import { S3FactoryRetentionBlobEraser } from "../../../src/factory/retention";
import { factoryStorageCredentials, factoryStorageEndpoint } from "./factory-storage";

/**
 * The real ordinary store and the real independent archive, under prefixes
 * unique to one test process.
 *
 * Cleanup removes exactly what this process wrote to the ORDINARY store, every
 * version, through the ordinary credentials. Archive objects are immutable by
 * design and the archive credential cannot delete them; they stay under the
 * process's own `w15/<uuid>` prefix and the cleanup reports how many it left.
 */
export async function factoryRecoveryStorage(tenant = "tenant-09") {
  const run = `w15-${randomUUID()}`;
  const ordinaryCredentials = await factoryStorageCredentials("ordinary", tenant);
  const archiveCredentials = await factoryStorageCredentials("archive", tenant);
  const ordinaryEndpoint = factoryStorageEndpoint("ordinary");
  const archiveEndpoint = factoryStorageEndpoint("archive");
  const ordinaryClient = new S3Client({ endpoint: ordinaryEndpoint, region: "us-east-1", forcePathStyle: true, credentials: ordinaryCredentials, maxAttempts: 1 });
  const archiveClient = new S3Client({ endpoint: archiveEndpoint, region: "us-east-1", forcePathStyle: true, credentials: archiveCredentials, maxAttempts: 1 });
  const ordinaryPrefix = `ordinary/${run}`;
  const archiveOptions = { endpoint: archiveEndpoint, bucket: tenant, prefix: `archive/${run}`, credentials: archiveCredentials, client: archiveClient };
  const blobs = new S3BlobStore({ endpoint: ordinaryEndpoint, bucket: tenant, prefix: ordinaryPrefix, credentials: ordinaryCredentials, client: ordinaryClient });

  async function versions(client: S3Client, prefix: string) {
    const listed = await client.send(new ListObjectVersionsCommand({ Bucket: tenant, Prefix: `${prefix}/` }));
    return [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])].flatMap(item => item.Key && item.VersionId ? [{ Key: item.Key, VersionId: item.VersionId }] : []);
  }

  return {
    run, tenant, ordinaryPrefix, ordinaryEndpoint, ordinaryCredentials, ordinaryClient, archiveClient, blobs, archiveOptions,
    archive: new S3FactoryRecoveryArchive(archiveOptions),
    releaseArchive: new S3FactoryReleaseArchive(archiveOptions),
    eraser: new S3FactoryRetentionBlobEraser({ endpoint: ordinaryEndpoint, bucket: tenant, prefix: ordinaryPrefix, credentials: ordinaryCredentials, client: ordinaryClient }),
    putCandidate: (bytes: Uint8Array) => blobs.put(bytes),
    candidateReadable: (blobDigest: string) => blobs.get(blobDigest).then(() => true, () => false),
    /** Removes this process's ordinary objects, every version. Returns what the archive still holds. */
    async cleanup(): Promise<{ readonly ordinaryRemoved: number; readonly archiveRetained: number }> {
      const ordinary = await versions(ordinaryClient, ordinaryPrefix);
      for (const item of ordinary) await ordinaryClient.send(new DeleteObjectCommand({ Bucket: tenant, Key: item.Key, VersionId: item.VersionId }));
      const retained = (await versions(archiveClient, archiveOptions.prefix)).length;
      ordinaryClient.destroy(); archiveClient.destroy();
      return { ordinaryRemoved: ordinary.length, archiveRetained: retained };
    },
  };
}
