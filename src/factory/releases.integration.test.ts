import { setupTestDb } from "../__tests__/helpers/test-pglite";
import { factoryReleaseConformance } from "../__tests__/helpers/factory-release-suite";

factoryReleaseConformance(async () => {
  const fixture = await setupTestDb();
  return { db: fixture.db, close: () => fixture.pglite.close() };
});
