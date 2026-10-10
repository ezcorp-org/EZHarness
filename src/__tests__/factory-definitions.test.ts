import { factoryDefinitionsConformance } from "./helpers/factory-definitions-suite";
import { setupTestDb } from "./helpers/test-pglite";

factoryDefinitionsConformance(async () => {
  const fixture = await setupTestDb();
  return { db: fixture.db, close: () => fixture.pglite.close() };
});
