import { randomUUID } from "node:crypto";
import { factoryS3PublicationConformance } from "../../src/__tests__/helpers/factory-s3-publication-suite";
import type { S3ClientLike } from "../../src/factory/release-adapters";
import { setupFactoryPostgres } from "./helpers/factory-test-database";
import { createFactoryArchiveStorage, createFactoryOrdinaryStorage } from "./helpers/factory-storage";

// Real PostgreSQL for the release operations and the protected command trail, the
// real ordinary SeaweedFS service for both the material bytes and the published
// objects, and the separately credentialed archive service for the recovery set.
// `large` turns on the 256 MiB multipart export, which needs a real S3 gateway.
factoryS3PublicationConformance(async () => {
  const database = await setupFactoryPostgres();
  const label = randomUUID();
  const ordinary = await createFactoryOrdinaryStorage(`ordinary/s3-publication/${label}`);
  const archive = await createFactoryArchiveStorage(`archive/s3-publication/${label}`);
  return {
    db: database.db,
    blobs: ordinary.blobs,
    archive,
    s3: { client: ordinary.client as unknown as S3ClientLike, bucket: ordinary.bucket, prefix: `ordinary/s3-published/${label}` },
    large: true,
    async close() { archive.close(); ordinary.close(); await database.close(); },
  };
});
