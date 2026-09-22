import { randomUUID } from "node:crypto";
import { factoryRunLifecycleConformance } from "../../src/__tests__/helpers/factory-run-lifecycle-suite";
import type { S3ClientLike } from "../../src/factory/release-adapters";
import { setupFactoryPostgres } from "./helpers/factory-test-database";
import { createFactoryOrdinaryStorage, factoryStorageCredentials, factoryStorageEndpoint } from "./helpers/factory-storage";

// Real PostgreSQL, the real ordinary SeaweedFS service for artifact bytes, and
// the same service as the DECLARED release destination: the publishing cases
// compose their S3 provider from a private credential file, exactly as the
// installation does, and read back what reached the store.
factoryRunLifecycleConformance(async () => {
  const label = randomUUID();
  const storage = await createFactoryOrdinaryStorage(`ordinary/factory-lifecycle/${label}`);
  try {
    const database = await setupFactoryPostgres();
    return {
      db: database.db,
      blobs: storage.blobs,
      publication: {
        endpoint: factoryStorageEndpoint("ordinary"), bucket: storage.bucket, prefix: `ordinary/factory-lifecycle-published/${label}`,
        credentials: await factoryStorageCredentials("ordinary"), client: storage.client as unknown as S3ClientLike,
      },
      async close() {
        try { await database.close(); }
        finally { storage.close(); }
      },
    };
  } catch (error) {
    storage.close();
    throw error;
  }
});
