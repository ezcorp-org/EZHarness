import { factoryRetentionConformance } from "../../src/__tests__/helpers/factory-retention-suite";
import { factoryRecoveryStorage } from "./helpers/factory-recovery-storage";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

factoryRetentionConformance("PostgreSQL and S3", async () => {
  const database = await setupFactoryPostgres();
  const storage = await factoryRecoveryStorage();
  return {
    db: database.db, archive: storage.archive, releaseArchive: storage.releaseArchive, eraser: storage.eraser,
    putCandidate: storage.putCandidate, candidateReadable: storage.candidateReadable,
    async close() { try { console.log(`w15 retention storage cleanup ${JSON.stringify(await storage.cleanup())}`); } finally { await database.close(); } },
  };
});
