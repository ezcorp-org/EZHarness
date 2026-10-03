import { mockDbConnection, setupTestDb } from "./helpers/test-pglite";
import { factoryProjectCreationConformance } from "./helpers/factory-project-creation-suite";

mockDbConnection();
factoryProjectCreationConformance(async () => {
  const { db, pglite } = await setupTestDb();
  return { db, close: () => pglite.close() };
});
