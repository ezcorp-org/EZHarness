import { randomUUID } from "node:crypto";
import { factoryRunLifecycleConformance } from "../../src/__tests__/helpers/factory-run-lifecycle-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";
import { createFactoryOrdinaryStorage } from "./helpers/factory-storage";

factoryRunLifecycleConformance(async () => {
  const storage = await createFactoryOrdinaryStorage(`ordinary/factory-lifecycle/${randomUUID()}`);
  try {
    const database = await setupFactoryPostgres();
    return {
      db: database.db,
      blobs: storage.blobs,
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
