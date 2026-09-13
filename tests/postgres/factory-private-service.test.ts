import { randomUUID } from "node:crypto";
import { factoryPrivateServiceConformance } from "../../src/__tests__/helpers/factory-private-service-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";
import { createFactoryOrdinaryStorage } from "./helpers/factory-storage";

factoryPrivateServiceConformance(async () => {
  const database = await setupFactoryPostgres();
  try {
    const storage = await createFactoryOrdinaryStorage(`ordinary/private-service/${randomUUID()}`);
    return { db: database.db, blobs: storage.blobs, close: async () => { storage.close(); await database.close(); } };
  } catch (error) { await database.close(); throw error; }
});
