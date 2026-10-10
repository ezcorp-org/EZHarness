import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { setupTestDb } from "../__tests__/helpers/test-pglite";
import { releaseRows as rows } from "../db/queries/extension-releases";
import type { MigrationDb } from "../db/migrations/types";
import { FactoryRecords, type FactoryRunRequest } from "./records";
import { FactoryCommandOutbox } from "./outbox";

let fixture: Awaited<ReturnType<typeof setupTestDb>>;
let records: FactoryRecords;
let outbox: FactoryCommandOutbox;

beforeAll(async () => {
  fixture = await setupTestDb();
  records = new FactoryRecords(fixture.db, "outbox-tenant");
  outbox = new FactoryCommandOutbox(fixture.db, "outbox-tenant", "outbox-project", () => 10);
  await records.bindInstallation();
  await fixture.db.execute(sql`INSERT INTO projects (id, name, path) VALUES ('outbox-project', 'Outbox', '/tmp/factory-outbox-project')`);
  await fixture.db.execute(sql`INSERT INTO users (id, email, password_hash, name) VALUES ('outbox-human', 'outbox@example.test', 'not-a-login-hash', 'Outbox test')`);
  await records.bindProject("outbox-project");
});

afterAll(async () => { await fixture.pglite.close(); });

function request(runId: string): FactoryRunRequest {
  return { projectId: "outbox-project", runId, definitionDigest: `sha256:${"a".repeat(64)}`, interpreterBuild: "kernel-v1", executionEpoch: 1, input: { value: 1 }, principalId: "outbox-human" };
}

const enqueueStart = (transaction: MigrationDb, run: FactoryRunRequest) =>
  outbox.enqueueInTransaction(transaction, { kind: "start_run", projectId: run.projectId, logicalRunId: run.runId, body: run }).then(() => undefined);

describe("factory run start outbox integration", () => {
  test("run, audit and start command commit in one caller transaction", async () => {
    const run = request("atomic-start");
    expect(await records.createRun(run, enqueueStart)).toEqual({ created: true });
    const deliveries = rows<{ payload: string }>(await fixture.db.execute(sql`SELECT payload FROM factory_command_outbox WHERE logical_run_id = ${run.runId}`));
    expect(deliveries).toHaveLength(1);
    expect(JSON.parse(deliveries[0]!.payload).command).toMatchObject({ kind: "start_run", workflowId: "outbox-tenant/atomic-start" });
    expect(rows(await fixture.db.execute(sql`SELECT id FROM audit_log WHERE target = ${run.runId}`))).toHaveLength(1);
  });

  test("reading an original run command rejects ambiguous or mismatched stored identities", async () => {
    const run = request("inspect-original");
    await records.createRun(run, enqueueStart);
    const read = () => fixture.db.transaction(tx => outbox.findRunCommandInTransaction(tx, run.runId, "start_run"));
    const original = (await read())!;
    expect(original.logicalRunId).toBe(run.runId);
    await outbox.enqueue({ kind: "start_run", projectId: run.projectId, logicalRunId: run.runId, interpreterId: "other", body: run });
    await expect(read()).rejects.toMatchObject({ code: "factory_command_corrupt" });
    await fixture.db.execute(sql`DELETE FROM factory_command_outbox WHERE logical_run_id=${run.runId} AND id<>${original.id}`);
    const different = request("inspect-other");
    await records.createRun(different, async () => {});
    await fixture.db.execute(sql`UPDATE factory_command_outbox SET logical_run_id=${different.runId} WHERE id=${original.id}`);
    await expect(fixture.db.transaction(tx => outbox.findRunCommandInTransaction(tx, different.runId, "start_run"))).rejects.toMatchObject({ code: "factory_command_corrupt" });
    expect(await read()).toBeNull();
  });

  test("an outbox failure rolls back the run and fail-closed audit", async () => {
    const run = request("rejected-start");
    await fixture.db.execute(sql`CREATE FUNCTION reject_factory_command() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'outbox unavailable'; END $$`);
    await fixture.db.execute(sql`CREATE TRIGGER reject_factory_command BEFORE INSERT ON factory_command_outbox FOR EACH ROW EXECUTE FUNCTION reject_factory_command()`);
    try {
      await expect(records.createRun(run, enqueueStart)).rejects.toThrow();
    } finally {
      await fixture.db.execute(sql`DROP TRIGGER reject_factory_command ON factory_command_outbox`);
      await fixture.db.execute(sql`DROP FUNCTION reject_factory_command()`);
    }
    expect(rows(await fixture.db.execute(sql`SELECT run_id FROM factory_runs WHERE run_id = ${run.runId}`))).toHaveLength(0);
    expect(rows(await fixture.db.execute(sql`SELECT id FROM audit_log WHERE target = ${run.runId}`))).toHaveLength(0);
    expect(rows(await fixture.db.execute(sql`SELECT id FROM factory_command_outbox WHERE logical_run_id = ${run.runId}`))).toHaveLength(0);
  });
});
