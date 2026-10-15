import { setupTestDb } from "../__tests__/helpers/test-pglite";
import { factoryReleaseAuthorityConformance } from "../__tests__/helpers/factory-release-authority-suite";

factoryReleaseAuthorityConformance(async () => {
  const fixture = await setupTestDb();
  return { db: fixture.db, close: () => fixture.pglite.close() };
});
