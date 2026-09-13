import { factoryExecutionGatewayConformance } from "../__tests__/helpers/factory-execution-gateway-suite";
import { setupTestDb } from "../__tests__/helpers/test-pglite";

factoryExecutionGatewayConformance(async () => {
  const { db, pglite } = await setupTestDb();
  return { db, close: () => pglite.close() };
});
