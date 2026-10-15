import { factoryReferenceDataConformance } from "../../__tests__/helpers/factory-reference-data-suite";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";

/**
 * The embedded-database leg. `tests/postgres/factory-reference-data.test.ts`
 * runs the same suite on real PostgreSQL with S3-backed blobs, and only that
 * producer runs the 256 MiB boundary.
 *
 * `setupTestDb` closes the previous embedded instance when it opens the next
 * one, so this leg's `close` is idempotent: the suite may still hold a fixture
 * the helper has already shut down, and closing it twice is not a failure.
 */
factoryReferenceDataConformance(async () => {
  const { db, pglite } = await setupTestDb();
  return {
    db,
    close: async () => {
      if (!pglite.closed) await pglite.close();
    },
  };
});
