import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb } from "../../__tests__/helpers/test-pglite";
import { FACTORY_RECOVERY_UNGATED_TABLES, FACTORY_RETENTION_CLASSES, FACTORY_RETENTION_PERIOD_MS, up } from "./add-factory-recovery";

function rows<Row>(result: unknown): Row[] {
  return (result as { rows: Row[] }).rows;
}

let fixture: Awaited<ReturnType<typeof setupTestDb>>;
beforeAll(async () => {
  fixture = await setupTestDb();
  await fixture.db.execute(sql`INSERT INTO factory_installation (singleton, tenant_id) VALUES (1, 'tenant-migration')`);
});
afterAll(async () => { await fixture?.pglite.close(); });

async function failure(statement: ReturnType<typeof sql>): Promise<string> {
  try { await fixture.db.execute(statement); }
  catch (error) { return `${(error as Error).message} ${String(((error as Error).cause as Error | undefined)?.message)}`; }
  throw new Error("expected the statement to fail");
}

test("the recovery migration is repeatable and gates every factory table but its own", async () => {
  await up(fixture.db); await up(fixture.db);
  const tables = rows<{ relname: string; gated: boolean }>(await fixture.db.execute(sql`SELECT c.relname, EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'factory_checkpoint_barrier_gate') AS gated
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relkind = 'r' AND c.relname LIKE 'factory\\_%' ORDER BY c.relname`));
  expect(tables.length).toBeGreaterThan(40);
  for (const table of tables) expect({ table: table.relname, gated: table.gated }).toEqual({ table: table.relname, gated: !(FACTORY_RECOVERY_UNGATED_TABLES as readonly string[]).includes(table.relname) });
  const triggers = rows<{ tgname: string; count: string | number }>(await fixture.db.execute(sql`SELECT tgname, count(*) AS count FROM pg_trigger WHERE tgname IN ('factory_effect_claim_gate','factory_restore_admission_gate') GROUP BY tgname ORDER BY tgname`));
  expect(triggers.map(row => [row.tgname, Number(row.count)])).toEqual([["factory_effect_claim_gate", 2], ["factory_restore_admission_gate", 1]]);
  const constraints = rows<{ conname: string }>(await fixture.db.execute(sql`SELECT conname FROM pg_constraint WHERE conrelid IN ('factory_retention_records'::regclass, 'factory_checkpoints'::regclass, 'factory_restore_epochs'::regclass, 'factory_restore_findings'::regclass, 'factory_recovered_releases'::regclass, 'factory_checkpoint_policy'::regclass, 'factory_checkpoint_gate'::regclass)`));
  for (const row of constraints) expect(row.conname).toMatch(/^factory_(retention_records|checkpoints|restore_epochs|restore_findings|recovered_releases|checkpoint_policy|checkpoint_gate)_/);
});

test("a retention deadline can extend its class period and can never shorten it", async () => {
  expect(FACTORY_RETENTION_CLASSES).toHaveLength(9);
  expect(FACTORY_RETENTION_PERIOD_MS.ordinary_history).toBe(30 * 86_400_000);
  expect(FACTORY_RETENTION_PERIOD_MS.unaccepted_candidate).toBe(90 * 86_400_000);
  expect(FACTORY_RETENTION_PERIOD_MS.canonical_audit).toBe(365 * 86_400_000);
  const period = FACTORY_RETENTION_PERIOD_MS.release;
  await fixture.db.execute(sql`INSERT INTO factory_retention_records (tenant_id, subject_kind, subject_id, retention_class, anchored_at_ms, retain_until_ms) VALUES ('tenant-migration','release','op-1','release',1000,${1000 + period})`);
  await fixture.db.execute(sql`UPDATE factory_retention_records SET retain_until_ms = ${1000 + period * 2} WHERE subject_id = 'op-1'`);
  expect(await failure(sql`UPDATE factory_retention_records SET retain_until_ms = ${1000 + period - 1} WHERE subject_id = 'op-1'`)).toContain("factory_retention_records_period_check");
  expect(await failure(sql`INSERT INTO factory_retention_records (tenant_id, subject_kind, subject_id, retention_class, anchored_at_ms, retain_until_ms) VALUES ('tenant-migration','run_audit','r','ordinary_history',0,${FACTORY_RETENTION_PERIOD_MS.ordinary_history - 1})`)).toContain("factory_retention_records_period_check");
  expect(await failure(sql`UPDATE factory_retention_records SET state = 'tombstoned' WHERE subject_id = 'op-1'`)).toContain("factory_retention_records_tombstone_check");
  expect(await failure(sql`UPDATE factory_retention_records SET state = 'collected', tombstoned_at_ms = 5 WHERE subject_id = 'op-1'`)).toContain("factory_retention_records_collected_check");
});

test("an open restore epoch closes run admission and a stale checkpoint closes effect claims", async () => {
  const reason = async () => rows<{ reason: string | null }>(await fixture.db.execute(sql`SELECT factory_effect_claims_closed_reason('tenant-migration') AS reason`))[0]!.reason;
  // Fail closed: with no policy row and no sealed checkpoint, claims are closed.
  expect(await reason()).toBe("checkpoint_stale");
  // Only an explicit row turns the rule off.
  await fixture.db.execute(sql`INSERT INTO factory_checkpoint_policy (tenant_id, enforce_freshness, max_age_seconds) VALUES ('tenant-migration', FALSE, 900)`);
  expect(await reason()).toBeNull();
  await fixture.db.execute(sql`UPDATE factory_checkpoint_policy SET enforce_freshness = TRUE WHERE tenant_id = 'tenant-migration'`);
  expect(await reason()).toBe("checkpoint_stale");
  await fixture.db.execute(sql`INSERT INTO factory_checkpoints (tenant_id, checkpoint_id, state, execution_epoch, key_wrap_version, started_at_ms, duration_ms, product_lsn, manifest_digest, manifest_archive_json, sealed_at)
    VALUES ('tenant-migration','old','sealed',1,1,0,5,'0/1',${`sha256:${"a".repeat(64)}`},'{}', clock_timestamp() - interval '16 minutes')`);
  expect(await reason()).toBe("checkpoint_stale");
  await fixture.db.execute(sql`INSERT INTO factory_checkpoints (tenant_id, checkpoint_id, state, execution_epoch, key_wrap_version, started_at_ms, duration_ms, product_lsn, manifest_digest, manifest_archive_json, sealed_at)
    VALUES ('tenant-migration','fresh','sealed',1,1,0,5,'0/2',${`sha256:${"b".repeat(64)}`},'{}', clock_timestamp())`);
  expect(await reason()).toBeNull();
  await fixture.db.execute(sql`INSERT INTO factory_restore_epochs (tenant_id, restore_id, mode, checkpoint_id, manifest_digest, previous_epoch, execution_epoch, state, started_at_ms, opened_state_json)
    VALUES ('tenant-migration','restore-1','tenant','fresh',${`sha256:${"b".repeat(64)}`},1,2,'fenced',0,'{}')`);
  expect(await reason()).toBe("restore_epoch_open");
  await fixture.db.execute(sql`INSERT INTO projects (id, name, path) VALUES ('recovery-project','Recovery','/tmp/recovery-project')`);
  await fixture.db.execute(sql`INSERT INTO factory_projects (tenant_id, project_id) VALUES ('tenant-migration','recovery-project')`);
  expect(await failure(sql`INSERT INTO factory_runs (tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload) VALUES ('tenant-migration','recovery-project','run-1',${`sha256:${"c".repeat(64)}`},'k',1,'d','{}')`)).toContain("factory_admission_closed:restore_epoch_open");
  expect(await failure(sql`UPDATE factory_restore_epochs SET state = 'enabled' WHERE restore_id = 'restore-1'`)).toContain("factory_restore_epochs_report_check");
});

test("a sealed checkpoint row needs its manifest and an aborted row needs its code", async () => {
  expect(await failure(sql`INSERT INTO factory_checkpoints (tenant_id, checkpoint_id, state, execution_epoch, started_at_ms, duration_ms) VALUES ('tenant-migration','x','sealed',1,0,1)`)).toContain("factory_checkpoints_sealed_check");
  expect(await failure(sql`INSERT INTO factory_checkpoints (tenant_id, checkpoint_id, state, execution_epoch, started_at_ms, duration_ms) VALUES ('tenant-migration','y','aborted',1,0,1)`)).toContain("factory_checkpoints_aborted_check");
  expect(await failure(sql`INSERT INTO factory_checkpoint_policy (tenant_id, max_age_seconds) VALUES ('tenant-migration', 901) ON CONFLICT (tenant_id) DO UPDATE SET max_age_seconds = EXCLUDED.max_age_seconds`)).toContain("factory_checkpoint_policy_age_check");
});
