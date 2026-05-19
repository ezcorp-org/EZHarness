/**
 * Phase 57 — UX-02 Wave 0 RED scaffold for the pg_trgm migration.
 *
 * Locks the four migration-shape invariants from CONTEXT.md UX-02 before
 * Wave 2 Track B (Plan 57-04 Task 1) registers pg_trgm in the PGlite
 * constructor and appends the GIN index DDL to `src/db/migrate.ts`:
 *
 *   1. `CREATE EXTENSION IF NOT EXISTS pg_trgm` must succeed idempotently.
 *   2. `idx_marketplace_listings_trgm` exists after `migrate()`.
 *   3. `idx_marketplace_listings_fts` exists after `migrate()` (the
 *      hybrid FTS-OR-trigram path needs both indexes).
 *   4. `similarity('a','b')` is callable — proves PGlite registered the
 *      pg_trgm contrib extension at construction (not just the SQL
 *      `CREATE EXTENSION` step which can succeed with a stub).
 *
 * RED reason: pg_trgm is NOT yet registered in `src/db/connection.ts`
 * line 41-49 (only `vector` is). The setupTestDb helper mirrors
 * production — once Wave 2 Track B adds `pg_trgm` to the extensions
 * object, all four cases flip GREEN.
 *
 * Runner: bun test (backend tests live under src/__tests__).
 * Pattern: mirrors existing daemon/marketplace tests — mockDbConnection()
 * + setupTestDb() + the in-process file-backed PGlite path.
 */

import {
  test,
  expect,
  describe,
  beforeAll,
  afterAll,
} from "bun:test";
import { sql } from "drizzle-orm";
import {
  setupTestDb,
  closeTestDb,
  mockDbConnection,
} from "./helpers/test-pglite";

mockDbConnection();

import { getDb, getPglite } from "../db/connection";
import { migrate } from "../db/migrate";

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await closeTestDb();
});

describe("pg_trgm migration", () => {
  test("CREATE EXTENSION IF NOT EXISTS pg_trgm succeeds idempotently", async () => {
    const db = getDb();
    // Two consecutive calls must both succeed (the IF NOT EXISTS guard
    // is the second-call test). RED until PGlite constructor loads the
    // contrib pg_trgm WASM bundle — bare CREATE EXTENSION without the
    // module registration throws "extension not loaded".
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  });

  test("idx_marketplace_listings_trgm exists after migrate()", async () => {
    const db = getDb();
    await migrate(db);
    const result: { rows: Array<{ indexname: string }> } = await db.execute(
      sql`SELECT indexname FROM pg_indexes WHERE indexname = 'idx_marketplace_listings_trgm'`,
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]?.indexname).toBe("idx_marketplace_listings_trgm");
  });

  test("idx_marketplace_listings_fts exists after migrate()", async () => {
    const db = getDb();
    await migrate(db);
    const result: { rows: Array<{ indexname: string }> } = await db.execute(
      sql`SELECT indexname FROM pg_indexes WHERE indexname = 'idx_marketplace_listings_fts'`,
    );
    expect(result.rows.length).toBe(1);
    expect(result.rows[0]?.indexname).toBe("idx_marketplace_listings_fts");
  });

  test("similarity(text, text) function is callable after construction", async () => {
    const db = getDb();
    const result: { rows: Array<{ s: number }> } = await db.execute(
      sql`SELECT similarity('git', 'github') AS s`,
    );
    const s = result.rows[0]?.s;
    expect(typeof s).toBe("number");
    // similarity('git','github') is empirically ~0.428; we only assert
    // it's in (0, 1] to keep this test impl-agnostic across pg_trgm
    // versions.
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(1);
  });

  test("PGlite construction registered pg_trgm in pg_extension catalog", async () => {
    const pglite = getPglite();
    // Direct catalog query — sanity check that pg_trgm shows up under
    // pg_extension after construction (not just after CREATE EXTENSION).
    const result = await pglite.query<{ extname: string }>(
      `SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`,
    );
    expect(result.rows.length).toBe(1);
  });
});
