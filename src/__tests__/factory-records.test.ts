import { factoryRecordsConformance } from "./helpers/factory-records-suite";
import { setupTestDb } from "./helpers/test-pglite";

factoryRecordsConformance(async () => {
  const { db, pglite } = await setupTestDb();
  return { db, close: () => pglite.close() };
});
