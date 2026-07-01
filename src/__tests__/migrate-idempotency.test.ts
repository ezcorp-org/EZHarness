import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";

/**
 * SMALL, mock.module-free shard so migrate()'s per-line DA survives Bun's
 * large-suite attribution drift (the DB suites all run migrate() via
 * setupTestDb(), but their lcov drops migrate.ts lines — see the
 * bun-coverage-attribution-drift note). Gates the PR-changed DDL: the
 * extension_secrets store, the github-projects tables/indexes, the
 * legacy→multi-board unique swap, and the settings-PAT backfill call —
 * all proven idempotent by a second migrate() run.
 */
describe("migrate() — fresh DB + idempotent re-run", () => {
  let pglite: PGlite;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    pglite = new PGlite({ extensions: { vector, pg_trgm } });
    await pglite.waitReady;
    db = drizzle(pglite, { schema });
    await migrate(db);
  }, 30_000);

  afterAll(async () => {
    await pglite.close().catch(() => {});
  });

  async function tableNames(): Promise<string[]> {
    const res = await pglite.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'",
    );
    return res.rows.map((r) => r.table_name);
  }

  async function indexNames(table: string): Promise<string[]> {
    const res = await pglite.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE tablename = $1",
      [table],
    );
    return res.rows.map((r) => r.indexname);
  }

  test("creates the extension_secrets store with the COALESCE scope index", async () => {
    expect(await tableNames()).toContain("extension_secrets");
    expect(await indexNames("extension_secrets")).toContain("idx_extension_secrets_scope");
  });

  test("creates github_projects_links with the multi-board unique index (no legacy project-unique)", async () => {
    expect(await tableNames()).toContain("github_projects_links");
    const idx = await indexNames("github_projects_links");
    expect(idx).toContain("idx_gh_links_project_board");
    expect(idx).not.toContain("idx_gh_links_project_unique");
    // Columns added by the per-board defaults + write-back features exist.
    const cols = await pglite.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'github_projects_links'",
    );
    const names = cols.rows.map((r) => r.column_name);
    for (const c of ["status_options", "default_model", "default_permission_mode"]) {
      expect(names).toContain(c);
    }
  });

  test("creates github_projects_proposals with dedupe + lookup indexes", async () => {
    expect(await tableNames()).toContain("github_projects_proposals");
    const idx = await indexNames("github_projects_proposals");
    expect(idx).toContain("idx_gh_proposals_dedupe");
    expect(idx).toContain("idx_gh_proposals_project_status");
    expect(idx).toContain("idx_gh_proposals_link");
  });

  test("a second migrate() run is a clean no-op (idempotency incl. the PAT backfill)", async () => {
    await migrate(db);
    // Schema unchanged: the multi-board index is still the only board unique.
    const idx = await indexNames("github_projects_links");
    expect(idx.filter((i) => i === "idx_gh_links_project_board")).toHaveLength(1);
  });
});
