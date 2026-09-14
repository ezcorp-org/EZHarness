import { randomUUID } from "node:crypto";
import { factoryArchiveWriterConformance } from "../../src/__tests__/helpers/factory-archive-writer-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";
import { createFactoryArchiveStorage, createFactoryOrdinaryStorage } from "./helpers/factory-storage";

// Real PostgreSQL for the release operations, the real ordinary S3 service for
// the material bytes every member is read from, and the separately credentialed
// archive service for the immutable recovery set.
factoryArchiveWriterConformance(async () => {
  const database = await setupFactoryPostgres();
  const label = randomUUID();
  const ordinary = await createFactoryOrdinaryStorage(`ordinary/archive-writer/${label}`);
  const archive = await createFactoryArchiveStorage(`archive/archive-writer/${label}`);
  return {
    db: database.db,
    blobs: ordinary.blobs,
    archive,
    async close() { archive.close(); ordinary.close(); await database.close(); },
  };
});
