import { setupTestDb } from "./helpers/test-pglite";
import { factoryMigrationRestartConformance } from "./helpers/factory-migration-restart-suite";

factoryMigrationRestartConformance(async () => {
  const fixture = await setupTestDb();
  return { db: fixture.db, close: () => fixture.pglite.close() };
});
