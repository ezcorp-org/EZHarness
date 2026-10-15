import { factoryInboxConformance } from "./helpers/factory-inbox-suite";
import { setupTestDb } from "./helpers/test-pglite";

factoryInboxConformance(async () => {
  const { db, pglite } = await setupTestDb();
  return { db, close: () => pglite.close() };
});
