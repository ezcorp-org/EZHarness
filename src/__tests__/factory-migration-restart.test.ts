import { setupTestDb } from "./helpers/test-pglite";
import { factoryMigrationRestartConformance } from "./helpers/factory-migration-restart-suite";
import { migrate } from "../db/migrate";

factoryMigrationRestartConformance(async () => {
  const fixture = await setupTestDb();
  return { db: fixture.db, migrate: () => migrate(fixture.db), close: () => fixture.pglite.close() };
});
