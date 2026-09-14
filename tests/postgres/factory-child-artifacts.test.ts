import { randomUUID } from "node:crypto";
import { factoryChildArtifactsConformance } from "../../src/__tests__/helpers/factory-child-artifacts-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";
import { createFactoryOrdinaryStorage } from "./helpers/factory-storage";

factoryChildArtifactsConformance(async () => {
  const database = await setupFactoryPostgres();
  const storage = await createFactoryOrdinaryStorage(`ordinary/factory-child-artifacts/${randomUUID()}`);
  return { db: database.db, blobs: storage.blobs, close: async () => { storage.close(); await database.close(); } };
});
