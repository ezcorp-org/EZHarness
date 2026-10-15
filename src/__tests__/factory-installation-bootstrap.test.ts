import { mockDbConnection, setupTestDb } from "./helpers/test-pglite";
import { factoryInstallationBootstrapConformance } from "./helpers/factory-installation-bootstrap-suite";

mockDbConnection();
factoryInstallationBootstrapConformance(async () => {
  const { db, pglite } = await setupTestDb();
  return { db, close: () => pglite.close() };
});
