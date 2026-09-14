import { factoryTenantProjectsConformance } from "./helpers/factory-tenant-projects-suite";
import { setupTestDb } from "./helpers/test-pglite";

factoryTenantProjectsConformance(async () => {
  const { db, pglite } = await setupTestDb();
  return { db, close: () => pglite.close() };
});
