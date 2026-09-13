import { mockDbConnection, setupTestDb } from "./helpers/test-pglite";
import { factoryServiceCredentialsConformance } from "./helpers/factory-service-credentials-suite";

mockDbConnection();

factoryServiceCredentialsConformance(async () => {
  const fixture = await setupTestDb();
  return { db: fixture.db, close: () => fixture.pglite.close() };
});
