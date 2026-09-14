import { randomUUID } from "node:crypto";
import type { S3ClientLike } from "../../src/factory/release-adapters";
import { factoryReferenceDataConformance } from "../../src/__tests__/helpers/factory-reference-data-suite";
import { createFactoryOrdinaryStorage, factoryStorageCredentials, factoryStorageEndpoint } from "./helpers/factory-storage";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

/**
 * The real leg: real PostgreSQL, S3-backed encrypted blobs, a real immutable
 * publication, and the 256 MiB boundary. `src/factory/reference-data/
 * journey.integration.test.ts` runs the same suite on the embedded database.
 *
 * Each fixture gets its own database and its own object prefix, and the suite
 * deletes exactly the object versions its publication created.
 */
factoryReferenceDataConformance(async () => {
  const database = await setupFactoryPostgres();
  const label = randomUUID();
  const ordinary = await createFactoryOrdinaryStorage(`ordinary/reference-data/${label}`);
  return {
    db: database.db,
    blobs: ordinary.blobs,
    s3: {
      client: ordinary.client as unknown as S3ClientLike,
      endpoint: factoryStorageEndpoint("ordinary"),
      bucket: ordinary.bucket,
      prefix: `ordinary/reference-data-published/${label}`,
      credentials: await factoryStorageCredentials("ordinary"),
    },
    large: true,
    async close() {
      ordinary.close();
      await database.close();
    },
  };
});
