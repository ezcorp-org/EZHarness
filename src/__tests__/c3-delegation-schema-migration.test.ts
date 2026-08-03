/**
 * C3 phase 1 — schema + migration for delegated execution.
 *
 * Covers `service_accounts`, `workflow_delegations` and the three additive
 * `workflow_runs` columns (`run_as_kind`, `run_as`, `delegation_id`).
 *
 * Everything here is asserted by EXECUTION, never by reading the DDL:
 *   - idempotence is proved by running `migrate()` twice, against a fresh
 *     database AND against the worst realistic pre-state;
 *   - every FK's delete action is asserted twice — once from `pg_constraint`
 *     (so the catalog says what we think it says) and once by performing the
 *     delete (so the catalog is not lying about the effect);
 *   - the two partial unique/filtered indexes are proved by inserting rows
 *     that a TOTAL index would have rejected.
 *
 * The instance is built with the `vector` + `pg_trgm` extensions registered
 * at construction, mirroring `db/connection.ts`'s `initPglite()` — a bare
 * PGlite has no `vector` and `migrate()`'s first statement would fail.
 */
import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { DELEGATION_OWNER_COLUMN, workflowDelegations } from "../db/schema";
import { migrate } from "../db/migrate";

type Db = ReturnType<typeof drizzle<typeof schema>>;

/** `pg_constraint.confdeltype` → the ON DELETE action it encodes. */
const DELETE_ACTION: Record<string, string> = {
  a: "NO ACTION",
  r: "RESTRICT",
  c: "CASCADE",
  n: "SET NULL",
  d: "SET DEFAULT",
};

interface FkRow { col: string; reftable: string; confdeltype: string }

/**
 * Every single-column FK on `table`, as `column → { action, references }`.
 * Read from the catalog rather than from the migration text so a constraint
 * that failed to apply cannot pass by looking right in the source.
 */
async function foreignKeys(db: Db, table: string): Promise<Record<string, { action: string; references: string }>> {
  const res = (await db.execute(sql`
    SELECT a.attname AS col, cl.relname AS reftable, c.confdeltype
    FROM pg_constraint c
    JOIN pg_class cl ON cl.oid = c.confrelid
    JOIN LATERAL unnest(c.conkey) AS k(attnum) ON true
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
    WHERE c.contype = 'f' AND c.conrelid = ${table}::regclass
  `)) as { rows: FkRow[] };
  const out: Record<string, { action: string; references: string }> = {};
  for (const r of res.rows) {
    out[r.col] = { action: DELETE_ACTION[r.confdeltype] ?? r.confdeltype, references: r.reftable };
  }
  return out;
}

async function indexDefs(db: Db): Promise<Map<string, string>> {
  const res = (await db.execute(sql`
    SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'
  `)) as { rows: Array<{ indexname: string; indexdef: string }> };
  return new Map(res.rows.map((r) => [r.indexname, r.indexdef]));
}

interface ColRow { column_name: string; data_type: string; is_nullable: string; column_default: string | null }

async function columns(db: Db, table: string): Promise<ColRow[]> {
  const res = (await db.execute(sql`
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table}
    ORDER BY column_name
  `)) as { rows: ColRow[] };
  return res.rows;
}

async function count(db: Db, query: ReturnType<typeof sql>): Promise<number> {
  const res = (await db.execute(query)) as { rows: Array<{ n: number | string }> };
  return Number(res.rows[0]?.n ?? 0);
}

/**
 * Run `fn` and return the Postgres SQLSTATE it raised, or `null` if it
 * succeeded. drizzle wraps driver errors in a `DrizzleQueryError`, so the
 * SQLSTATE lives on `.cause`, not on the thrown error — walk the chain
 * rather than reading only the top, which would report every constraint
 * violation as "no code" and make a REJECTED insert indistinguishable from
 * an ACCEPTED one.
 */
async function errCode(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    let cur: unknown = e;
    for (let hop = 0; cur && hop < 5; hop++) {
      const code = (cur as { code?: unknown }).code;
      if (typeof code === "string") return code;
      cur = (cur as { cause?: unknown }).cause;
    }
    return `NO-CODE:${(e as Error).message}`;
  }
}

async function freshMigrated(): Promise<{ pg: PGlite; db: Db }> {
  const pg = new PGlite({ extensions: { vector, pg_trgm } });
  await pg.waitReady;
  const db = drizzle(pg, { schema });
  await migrate(db);
  return { pg, db };
}

/**
 * Fixture graph: two humans, an admin, a project, an extension, a workflow
 * definition and one version of it — i.e. one live instance of every FK
 * target `workflow_delegations` and `service_accounts` reach.
 */
async function seedFixtures(db: Db, suffix: string) {
  const id = (p: string) => `${p}-${suffix}`;
  await db.execute(sql`
    INSERT INTO users (id, email, password_hash, name, role, status) VALUES
      (${id("u-owner")},   ${`owner-${suffix}@x.test`},   'h', 'Owner',   'member', 'active'),
      (${id("u-consent")}, ${`consent-${suffix}@x.test`}, 'h', 'Consent', 'admin',  'active'),
      (${id("u-other")},   ${`other-${suffix}@x.test`},   'h', 'Other',   'member', 'active')
  `);
  await db.execute(sql`INSERT INTO projects (id, name, path) VALUES (${id("p")}, ${`Proj ${suffix}`}, '/tmp/x')`);
  await db.execute(sql`
    INSERT INTO extensions (id, name, version, manifest, source)
    VALUES (${id("e")}, ${`ext-${suffix}`}, '1.0.0', '{}'::jsonb, 'local')
  `);
  await db.execute(sql`
    INSERT INTO workflow_definitions (id, name, steps)
    VALUES (${id("wd")}, ${`wf-${suffix}`}, '[{"name":"s1","agent":"a"}]'::jsonb)
  `);
  await db.execute(sql`
    INSERT INTO workflow_definition_versions (id, workflow_definition_id, version, name, steps, steps_hash)
    VALUES (${id("v")}, ${id("wd")}, 1, ${`wf-${suffix}`}, '[{"name":"s1","agent":"a"}]'::jsonb, 'sha-1')
  `);
  return {
    owner: id("u-owner"),
    consent: id("u-consent"),
    other: id("u-other"),
    project: id("p"),
    extension: id("e"),
    definition: id("wd"),
    version: id("v"),
  };
}

interface DelegationOpts {
  id: string;
  extension: string;
  jobRef: string;
  kind: "user" | "service";
  ownerUser?: string | null;
  ownerService?: string | null;
  consentedBy: string;
  version?: string | null;
  project?: string | null;
  revokedAt?: string | null;
}

async function insertDelegation(db: Db, o: DelegationOpts) {
  await db.execute(sql`
    INSERT INTO workflow_delegations (
      id, extension_id, job_ref, owner_kind, owner_user_id, owner_service_account_id,
      workflow_name, definition_version_id, project_id, trigger_kind, consent_hash,
      max_tokens_per_run, max_runs_per_day, consented_by_user_id, revoked_at
    ) VALUES (
      ${o.id}, ${o.extension}, ${o.jobRef}, ${o.kind}, ${o.ownerUser ?? null}, ${o.ownerService ?? null},
      'nightly', ${o.version ?? null}, ${o.project ?? null}, 'cron', 'hash-1',
      100000, 10, ${o.consentedBy}, ${o.revokedAt ?? null}
    )
  `);
}

async function insertServiceAccount(db: Db, id: string, name: string, createdBy: string, project?: string | null) {
  await db.execute(sql`
    INSERT INTO service_accounts (id, name, created_by_user_id, project_id, max_tokens_per_day)
    VALUES (${id}, ${name}, ${createdBy}, ${project ?? null}, 500000)
  `);
}

/** A run as it is written by a delegated fire: `user_id` NULL for the service arm. */
async function insertRun(
  db: Db,
  o: { id: string; userId?: string | null; runAsKind?: string | null; runAs?: string | null; delegation?: string | null },
) {
  await db.execute(sql`
    INSERT INTO workflow_runs (id, workflow_name, user_id, status, started_at, run_as_kind, run_as, delegation_id)
    VALUES (${o.id}, 'nightly', ${o.userId ?? null}, 'success', NOW(), ${o.runAsKind ?? null}, ${o.runAs ?? null}, ${o.delegation ?? null})
  `);
}

// ───────────────────────────────────────────────────────────────────
// Shape: tables, columns, indexes, and the FK map as the catalog sees it
// ───────────────────────────────────────────────────────────────────
describe("C3 schema — shape after migrate()", () => {
  let pg: PGlite;
  let db: Db;

  beforeAll(async () => { ({ pg, db } = await freshMigrated()); });
  afterAll(async () => { await pg?.close().catch(() => {}); });

  test("both C3 tables exist", async () => {
    const res = (await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('service_accounts', 'workflow_delegations')
      ORDER BY table_name
    `)) as { rows: Array<{ table_name: string }> };
    expect(res.rows.map((r) => r.table_name)).toEqual(["service_accounts", "workflow_delegations"]);
  });

  test("workflow_delegations carries max_tokens_per_run and NO max_cost_cents_per_run", async () => {
    // The 2026-08-02 ruling: the enforced bound is TOKENS. Shipping the
    // cost-named column would be a spend cap that an unpriced
    // (OAuth-subscription) model silently escapes.
    const names = (await columns(db, "workflow_delegations")).map((c) => c.column_name);
    expect(names).toContain("max_tokens_per_run");
    expect(names).not.toContain("max_cost_cents_per_run");
  });

  test("service_accounts carries max_tokens_per_day and NO max_cost_cents_per_day", async () => {
    const names = (await columns(db, "service_accounts")).map((c) => c.column_name);
    expect(names).toContain("max_tokens_per_day");
    expect(names).not.toContain("max_cost_cents_per_day");
  });

  test("owner_kind and consented_by_user_id are NOT NULL; both owner arms are nullable", async () => {
    // `owner_kind` NOT NULL is what makes it a discriminator rather than a
    // hint. Both owner columns are nullable because exactly one is
    // populated per kind — a service account has no `users` row and a user
    // owner has no `service_accounts` row.
    const cols = new Map((await columns(db, "workflow_delegations")).map((c) => [c.column_name, c.is_nullable]));
    expect(cols.get("owner_kind")).toBe("NO");
    expect(cols.get("consented_by_user_id")).toBe("NO");
    expect(cols.get("owner_user_id")).toBe("YES");
    expect(cols.get("owner_service_account_id")).toBe("YES");
  });

  test("the three workflow_runs columns exist and are all nullable", async () => {
    // Nullable with no default and no backfill: every pre-C3 run executed
    // as its initiating `user_id`, so NULL is the honest value.
    const cols = new Map((await columns(db, "workflow_runs")).map((c) => [c.column_name, c]));
    for (const name of ["run_as_kind", "run_as", "delegation_id"]) {
      expect(cols.get(name)?.is_nullable).toBe("YES");
      expect(cols.get(name)?.column_default).toBeNull();
    }
  });

  test("every index the spec names exists", async () => {
    const idx = await indexDefs(db);
    for (const name of [
      "uniq_service_account_name",
      "uniq_workflow_delegation",
      "idx_workflow_delegations_owner_user",
      "idx_workflow_delegations_owner_service",
      "idx_workflow_delegations_enabled",
      "idx_workflow_runs_run_as",
    ]) {
      expect(idx.has(name)).toBe(true);
    }
  });

  test("the FK-scan indexes the spec's list omits also exist", async () => {
    // Each backs a delete action that would otherwise sequentially scan a
    // table that grows without bound: the two RESTRICT checks and the
    // delegation SET NULL. `idx_workflow_delegations_consented_by` doubles
    // as the approvals-inbox disjunct's driving predicate.
    const idx = await indexDefs(db);
    for (const name of [
      "idx_service_accounts_created_by",
      "idx_workflow_delegations_consented_by",
      "idx_workflow_delegations_version",
      "idx_workflow_runs_delegation",
    ]) {
      expect(idx.has(name)).toBe(true);
    }
  });

  test("the two live-row indexes are PARTIAL on revoked_at IS NULL", async () => {
    // A total unique index would make re-consenting a revoked job
    // impossible, and a total `enabled` index would keep tombstones in the
    // fire-time lookup.
    const idx = await indexDefs(db);
    expect(idx.get("uniq_workflow_delegation")).toContain("revoked_at IS NULL");
    expect(idx.get("uniq_workflow_delegation")).toContain("UNIQUE");
    expect(idx.get("idx_workflow_delegations_enabled")).toContain("revoked_at IS NULL");
  });

  test("workflow_delegations FK actions are exactly as decided", async () => {
    expect(await foreignKeys(db, "workflow_delegations")).toEqual({
      extension_id: { action: "CASCADE", references: "extensions" },
      owner_user_id: { action: "CASCADE", references: "users" },
      owner_service_account_id: { action: "CASCADE", references: "service_accounts" },
      consented_by_user_id: { action: "RESTRICT", references: "users" },
      definition_version_id: { action: "RESTRICT", references: "workflow_definition_versions" },
      project_id: { action: "CASCADE", references: "projects" },
    });
  });

  test("service_accounts FK actions are exactly as decided", async () => {
    expect(await foreignKeys(db, "service_accounts")).toEqual({
      created_by_user_id: { action: "RESTRICT", references: "users" },
      project_id: { action: "CASCADE", references: "projects" },
    });
  });

  test("run_as_kind and run_as carry NO foreign key; delegation_id is SET NULL", async () => {
    // The pair is an audit SNAPSHOT that must outlive both revocation and
    // owner deletion, so it deliberately has nothing to cascade from.
    const fks = await foreignKeys(db, "workflow_runs");
    expect(fks.run_as).toBeUndefined();
    expect(fks.run_as_kind).toBeUndefined();
    expect(fks.delegation_id).toEqual({ action: "SET NULL", references: "workflow_delegations" });
  });

  test("FK direction is delegations → users, never users → delegations", async () => {
    // Direction, not just action: an FK pointing the other way would make
    // deleting a delegation able to reach a user row.
    expect(Object.keys(await foreignKeys(db, "users"))).toEqual([]);
    const fromDelegations = await foreignKeys(db, "workflow_delegations");
    expect(fromDelegations.consented_by_user_id?.references).toBe("users");
    expect(fromDelegations.owner_user_id?.references).toBe("users");
  });

  test("FK direction is runs → delegations, never delegations → runs", async () => {
    const fromDelegations = await foreignKeys(db, "workflow_delegations");
    expect(Object.values(fromDelegations).map((f) => f.references)).not.toContain("workflow_runs");
    expect((await foreignKeys(db, "workflow_runs")).delegation_id?.references).toBe("workflow_delegations");
  });

  test("DELEGATION_OWNER_COLUMN maps each kind to the column whose FK matches that kind", async () => {
    // The §11.2 rule made mechanical: consumers resolve the owner through
    // this map, so a third kind is one entry plus one column and never a
    // two-armed `switch` that silently falls through.
    //
    // Asserted against the CATALOG, not against a literal: the `user` arm
    // must land on a column that references `users` and the `service` arm
    // on one that references `service_accounts`. A map that pointed both
    // kinds at the same column would satisfy "these are real columns" and
    // would silently resolve every service principal to a user id.
    expect(Object.keys(DELEGATION_OWNER_COLUMN).sort()).toEqual(["service", "user"]);
    const fks = await foreignKeys(db, "workflow_delegations");
    const expectedTarget: Record<string, string> = { user: "users", service: "service_accounts" };
    const seen = new Set<string>();
    for (const [kind, prop] of Object.entries(DELEGATION_OWNER_COLUMN)) {
      const column = workflowDelegations[prop as keyof typeof workflowDelegations] as { name?: string } | undefined;
      expect(typeof column?.name).toBe("string");
      expect(fks[column?.name ?? ""]?.references).toBe(expectedTarget[kind] as string);
      seen.add(prop);
    }
    // Distinct columns — one row can then carry exactly one populated arm.
    expect(seen.size).toBe(2);
  });
});

// ───────────────────────────────────────────────────────────────────
// FK behaviour: prove each delete action by performing the delete
// ───────────────────────────────────────────────────────────────────
describe("C3 schema — FK delete behaviour, executed", () => {
  let pg: PGlite;
  let db: Db;
  let n = 0;
  let f: Awaited<ReturnType<typeof seedFixtures>>;

  beforeAll(async () => { ({ pg, db } = await freshMigrated()); });
  afterAll(async () => { await pg?.close().catch(() => {}); });
  // A fresh fixture graph per test — every test here DELETES part of it.
  beforeEach(async () => { f = await seedFixtures(db, `fk${n++}`); });

  test("deleting the extension deletes its delegations (CASCADE)", async () => {
    await insertDelegation(db, { id: `d-${f.extension}`, extension: f.extension, jobRef: "j1", kind: "user", ownerUser: f.owner, consentedBy: f.owner });
    await db.execute(sql`DELETE FROM extensions WHERE id = ${f.extension}`);
    expect(await count(db, sql`SELECT COUNT(*)::int AS n FROM workflow_delegations WHERE id = ${`d-${f.extension}`}`)).toBe(0);
  });

  test("deleting a user-kind owner deletes the delegation (CASCADE, not SET NULL)", async () => {
    // SET NULL here would leave an `enabled` row carrying a valid consent
    // hash and naming NOBODY — the latent ownerless grant `-32106` exists
    // to prevent.
    await insertDelegation(db, { id: `d-${f.owner}`, extension: f.extension, jobRef: "j2", kind: "user", ownerUser: f.owner, consentedBy: f.owner });
    await db.execute(sql`DELETE FROM users WHERE id = ${f.owner}`);
    expect(await count(db, sql`SELECT COUNT(*)::int AS n FROM workflow_delegations WHERE id = ${`d-${f.owner}`}`)).toBe(0);
  });

  test("deleting a service account deletes its delegations (CASCADE)", async () => {
    await insertServiceAccount(db, `sa-${f.extension}`, `sa-${f.extension}`, f.consent);
    await insertDelegation(db, { id: `d-sa-${f.extension}`, extension: f.extension, jobRef: "j3", kind: "service", ownerService: `sa-${f.extension}`, consentedBy: f.consent });
    await db.execute(sql`DELETE FROM service_accounts WHERE id = ${`sa-${f.extension}`}`);
    expect(await count(db, sql`SELECT COUNT(*)::int AS n FROM workflow_delegations WHERE id = ${`d-sa-${f.extension}`}`)).toBe(0);
  });

  test("deleting the consenting human of a SERVICE delegation is REFUSED (RESTRICT)", async () => {
    // The service arm is the whole reason this is RESTRICT and not CASCADE:
    // CASCADE would kill an org-level job the moment the admin who consented
    // to it leaves, destroying the durability property service accounts
    // exist to provide.
    await insertServiceAccount(db, `sa2-${f.extension}`, `sa2-${f.extension}`, f.other);
    await insertDelegation(db, { id: `d-r-${f.extension}`, extension: f.extension, jobRef: "j4", kind: "service", ownerService: `sa2-${f.extension}`, consentedBy: f.consent });
    expect(await errCode(() => db.execute(sql`DELETE FROM users WHERE id = ${f.consent}`))).toBe("23503");
    expect(await count(db, sql`SELECT COUNT(*)::int AS n FROM workflow_delegations WHERE id = ${`d-r-${f.extension}`}`)).toBe(1);
  });

  test("a user-kind delegation whose owner IS the consenter still deletes with the user", async () => {
    // The counter-intuitive one, and the reason RESTRICT above is safe:
    // with a CASCADE arm and a RESTRICT arm both naming the same users row,
    // Postgres runs the CASCADE first and the RESTRICT check then finds no
    // referencing row. Predicting a deadlock here is the natural mistake.
    await insertDelegation(db, { id: `d-both-${f.owner}`, extension: f.extension, jobRef: "j5", kind: "user", ownerUser: f.owner, consentedBy: f.owner });
    expect(await errCode(() => db.execute(sql`DELETE FROM users WHERE id = ${f.owner}`))).toBeNull();
    expect(await count(db, sql`SELECT COUNT(*)::int AS n FROM workflow_delegations WHERE id = ${`d-both-${f.owner}`}`)).toBe(0);
  });

  test("deleting a version pinned by a delegation is REFUSED (RESTRICT)", async () => {
    // The consent hash names this exact snapshot; reaping it would leave
    // the record referencing something that no longer exists.
    await insertDelegation(db, { id: `d-v-${f.version}`, extension: f.extension, jobRef: "j6", kind: "user", ownerUser: f.owner, consentedBy: f.owner, version: f.version });
    expect(await errCode(() => db.execute(sql`DELETE FROM workflow_definition_versions WHERE id = ${f.version}`))).toBe("23503");
    expect(await count(db, sql`SELECT COUNT(*)::int AS n FROM workflow_delegations WHERE id = ${`d-v-${f.version}`}`)).toBe(1);
  });

  test("deleting the project deletes its delegations (CASCADE)", async () => {
    await insertDelegation(db, { id: `d-p-${f.project}`, extension: f.extension, jobRef: "j7", kind: "user", ownerUser: f.owner, consentedBy: f.owner, project: f.project });
    await db.execute(sql`DELETE FROM projects WHERE id = ${f.project}`);
    expect(await count(db, sql`SELECT COUNT(*)::int AS n FROM workflow_delegations WHERE id = ${`d-p-${f.project}`}`)).toBe(0);
  });

  test("deleting the admin who created a service account is REFUSED (RESTRICT)", async () => {
    await insertServiceAccount(db, `sa3-${f.extension}`, `sa3-${f.extension}`, f.consent);
    expect(await errCode(() => db.execute(sql`DELETE FROM users WHERE id = ${f.consent}`))).toBe("23503");
    expect(await count(db, sql`SELECT COUNT(*)::int AS n FROM service_accounts WHERE id = ${`sa3-${f.extension}`}`)).toBe(1);
  });

  test("deleting a project deletes its service accounts (CASCADE)", async () => {
    await insertServiceAccount(db, `sa4-${f.extension}`, `sa4-${f.extension}`, f.other, f.project);
    await db.execute(sql`DELETE FROM projects WHERE id = ${f.project}`);
    expect(await count(db, sql`SELECT COUNT(*)::int AS n FROM service_accounts WHERE id = ${`sa4-${f.extension}`}`)).toBe(0);
  });

  test("deleting a delegation keeps the run and nulls only delegation_id (SET NULL)", async () => {
    // The run's `run_as` snapshot is what keeps history readable after the
    // authority is gone. CASCADE here would erase the record of what a
    // revoked delegation actually ran.
    await insertDelegation(db, { id: `d-run-${f.owner}`, extension: f.extension, jobRef: "j8", kind: "user", ownerUser: f.owner, consentedBy: f.owner });
    await insertRun(db, { id: `r-${f.owner}`, userId: f.owner, runAsKind: "user", runAs: f.owner, delegation: `d-run-${f.owner}` });
    await db.execute(sql`DELETE FROM workflow_delegations WHERE id = ${`d-run-${f.owner}`}`);
    const res = (await db.execute(sql`
      SELECT delegation_id, run_as_kind, run_as FROM workflow_runs WHERE id = ${`r-${f.owner}`}
    `)) as { rows: Array<{ delegation_id: string | null; run_as_kind: string | null; run_as: string | null }> };
    expect(res.rows).toEqual([{ delegation_id: null, run_as_kind: "user", run_as: f.owner }]);
  });

  test("run_as survives deletion of the user it names (no FK to fire)", async () => {
    // Proves the absence of the FK by effect: a snapshot naming a deleted
    // principal is exactly what the audit record is for.
    await insertRun(db, { id: `r-snap-${f.owner}`, userId: f.owner, runAsKind: "user", runAs: f.owner });
    await db.execute(sql`DELETE FROM users WHERE id = ${f.owner}`);
    const res = (await db.execute(sql`
      SELECT user_id, run_as FROM workflow_runs WHERE id = ${`r-snap-${f.owner}`}
    `)) as { rows: Array<{ user_id: string | null; run_as: string | null }> };
    expect(res.rows).toEqual([{ user_id: null, run_as: f.owner }]);
  });

  test("run_as may name a principal that never existed (no FK to reject it)", async () => {
    expect(await errCode(() => insertRun(db, { id: `r-ghost-${f.owner}`, runAsKind: "service", runAs: "no-such-principal" }))).toBeNull();
  });

  test("delegation_id naming no delegation IS rejected (the FK that does exist)", async () => {
    // Discriminates the previous test: the snapshot is unconstrained, the
    // live pointer is not.
    expect(await errCode(() => insertRun(db, { id: `r-bad-${f.owner}`, delegation: "no-such-delegation" }))).toBe("23503");
  });
});

// ───────────────────────────────────────────────────────────────────
// Both identity kinds, revocation, and failing closed
// ───────────────────────────────────────────────────────────────────
describe("C3 schema — both owner kinds and revocation", () => {
  let pg: PGlite;
  let db: Db;
  let n = 0;
  let f: Awaited<ReturnType<typeof seedFixtures>>;

  beforeAll(async () => { ({ pg, db } = await freshMigrated()); });
  afterAll(async () => { await pg?.close().catch(() => {}); });
  beforeEach(async () => { f = await seedFixtures(db, `ok${n++}`); });

  test("both kinds are representable and distinguishable at the row level", async () => {
    await insertServiceAccount(db, `sa-${f.extension}`, `sa-${f.extension}`, f.consent);
    await insertDelegation(db, { id: `du-${f.extension}`, extension: f.extension, jobRef: "ju", kind: "user", ownerUser: f.owner, consentedBy: f.owner });
    await insertDelegation(db, { id: `ds-${f.extension}`, extension: f.extension, jobRef: "js", kind: "service", ownerService: `sa-${f.extension}`, consentedBy: f.consent });
    const res = (await db.execute(sql`
      SELECT owner_kind, owner_user_id, owner_service_account_id
      FROM workflow_delegations WHERE extension_id = ${f.extension} ORDER BY owner_kind
    `)) as { rows: Array<{ owner_kind: string; owner_user_id: string | null; owner_service_account_id: string | null }> };
    expect(res.rows).toEqual([
      { owner_kind: "service", owner_user_id: null, owner_service_account_id: `sa-${f.extension}` },
      { owner_kind: "user", owner_user_id: f.owner, owner_service_account_id: null },
    ]);
  });

  test("a service-kind run has NULL user_id yet still reaches a real consenting human", async () => {
    // The R2-c precondition. A service account has no `users` row, so
    // `workflow_runs.user_id` is NULL and the approval path's ownership
    // test collapses to admin-only. `consented_by_user_id`, reached through
    // `delegation_id`, is the answering human — and the join proves the
    // schema can express it.
    await insertServiceAccount(db, `sa2-${f.extension}`, `sa2-${f.extension}`, f.consent);
    await insertDelegation(db, { id: `ds2-${f.extension}`, extension: f.extension, jobRef: "js2", kind: "service", ownerService: `sa2-${f.extension}`, consentedBy: f.consent });
    await insertRun(db, { id: `rs-${f.extension}`, userId: null, runAsKind: "service", runAs: `sa2-${f.extension}`, delegation: `ds2-${f.extension}` });
    const res = (await db.execute(sql`
      SELECT r.user_id, u.id AS answerer, u.email
      FROM workflow_runs r
      JOIN workflow_delegations d ON d.id = r.delegation_id
      JOIN users u ON u.id = d.consented_by_user_id
      WHERE r.id = ${`rs-${f.extension}`} AND d.revoked_at IS NULL
    `)) as { rows: Array<{ user_id: string | null; answerer: string }> };
    expect(res.rows.length).toBe(1);
    expect(res.rows[0]?.user_id).toBeNull();
    expect(res.rows[0]?.answerer).toBe(f.consent);
  });

  test("a revoked delegation drops out of the live lookup — fails closed by default", async () => {
    await insertDelegation(db, { id: `dr-${f.extension}`, extension: f.extension, jobRef: "jr", kind: "user", ownerUser: f.owner, consentedBy: f.owner, revokedAt: "2026-01-01T00:00:00Z" });
    // The row is still there as history …
    expect(await count(db, sql`SELECT COUNT(*)::int AS n FROM workflow_delegations WHERE id = ${`dr-${f.extension}`}`)).toBe(1);
    // … and invisible to the fire-time lookup, which is the only lookup.
    expect(await count(db, sql`
      SELECT COUNT(*)::int AS n FROM workflow_delegations
      WHERE extension_id = ${f.extension} AND job_ref = 'jr' AND revoked_at IS NULL AND enabled
    `)).toBe(0);
  });

  test("a revoked row does not block re-consenting the same job", async () => {
    // What the PARTIAL unique index buys. A total unique index would make
    // revocation permanent and un-redoable.
    await insertDelegation(db, { id: `dr1-${f.extension}`, extension: f.extension, jobRef: "jsame", kind: "user", ownerUser: f.owner, consentedBy: f.owner, revokedAt: "2026-01-01T00:00:00Z" });
    expect(await errCode(() => insertDelegation(db, { id: `dr2-${f.extension}`, extension: f.extension, jobRef: "jsame", kind: "user", ownerUser: f.owner, consentedBy: f.owner }))).toBeNull();
  });

  test("two LIVE delegations for the same (extension, job_ref) are rejected", async () => {
    // Discriminates the previous test: the partial index still enforces
    // one live authority per job.
    await insertDelegation(db, { id: `dl1-${f.extension}`, extension: f.extension, jobRef: "jlive", kind: "user", ownerUser: f.owner, consentedBy: f.owner });
    expect(await errCode(() => insertDelegation(db, { id: `dl2-${f.extension}`, extension: f.extension, jobRef: "jlive", kind: "user", ownerUser: f.owner, consentedBy: f.owner }))).toBe("23505");
  });

  test("a delegation with no owner_kind is rejected", async () => {
    expect(await errCode(() => db.execute(sql`
      INSERT INTO workflow_delegations (id, extension_id, job_ref, workflow_name, trigger_kind, consent_hash, max_tokens_per_run, max_runs_per_day, consented_by_user_id)
      VALUES (${`dn-${f.extension}`}, ${f.extension}, 'jn', 'nightly', 'cron', 'h', 1, 1, ${f.owner})
    `))).toBe("23502");
  });

  test("a delegation with no consenting human is rejected", async () => {
    expect(await errCode(() => db.execute(sql`
      INSERT INTO workflow_delegations (id, extension_id, job_ref, owner_kind, owner_user_id, workflow_name, trigger_kind, consent_hash, max_tokens_per_run, max_runs_per_day)
      VALUES (${`dc-${f.extension}`}, ${f.extension}, 'jc', 'user', ${f.owner}, 'nightly', 'cron', 'h', 1, 1)
    `))).toBe("23502");
  });

  test("a delegation with no token bound is rejected — there is no unlimited value", async () => {
    expect(await errCode(() => db.execute(sql`
      INSERT INTO workflow_delegations (id, extension_id, job_ref, owner_kind, owner_user_id, workflow_name, trigger_kind, consent_hash, max_runs_per_day, consented_by_user_id)
      VALUES (${`dt-${f.extension}`}, ${f.extension}, 'jt', 'user', ${f.owner}, 'nightly', 'cron', 'h', 1, ${f.owner})
    `))).toBe("23502");
  });

  test("a service account with no daily token bound is rejected", async () => {
    expect(await errCode(() => db.execute(sql`
      INSERT INTO service_accounts (id, name, created_by_user_id) VALUES (${`sat-${f.extension}`}, ${`sat-${f.extension}`}, ${f.consent})
    `))).toBe("23502");
  });

  test("two service accounts cannot share a name", async () => {
    await insertServiceAccount(db, `san1-${f.extension}`, `dup-${f.extension}`, f.consent);
    expect(await errCode(() => insertServiceAccount(db, `san2-${f.extension}`, `dup-${f.extension}`, f.consent))).toBe("23505");
  });
});

// ───────────────────────────────────────────────────────────────────
// Idempotence — proved by running migrate() twice, not by reading it
// ───────────────────────────────────────────────────────────────────
describe("C3 migration — idempotence, executed twice", () => {
  /** Columns + indexes + FK actions for the three C3 surfaces. */
  async function c3Fingerprint(db: Db): Promise<string> {
    const parts: string[] = [];
    for (const t of ["service_accounts", "workflow_delegations", "workflow_runs"]) {
      parts.push(`${t}.cols:${JSON.stringify(await columns(db, t))}`);
      parts.push(`${t}.fks:${JSON.stringify(await foreignKeys(db, t))}`);
    }
    const idx = [...(await indexDefs(db))]
      .filter(([n]) => n.includes("delegation") || n.includes("service_account") || n.includes("run_as"))
      .sort(([a], [b]) => a.localeCompare(b));
    parts.push(`idx:${JSON.stringify(idx)}`);
    return parts.join("\n");
  }

  test("a second migrate() on a fresh DB throws nothing and changes no C3 shape", async () => {
    const { pg, db } = await freshMigrated();
    try {
      const first = await c3Fingerprint(db);
      await migrate(db);
      expect(await c3Fingerprint(db)).toBe(first);
    } finally {
      await pg.close();
    }
  });

  test("C3 rows written between two migrate() calls survive the second", async () => {
    // Schema equality alone would not catch a companion statement that
    // truncated or rewrote the new tables.
    const { pg, db } = await freshMigrated();
    try {
      const f = await seedFixtures(db, "idem");
      await insertServiceAccount(db, "sa-idem", "sa-idem", f.consent);
      await insertDelegation(db, { id: "d-idem", extension: f.extension, jobRef: "j-idem", kind: "service", ownerService: "sa-idem", consentedBy: f.consent, version: f.version });
      await insertRun(db, { id: "r-idem", userId: null, runAsKind: "service", runAs: "sa-idem", delegation: "d-idem" });

      await migrate(db);

      expect(await count(db, sql`SELECT COUNT(*)::int AS n FROM service_accounts WHERE id = 'sa-idem'`)).toBe(1);
      const res = (await db.execute(sql`
        SELECT d.owner_kind, d.consented_by_user_id, r.delegation_id, r.run_as
        FROM workflow_delegations d JOIN workflow_runs r ON r.delegation_id = d.id
        WHERE d.id = 'd-idem'
      `)) as { rows: Array<Record<string, unknown>> };
      expect(res.rows).toEqual([
        { owner_kind: "service", consented_by_user_id: f.consent, delegation_id: "d-idem", run_as: "sa-idem" },
      ]);
    } finally {
      await pg.close();
    }
  });
});

// ───────────────────────────────────────────────────────────────────
// The worst realistic pre-state
// ───────────────────────────────────────────────────────────────────
describe("C3 migration — worst realistic pre-state", () => {
  /**
   * "Current `main` minus C3", derived by MIGRATING and then stripping the
   * C3 surfaces — rather than hand-writing an approximation of the old
   * schema, which can silently diverge from what actually shipped.
   */
  async function stripC3(db: Db) {
    await db.execute(sql`DROP TABLE IF EXISTS workflow_delegations CASCADE`);
    await db.execute(sql`DROP TABLE IF EXISTS service_accounts CASCADE`);
    await db.execute(sql`ALTER TABLE workflow_runs DROP COLUMN IF EXISTS run_as_kind`);
    await db.execute(sql`ALTER TABLE workflow_runs DROP COLUMN IF EXISTS run_as`);
    await db.execute(sql`ALTER TABLE workflow_runs DROP COLUMN IF EXISTS delegation_id`);
    await db.execute(sql`DROP INDEX IF EXISTS idx_workflow_runs_run_as`);
    await db.execute(sql`DROP INDEX IF EXISTS idx_workflow_runs_delegation`);
  }

  test("a pre-C3 database carrying real history upgrades, twice, losing nothing", async () => {
    const { pg, db } = await freshMigrated();
    try {
      const f = await seedFixtures(db, "pre");
      await stripC3(db);
      // History a real install would be carrying: runs in every lifecycle
      // state, one of them parked on an approval, plus per-step rows.
      await db.execute(sql`
        INSERT INTO workflow_runs (id, workflow_name, user_id, status, started_at, run_phase)
        VALUES ('old-ok',   'nightly', ${f.owner}, 'success',   NOW(), 'boundary'),
               ('old-park', 'nightly', ${f.owner}, 'suspended', NOW(), 'boundary'),
               ('old-anon', 'nightly', NULL,       'error',     NOW(), 'boundary')
      `);
      await db.execute(sql`
        INSERT INTO workflow_step_runs (id, workflow_run_id, step_name, status)
        VALUES ('old-step', 'old-ok', 's1', 'success')
      `);
      await db.execute(sql`
        INSERT INTO workflow_approvals (id, workflow_run_id, step_name, choices)
        VALUES ('old-appr', 'old-park', 's1', '["yes"]'::jsonb)
      `);
      const before = await columns(db, "workflow_runs");

      await migrate(db);
      await migrate(db); // the second run is the point — an upgrade path is re-run on every boot

      // Nothing existing changed shape: the pre-C3 columns are still there,
      // same type and same nullability. ADDITIVE means additive.
      const after = new Map((await columns(db, "workflow_runs")).map((c) => [c.column_name, c]));
      for (const col of before) {
        expect(after.get(col.column_name)).toEqual(col);
      }
      // Every historical row survived, and reads NULL for all three new
      // columns — the honest value, never a backfilled guess.
      const rows = (await db.execute(sql`
        SELECT id, status, run_as_kind, run_as, delegation_id FROM workflow_runs ORDER BY id
      `)) as { rows: Array<Record<string, unknown>> };
      expect(rows.rows).toEqual([
        { id: "old-anon", status: "error", run_as_kind: null, run_as: null, delegation_id: null },
        { id: "old-ok", status: "success", run_as_kind: null, run_as: null, delegation_id: null },
        { id: "old-park", status: "suspended", run_as_kind: null, run_as: null, delegation_id: null },
      ]);
      expect(await count(db, sql`SELECT COUNT(*)::int AS n FROM workflow_step_runs WHERE id = 'old-step'`)).toBe(1);
      expect(await count(db, sql`SELECT COUNT(*)::int AS n FROM workflow_approvals WHERE id = 'old-appr'`)).toBe(1);

      // And the upgraded database is fully usable: the FKs applied on the
      // ALTER path, not just on the CREATE path.
      expect((await foreignKeys(db, "workflow_runs")).delegation_id).toEqual({ action: "SET NULL", references: "workflow_delegations" });
      await insertServiceAccount(db, "sa-pre", "sa-pre", f.consent);
      await insertDelegation(db, { id: "d-pre", extension: f.extension, jobRef: "j-pre", kind: "service", ownerService: "sa-pre", consentedBy: f.consent });
      await db.execute(sql`UPDATE workflow_runs SET delegation_id = 'd-pre', run_as_kind = 'service', run_as = 'sa-pre' WHERE id = 'old-ok'`);
      await db.execute(sql`DELETE FROM workflow_delegations WHERE id = 'd-pre'`);
      const healed = (await db.execute(sql`SELECT delegation_id, run_as FROM workflow_runs WHERE id = 'old-ok'`)) as { rows: Array<Record<string, unknown>> };
      expect(healed.rows).toEqual([{ delegation_id: null, run_as: "sa-pre" }]);
    } finally {
      await pg.close();
    }
  });

  test("a boot that died mid-C3 (service_accounts landed, nothing else) completes on the next boot", async () => {
    // The DDL is a sequence of independent statements with no transaction
    // around it, so a crash can leave the tail unapplied. Re-running must
    // finish the job rather than trip over the part that already exists.
    const { pg, db } = await freshMigrated();
    try {
      const f = await seedFixtures(db, "torn");
      await stripC3(db);
      await db.execute(sql`
        CREATE TABLE service_accounts (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
          scopes JSONB NOT NULL DEFAULT '[]',
          max_tokens_per_day INTEGER NOT NULL,
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          disabled_reason TEXT,
          created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
        )
      `);
      await insertServiceAccount(db, "sa-torn", "sa-torn", f.consent);

      await migrate(db);
      await migrate(db);

      // The pre-existing row survived the CREATE TABLE IF NOT EXISTS …
      expect(await count(db, sql`SELECT COUNT(*)::int AS n FROM service_accounts WHERE id = 'sa-torn'`)).toBe(1);
      // … the missing index was created on the second pass …
      expect((await indexDefs(db)).has("idx_service_accounts_created_by")).toBe(true);
      // … and the tail of the migration applied.
      expect(await foreignKeys(db, "workflow_delegations")).toEqual({
        extension_id: { action: "CASCADE", references: "extensions" },
        owner_user_id: { action: "CASCADE", references: "users" },
        owner_service_account_id: { action: "CASCADE", references: "service_accounts" },
        consented_by_user_id: { action: "RESTRICT", references: "users" },
        definition_version_id: { action: "RESTRICT", references: "workflow_definition_versions" },
        project_id: { action: "CASCADE", references: "projects" },
      });
      await insertDelegation(db, { id: "d-torn", extension: f.extension, jobRef: "j-torn", kind: "service", ownerService: "sa-torn", consentedBy: f.consent });
      expect(await count(db, sql`SELECT COUNT(*)::int AS n FROM workflow_delegations WHERE id = 'd-torn'`)).toBe(1);
    } finally {
      await pg.close();
    }
  });
});
