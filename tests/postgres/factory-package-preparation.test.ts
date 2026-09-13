import { randomUUID } from "node:crypto";
import { factoryPackagePreparationConformance } from "../../src/__tests__/helpers/factory-package-preparation-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";
import { createFactoryOrdinaryStorage } from "./helpers/factory-storage";

factoryPackagePreparationConformance(async () => {
  const storage = await createFactoryOrdinaryStorage(`ordinary/factory-package-preparation/${randomUUID()}`);
  try {
    const database = await setupFactoryPostgres();
    return { db: database.db, blobs: storage.blobs, async close() { try { await database.close(); } finally { storage.close(); } } };
  } catch (error) {
    storage.close();
    throw error;
  }
});
