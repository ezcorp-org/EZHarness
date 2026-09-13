import { setupTestDb } from "../__tests__/helpers/test-pglite";
import { factoryAssuranceConformance } from "../__tests__/helpers/factory-assurance-suite";

factoryAssuranceConformance(async () => { const fixture = await setupTestDb(); return { db: fixture.db, close: () => fixture.pglite.close() }; });
