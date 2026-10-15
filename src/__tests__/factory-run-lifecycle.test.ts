import { factoryRunLifecycleConformance } from "./helpers/factory-run-lifecycle-suite";
import { setupTestDb } from "./helpers/test-pglite";

factoryRunLifecycleConformance(async () => {
  const { db, pglite } = await setupTestDb();
  return { db, close: () => pglite.close() };
});
