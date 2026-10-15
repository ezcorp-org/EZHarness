import { S3BlobStore } from "../../extensions/v4/blobs";
import { S3FactoryReleaseArchive } from "../../factory/release-adapters";
import { S3FactoryRecoveryArchive } from "../../factory/recovery-archive";
import { S3FactoryRetentionBlobEraser } from "../../factory/retention";
import { FactoryMemoryS3Store } from "./factory-s3-memory-store";

/**
 * The two S3 stores a recovery test needs, in memory: the ordinary product
 * store and the independent archive. Each has its own store object, so a test
 * can lose one and keep the other.
 */
export function factoryRecoveryMemoryStores() {
  const credentials = { accessKeyId: "memory-access", secretAccessKey: "memory-secret" };
  const ordinaryStore = new FactoryMemoryS3Store();
  const archiveStore = new FactoryMemoryS3Store();
  const archiveOptions = { endpoint: "http://archive.invalid", bucket: "archive", prefix: "tenant-archive", credentials, client: archiveStore };
  const blobs = new S3BlobStore({ endpoint: "http://ordinary.invalid", bucket: "ordinary", prefix: "tenant-ordinary", credentials, client: ordinaryStore });
  return {
    ordinaryStore, archiveStore, blobs,
    archive: new S3FactoryRecoveryArchive(archiveOptions),
    releaseArchive: new S3FactoryReleaseArchive(archiveOptions),
    eraser: new S3FactoryRetentionBlobEraser({ endpoint: "http://ordinary.invalid", bucket: "ordinary", prefix: "tenant-ordinary", credentials, client: ordinaryStore }),
    putCandidate: (bytes: Uint8Array) => blobs.put(bytes),
    candidateReadable: (blobDigest: string) => blobs.get(blobDigest).then(() => true, () => false),
  };
}
