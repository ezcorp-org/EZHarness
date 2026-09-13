import { setupTestDb } from "./helpers/test-pglite";
import { factoryBudgetsConformance } from "./helpers/factory-budgets-suite";

factoryBudgetsConformance(async () => {
  const fixture = await setupTestDb();
  return { db: fixture.db, close: () => fixture.pglite.close() };
});
