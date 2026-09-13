import { randomUUID } from "node:crypto";
import { factoryValidatorMaterialsConformance } from "../../src/__tests__/helpers/factory-validator-materials-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";
import { createFactoryOrdinaryStorage } from "./helpers/factory-storage";

factoryValidatorMaterialsConformance(async () => {
  const database = await setupFactoryPostgres();
  const storage = await createFactoryOrdinaryStorage(`ordinary/factory-validator-materials/${randomUUID()}`);
  return { db: database.db, blobs: storage.blobs, close: async () => { storage.close(); await database.close(); } };
});
