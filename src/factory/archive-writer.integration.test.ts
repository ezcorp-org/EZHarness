import { setupTestDb } from "../__tests__/helpers/test-pglite";
import { factoryArchiveWriterConformance } from "../__tests__/helpers/factory-archive-writer-suite";

factoryArchiveWriterConformance(async () => {
  const fixture = await setupTestDb();
  return { db: fixture.db, close: () => fixture.pglite.close() };
});
