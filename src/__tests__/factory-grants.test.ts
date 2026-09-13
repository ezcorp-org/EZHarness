import { setupTestDb } from "./helpers/test-pglite";
import { factoryGrantsConformance } from "./helpers/factory-grants-suite";

factoryGrantsConformance(async () => {
  const fixture = await setupTestDb();
  return { db: fixture.db, close: () => fixture.pglite.close() };
});
