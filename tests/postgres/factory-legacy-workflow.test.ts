import { randomUUID } from "node:crypto";
import { factoryLegacyWorkflowConformance } from "../../src/__tests__/helpers/factory-legacy-workflow-suite";
import { createFactoryOrdinaryStorage } from "./helpers/factory-storage";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

factoryLegacyWorkflowConformance(async () => {
  const database = await setupFactoryPostgres();
  const storage = await createFactoryOrdinaryStorage(`ordinary/factory-legacy-workflow/${randomUUID()}`);
  return { db: database.db, blobs: storage.blobs, close: async () => { storage.close(); await database.close(); } };
});
