import { factoryMaterialGatewayConformance } from "../__tests__/helpers/factory-material-gateway-suite";
import { setupTestDb } from "../__tests__/helpers/test-pglite";

factoryMaterialGatewayConformance(async () => {
  const { db, pglite } = await setupTestDb();
  return { db, close: () => pglite.close() };
});
