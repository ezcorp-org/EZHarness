import { randomUUID } from "node:crypto";
import { factoryRunInputsConformance } from "../../src/__tests__/helpers/factory-run-inputs-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";
import { createFactoryOrdinaryStorage } from "./helpers/factory-storage";

factoryRunInputsConformance(async () => {
  const storage = await createFactoryOrdinaryStorage(`ordinary/factory-run-inputs/${randomUUID()}`);
  try {
    const database = await setupFactoryPostgres();
    return { db: database.db, blobs: storage.blobs, async close() { try { await database.close(); } finally { storage.close(); } } };
  } catch (error) { storage.close(); throw error; }
});
