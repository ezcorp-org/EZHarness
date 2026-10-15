import { setupTestDb } from "../__tests__/helpers/test-pglite";
import { factoryS3PublicationConformance } from "../__tests__/helpers/factory-s3-publication-suite";

factoryS3PublicationConformance(async () => {
  const fixture = await setupTestDb();
  return { db: fixture.db, close: () => fixture.pglite.close() };
});
