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

  test("creates extension_rbac_grants with the COALESCE grant-scope unique index", async () => {
    expect(await tableNames()).toContain("extension_rbac_grants");
    expect(await indexNames("extension_rbac_grants")).toContain("idx_extension_rbac_grants_scope");
    // The index MUST be the UNIQUE COALESCE form over both nullable scope
    // columns — a plain UNIQUE treats every NULL as distinct, which would
    // allow duplicate all-projects / all-extensions grant rows per user.
    const def = await pglite.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_extension_rbac_grants_scope'",
    );
    expect(def.rows[0]!.indexdef).toContain("UNIQUE");
    expect(def.rows[0]!.indexdef).toContain("user_id");
    expect(def.rows[0]!.indexdef).toMatch(/COALESCE\(project_id/);
    expect(def.rows[0]!.indexdef).toMatch(/COALESCE\(extension_id/);
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

  test("creates github_projects_proposals with the single-active-per-card index (legacy dedupe unique ABSENT)", async () => {
    expect(await tableNames()).toContain("github_projects_proposals");
    const idx = await indexNames("github_projects_proposals");
    expect(idx).toContain("idx_gh_proposals_active_item");
    expect(idx).not.toContain("idx_gh_proposals_dedupe");
    expect(idx).toContain("idx_gh_proposals_project_status");
    expect(idx).toContain("idx_gh_proposals_link");
    // The index is the PARTIAL unique form — active statuses only. Losing the
    // WHERE would block card re-triggers forever; losing UNIQUE would allow
    // double-spawns.
    const def = await pglite.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_gh_proposals_active_item'",
    );
    expect(def.rows[0]!.indexdef).toContain("UNIQUE");
    expect(def.rows[0]!.indexdef).toContain("link_id");
    expect(def.rows[0]!.indexdef).toContain("item_node_id");
    for (const s of ["pending", "approved", "spawned", "running"]) {
      expect(def.rows[0]!.indexdef).toContain(`'${s}'`);
    }
    // dedupe_key survives as a plain provenance column (no index needed).
    const cols = await pglite.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'github_projects_proposals'",
    );
    expect(cols.rows.map((r) => r.column_name)).toContain("dedupe_key");
  });

  test("a second migrate() run is a clean no-op (idempotency incl. the PAT backfill)", async () => {
    await migrate(db);
    // Schema unchanged: the multi-board index is still the only board unique.
    const idx = await indexNames("github_projects_links");
    expect(idx.filter((i) => i === "idx_gh_links_project_board")).toHaveLength(1);
    // The re-trigger index swap is stable too: still exactly one partial
    // unique, still no resurrected legacy dedupe unique.
    const pIdx = await indexNames("github_projects_proposals");
    expect(pIdx.filter((i) => i === "idx_gh_proposals_active_item")).toHaveLength(1);
    expect(pIdx).not.toContain("idx_gh_proposals_dedupe");
    // The RBAC grant-scope unique is stable as well: still exactly one.
    const rIdx = await indexNames("extension_rbac_grants");
    expect(rIdx.filter((i) => i === "idx_extension_rbac_grants_scope")).toHaveLength(1);
  });

  test("legacy DB (old unique dedupe index + a per-column duplicate active card) migrates to the swapped index", async () => {
    // Rewind the proposals table to the LEGACY state: the once-ever
    // UNIQUE(dedupe_key) index present, the partial active index absent.
    await pglite.exec("DROP INDEX IF EXISTS idx_gh_proposals_active_item");
    await pglite.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_gh_proposals_dedupe ON github_projects_proposals(dedupe_key)",
    );
    // Seed the state the old key legitimately allowed: ONE card with TWO
    // active proposals (one per column) — which the new unique index must not
    // choke on at boot — plus a terminal row and a second, single-active card
    // that must both survive untouched.
    await pglite.query(
      "INSERT INTO projects (id, name, path) VALUES ($1, $2, $3)",
      ["proj-legacy", "Legacy", "/tmp/legacy"],
    );
    await pglite.query(
      "INSERT INTO github_projects_links (id, project_id, board_node_id, board_url) VALUES ($1, $2, $3, $4)",
      ["link-legacy", "proj-legacy", "PVT_legacy", "https://github.com/orgs/x/projects/1"],
    );
    const insertProposal =
      "INSERT INTO github_projects_proposals (id, project_id, link_id, item_node_id, status_option_id, action, dedupe_key, status, proposed_at, finished_at) VALUES ($1, 'proj-legacy', 'link-legacy', $2, $3, 'plan', $4, $5, $6, $7)";
    // item-dup: an older RUNNING proposal in column X…
    await pglite.query(insertProposal, [
      "prop-old", "item-dup", "opt-x", "proj-legacy:item-dup:opt-x:plan", "running", "2026-01-01T00:00:00Z", null,
    ]);
    // …and a newer PENDING one in column Y (distinct dedupe key → old index OK).
    await pglite.query(insertProposal, [
      "prop-new", "item-dup", "opt-y", "proj-legacy:item-dup:opt-y:plan", "pending", "2026-02-01T00:00:00Z", null,
    ]);
    // A terminal row for the same card — never part of the active conflict.
    await pglite.query(insertProposal, [
      "prop-done", "item-dup", "opt-x", "proj-legacy:item-dup:opt-x:execute", "done", "2025-12-01T00:00:00Z", "2025-12-02T00:00:00Z",
    ]);
    // A different card with a single active proposal — must be left alone.
    await pglite.query(insertProposal, [
      "prop-solo", "item-solo", "opt-x", "proj-legacy:item-solo:opt-x:plan", "approved", "2026-01-15T00:00:00Z", null,
    ]);

    await migrate(db);

    // Index swap converged: legacy unique gone, partial active unique present.
    const idx = await indexNames("github_projects_proposals");
    expect(idx).toContain("idx_gh_proposals_active_item");
    expect(idx).not.toContain("idx_gh_proposals_dedupe");
    // The boot-safe pre-clean kept the NEWEST active proposal per card and
    // cancelled the older one (stamping finished_at) so the unique CREATE
    // could not fail; terminal + single-active rows are untouched.
    const rows = await pglite.query<{ id: string; status: string; finished_at: string | null }>(
      "SELECT id, status, finished_at FROM github_projects_proposals ORDER BY id",
    );
    const byId = new Map(rows.rows.map((r) => [r.id, r]));
    expect(byId.get("prop-new")!.status).toBe("pending");
    expect(byId.get("prop-old")!.status).toBe("cancelled");
    expect(byId.get("prop-old")!.finished_at).not.toBeNull();
    expect(byId.get("prop-done")!.status).toBe("done");
    expect(byId.get("prop-solo")!.status).toBe("approved");
    // And the swapped index actually ENFORCES: a second active row for a
    // guarded card is rejected at the DB…
    await expect(
      pglite.query(insertProposal, [
        "prop-dup2", "item-solo", "opt-y", "proj-legacy:item-solo:opt-y:plan", "pending", "2026-03-01T00:00:00Z", null,
      ]),
    ).rejects.toThrow(/idx_gh_proposals_active_item|duplicate key/);
    // …while a terminal card is free again (re-trigger semantics).
    await pglite.query(insertProposal, [
      "prop-rerun", "item-done-only", "opt-x", "proj-legacy:item-done-only:opt-x:plan", "done", "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z",
    ]);
    await pglite.query(insertProposal, [
      "prop-rerun2", "item-done-only", "opt-x", "proj-legacy:item-done-only:opt-x:plan", "pending", "2026-03-02T00:00:00Z", null,
    ]);
    const rerun = await pglite.query<{ n: string }>(
      "SELECT count(*) AS n FROM github_projects_proposals WHERE item_node_id = 'item-done-only'",
    );
    expect(Number(rerun.rows[0]!.n)).toBe(2);
  });
});
