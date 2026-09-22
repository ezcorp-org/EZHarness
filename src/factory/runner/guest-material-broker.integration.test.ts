import { factoryGuestMaterialBrokerConformance } from "../../__tests__/helpers/factory-guest-material-broker-suite";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";

factoryGuestMaterialBrokerConformance(async () => {
  const { db, pglite } = await setupTestDb();
  return { db, close: () => pglite.close() };
});
