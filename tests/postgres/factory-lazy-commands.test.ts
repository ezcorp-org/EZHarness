import { randomUUID } from "node:crypto";
import { factoryLazyCommandsConformance } from "../../src/__tests__/helpers/factory-lazy-commands-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";
import { createFactoryOrdinaryStorage } from "./helpers/factory-storage";

factoryLazyCommandsConformance(async () => {
  const storage = await createFactoryOrdinaryStorage(`ordinary/factory-lazy-commands/${randomUUID()}`);
  try {
    const database = await setupFactoryPostgres();
    return {
      db: database.db,
      blobs: storage.blobs,
      async close() {
        try { await database.close(); }
        finally { await storage.close(); }
      },
    };
  } catch (error) {
    await storage.close();
    throw error;
  }
});
