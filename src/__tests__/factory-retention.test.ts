import { factoryRecoveryMemoryStores } from "./helpers/factory-recovery-memory";
import { factoryRetentionConformance } from "./helpers/factory-retention-suite";
import { setupTestDb } from "./helpers/test-pglite";

factoryRetentionConformance("PGlite", async () => {
  const { db, pglite } = await setupTestDb();
  return { db, ...factoryRecoveryMemoryStores(), close: () => pglite.close() };
});
