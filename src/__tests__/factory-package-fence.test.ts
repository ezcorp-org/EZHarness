import { setupTestDb } from "./helpers/test-pglite";
import { factoryPackageFenceConformance } from "./helpers/factory-package-fence-suite";

factoryPackageFenceConformance(async () => {
  const fixture = await setupTestDb();
  return { db: fixture.db, close: () => fixture.pglite.close() };
});
