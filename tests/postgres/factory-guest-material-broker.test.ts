import { randomUUID } from "node:crypto";
import { factoryGuestMaterialBrokerConformance } from "../../src/__tests__/helpers/factory-guest-material-broker-suite";
import { setupFactoryPostgres } from "./helpers/factory-test-database";
import { createFactoryOrdinaryStorage } from "./helpers/factory-storage";

/**
 * The staging broker against real PostgreSQL and the real object store.
 *
 * PGlite and Bun's SQL driver disagree about JSONB, row locking, and advisory
 * locks, and only the real engine shows it. The concurrent-chunk case matters
 * most here: the material row is locked by each write, and a `Promise.all` on a
 * real pool is the only version of that test that can fail.
 */
async function realFixture(label: string) {
  const database = await setupFactoryPostgres();
  const storage = await createFactoryOrdinaryStorage(`ordinary/${label}/${randomUUID()}`);
  return {
    db: database.db,
    blobs: storage.blobs,
    async close() { try { await storage.close(); } finally { await database.close(); } },
  };
}

factoryGuestMaterialBrokerConformance(() => realFixture("factory-guest-material-broker"));
