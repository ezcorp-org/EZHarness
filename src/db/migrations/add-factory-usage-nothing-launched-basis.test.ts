import { factoryUsageBasisMigrationConformance } from "../../__tests__/helpers/factory-usage-basis-migration-suite";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";

factoryUsageBasisMigrationConformance("PGlite", async () => {
  const fixture = await setupTestDb();
  return { db: fixture.db, close: () => fixture.pglite.close() };
});
