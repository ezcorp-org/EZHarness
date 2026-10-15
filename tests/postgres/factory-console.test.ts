import { randomUUID } from "node:crypto";
import { factoryConsoleConformance } from "../../src/__tests__/helpers/factory-console-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";
import { createFactoryOrdinaryStorage } from "./helpers/factory-storage";

// Each call provisions its own database and its own storage prefix, so the
// suite's two installations share no rows, no keys, and no objects.
factoryConsoleConformance(async () => {
  const storage = await createFactoryOrdinaryStorage(`ordinary/factory-console/${randomUUID()}`);
  try {
    const database = await setupFactoryPostgres();
    return { db: database.db, blobs: storage.blobs, async close() { try { await database.close(); } finally { storage.close(); } } };
  } catch (error) {
    storage.close();
    throw error;
  }
});
