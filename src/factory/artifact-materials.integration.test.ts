import { factoryArtifactMaterialsConformance } from "../__tests__/helpers/factory-artifact-materials-suite";
import { setupTestDb } from "../__tests__/helpers/test-pglite";

factoryArtifactMaterialsConformance(async () => {
  const { db, pglite } = await setupTestDb();
  return { db, close: () => pglite.close() };
});
