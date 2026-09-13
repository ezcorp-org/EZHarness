import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { FactoryRecords, type FactoryAuditInput, type FactoryRunRequest } from "../factory/records";
import { setupTestDb } from "./helpers/test-pglite";
import { up } from "../db/migrations/add-factory-records";
import { releaseRows as rows } from "../db/queries/extension-releases";
import type { MigrationDb } from "../db/migrations/types";

let fixture: Awaited<ReturnType<typeof setupTestDb>>;
let records: FactoryRecords;
let sequence = 0;

beforeAll(async () => {
  fixture = await setupTestDb();
  records = new FactoryRecords(fixture.db, "tenant-one");
  await records.bindInstallation();
  await fixture.db.execute(sql`INSERT INTO projects (id, name, path) VALUES ('factory-project', 'Factory', '/tmp/factory-records-project'), ('other-project', 'Other', '/tmp/factory-records-other')`);
  await fixture.db.execute(sql`INSERT INTO users (id, email, password_hash, name) VALUES ('factory-human', 'factory@example.test', 'not-a-login-hash', 'Factory test')`);
  await records.bindProject("factory-project");
});
afterAll(async () => { await fixture.pglite.close(); });

function request(overrides: Partial<FactoryRunRequest> = {}): FactoryRunRequest {
  return { projectId: "factory-project", runId: `run-${++sequence}`, definitionDigest: `sha256:${"a".repeat(64)}`, interpreterBuild: "kernel-v1", executionEpoch: 1, input: { value: 1 }, principalId: "factory-human", ...overrides };
}

async function enqueue(transaction: MigrationDb, run: FactoryRunRequest): Promise<void> {
  await transaction.execute(sql`INSERT INTO factory_command_outbox (tenant_id, project_id, logical_run_id, id, deduplication_id, input_hash, state, available_at, payload)
    VALUES ('tenant-one', ${run.projectId}, ${run.runId}, ${run.runId}, ${run.runId}, ${`sha256:${"0".repeat(64)}`}, 'queued', 0, '{}')`);
}

async function started(): Promise<FactoryRunRequest> {
  const run = request();
  await records.createRun(run, enqueue);
  return run;
}

function audit(run: FactoryRunRequest, overrides: Partial<FactoryAuditInput> = {}): FactoryAuditInput {
  return { projectId: run.projectId, runId: run.runId, interpreterId: "partition-one", sourceSequence: 1, predecessorDigest: null, payload: { commands: ["work-one"] }, ...overrides };
}

describe("durable factory records through the application database", () => {
  test("additive migration and installation binding are idempotent and tenant-bound", async () => {
    await up(fixture.db);
    await records.bindInstallation();
    await records.bindProject("factory-project");
    await expect(new FactoryRecords(fixture.db, "tenant-two").bindInstallation()).rejects.toMatchObject({ code: "factory_installation_mismatch" });
    await expect(new FactoryRecords(fixture.db, "tenant-two").bindProject("factory-project")).rejects.toThrow();
    await expect(records.bindProject("missing-project")).rejects.toThrow();
    expect(rows(await fixture.db.execute(sql`SELECT tenant_id FROM factory_installation`))).toEqual([{ tenant_id: "tenant-one" }]);
  });

  test("start, audit and command commit once under duplicate requests", async () => {
    const run = request();
    const results = await Promise.all([records.createRun(run, enqueue), records.createRun(run, enqueue)]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(rows(await fixture.db.execute(sql`SELECT id FROM factory_command_outbox WHERE logical_run_id = ${run.runId}`))).toHaveLength(1);
    expect(rows(await fixture.db.execute(sql`SELECT id FROM audit_log WHERE action = 'factory.run.requested' AND target = ${run.runId}`))).toHaveLength(1);
    await expect(records.createRun({ ...run, input: { value: 2 } }, enqueue)).rejects.toMatchObject({ code: "factory_run_conflict" });
    await expect(records.createRun({ ...request(), executionEpoch: 2 }, enqueue)).rejects.toMatchObject({ code: "factory_epoch_changed" });
    await expect(new FactoryRecords(fixture.db, "tenant-two").createRun(request(), enqueue)).rejects.toMatchObject({ code: "factory_epoch_changed" });
  });

  test("a failed outbox write rolls back the accepted run and its audit", async () => {
    const run = request();
    await expect(records.createRun(run, async (transaction, input) => {
      await enqueue(transaction, input);
      throw new Error("outbox unavailable");
    })).rejects.toThrow("outbox unavailable");
    expect(rows(await fixture.db.execute(sql`SELECT run_id FROM factory_runs WHERE run_id = ${run.runId}`))).toHaveLength(0);
    expect(rows(await fixture.db.execute(sql`SELECT id FROM factory_command_outbox WHERE logical_run_id = ${run.runId}`))).toHaveLength(0);
    expect(rows(await fixture.db.execute(sql`SELECT id FROM audit_log WHERE target = ${run.runId}`))).toHaveLength(0);
    expect(await records.createRun(run, enqueue)).toEqual({ created: true });
  });

  test("independent interpreter producers receive one contiguous run sequence", async () => {
    const run = await started();
    const input = audit(run);
    const [first, duplicate, peer] = await Promise.all([
      records.appendAudit(input), records.appendAudit(input), records.appendAudit(audit(run, { interpreterId: "partition-two" })),
    ]);
    expect(first).toEqual(duplicate);
    expect([first.sequence, peer.sequence].sort()).toEqual([1, 2]);
    const next = await records.appendAudit(audit(run, { sourceSequence: 2, predecessorDigest: first.digest }));
    expect(next.sequence).toBe(3);
    expect((await records.readAudit(run)).map((batch) => batch.sequence)).toEqual([1, 2, 3]);
    expect((await records.readAudit(run, 1, 1)).map((batch) => batch.sequence)).toEqual([2]);
    await expect(records.appendAudit({ ...input, payload: { commands: ["changed"] } })).rejects.toMatchObject({ code: "factory_audit_conflict" });
    await expect(records.appendAudit(audit(run, { sourceSequence: 4, predecessorDigest: next.digest }))).rejects.toMatchObject({ code: "factory_audit_gap" });
    await expect(records.appendAudit(audit(run, { sourceSequence: 3, predecessorDigest: first.digest }))).rejects.toMatchObject({ code: "factory_audit_gap" });
  });

  test("scope changes cannot read, append or project another run", async () => {
    const run = await started();
    const batch = await records.appendAudit(audit(run));
    const foreign = new FactoryRecords(fixture.db, "tenant-two");
    expect(await foreign.readAudit(run)).toEqual([]);
    expect(await records.readAudit({ ...run, projectId: "other-project" })).toEqual([]);
    await expect(foreign.appendAudit(audit(run))).rejects.toMatchObject({ code: "factory_run_not_found" });
    await expect(records.appendAudit(audit(run, { projectId: "other-project" }))).rejects.toMatchObject({ code: "factory_run_not_found" });
    await expect(foreign.project(batch, "view", () => null)).rejects.toMatchObject({ code: "factory_scope_mismatch" });
    await expect(Promise.resolve(fixture.db.execute(sql`DELETE FROM projects WHERE id = 'factory-project'`))).rejects.toThrow();
  });

  test("projection replay verifies the source, stops on gaps and commits the cursor with the view", async () => {
    const run = await started();
    const first = await records.appendAudit(audit(run));
    const second = await records.appendAudit(audit(run, { sourceSequence: 2, predecessorDigest: first.digest, payload: { result: 2 } }));
    const reduce = (current: unknown, batch: { readonly sequence: number }) => [...(current as number[] | null ?? []), batch.sequence];
    await expect(records.project(second, "view", reduce)).rejects.toMatchObject({ code: "factory_projection_gap" });
    expect(await records.project(first, "view", reduce)).toEqual({ sequence: 1, digest: first.digest, payload: [1] });
    await expect(records.project(second, "view", () => { throw new Error("view unavailable"); })).rejects.toThrow("view unavailable");
    expect(rows(await fixture.db.execute(sql`SELECT sequence FROM factory_run_projections WHERE run_id = ${run.runId}`)).map((row) => Number((row as { sequence: number }).sequence))).toEqual([1]);
    expect(await records.project(second, "view", reduce)).toEqual({ sequence: 2, digest: second.digest, payload: [1, 2] });
    expect(await records.project(first, "view", () => { throw new Error("verified duplicate must not reduce"); })).toEqual({ sequence: 2, digest: second.digest, payload: [1, 2] });
    for (const invalid of [{ ...first, digest: "wrong" }, { ...first, payload: { forged: true } }, { ...first, sequence: 99 }]) {
      await expect(records.project(invalid, "view", reduce)).rejects.toMatchObject({ code: "factory_projection_source_conflict" });
    }
    await fixture.db.execute(sql`DELETE FROM factory_run_projections WHERE run_id = ${run.runId}`);
    for (const batch of await records.readAudit(run)) await records.project(batch, "view", reduce);
    expect(rows(await fixture.db.execute(sql`SELECT payload FROM factory_run_projections WHERE run_id = ${run.runId}`))).toEqual([{ payload: "[1,2]" }]);
  });

  test("transactional audit failure prevents both start and transition facts", async () => {
    const existing = await started();
    const fresh = request();
    await fixture.db.execute(sql`CREATE FUNCTION factory_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$`);
    await fixture.db.execute(sql`CREATE TRIGGER factory_test_reject_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION factory_test_reject_audit()`);
    try {
      await expect(records.createRun(fresh, enqueue)).rejects.toThrow();
      await expect(records.appendAudit(audit(existing))).rejects.toThrow();
    } finally {
      await fixture.db.execute(sql`DROP TRIGGER factory_test_reject_audit ON audit_log`);
      await fixture.db.execute(sql`DROP FUNCTION factory_test_reject_audit()`);
    }
    expect(rows(await fixture.db.execute(sql`SELECT run_id FROM factory_runs WHERE run_id = ${fresh.runId}`))).toHaveLength(0);
    expect(await records.readAudit(existing)).toEqual([]);
    expect((await records.appendAudit(audit(existing))).sequence).toBe(1);
  });

  test("bounded values fail before durable work", async () => {
    expect(() => new FactoryRecords(fixture.db, "")).toThrow("factory_identity_invalid");
    await expect(records.bindProject("x".repeat(513))).rejects.toMatchObject({ code: "factory_identity_invalid" });
    await expect(records.bindProject("nul\0name")).rejects.toMatchObject({ code: "factory_identity_invalid" });
    await expect(records.createRun(request({ definitionDigest: "moving-latest" }), enqueue)).rejects.toMatchObject({ code: "factory_definition_digest_invalid" });
    await expect(records.createRun(request({ executionEpoch: 0 }), enqueue)).rejects.toMatchObject({ code: "factory_sequence_invalid" });
    await expect(records.createRun(request({ input: "x".repeat(65_537) }), enqueue)).rejects.toMatchObject({ code: "factory_payload_too_large" });
    await expect(records.createRun(request({ input: Number.POSITIVE_INFINITY }), enqueue)).rejects.toThrow();
    const run = await started();
    await expect(records.appendAudit(audit(run, { sourceSequence: 1.5 }))).rejects.toMatchObject({ code: "factory_sequence_invalid" });
    for (const [after, limit] of [[-1, 1], [0, 0], [0, 201], [0.5, 1], [0, 1.5]]) await expect(records.readAudit(run, after, limit)).rejects.toMatchObject({ code: "factory_page_invalid" });
    await fixture.db.execute(sql`UPDATE factory_runs SET next_sequence = ${Number.MAX_SAFE_INTEGER} WHERE run_id = ${run.runId}`);
    await expect(records.appendAudit(audit(run))).rejects.toMatchObject({ code: "factory_sequence_invalid" });
    expect(await records.readAudit(run)).toEqual([]);
  });
});
