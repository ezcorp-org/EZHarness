import { setupTestDb } from "./helpers/test-pglite";
import { factoryTaskStopsConformance } from "./helpers/factory-task-stops-suite";

factoryTaskStopsConformance(async () => {
  const fixture = await setupTestDb();
  return { db: fixture.db, close: () => fixture.pglite.close() };
});
