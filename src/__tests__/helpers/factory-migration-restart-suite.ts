import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { MigrateDb, TransactionalDb } from "../../db/migrations/types";
import { up as scopePrimaryKey } from "../../db/migrations/scope-factory-artifact-primary-key";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import { FileBlobStore } from "../../extensions/v4/blobs";
import { FactoryArtifacts } from "../../factory/artifacts";

interface Fixture { db: MigrateDb & TransactionalDb; migrate(): Promise<void>; close(): Promise<void> }

export function factoryMigrationRestartConformance(createFixture: () => Promise<Fixture>): void {
  let fixture: Fixture;
  let directory: string;
  beforeAll(async () => { fixture = await createFixture(); directory = await mkdtemp(join(tmpdir(), "factory-migration-restart-")); });
  afterAll(async () => { await fixture?.close(); if (directory) await rm(directory, { recursive: true, force: true }); });

  test("repeated full application migration preserves candidate slots, bytes and referenced keys", async () => {
    const db = fixture.db;
    await db.execute(sql`INSERT INTO projects(id,name,path) VALUES ('restart-project','Restart','/tmp/factory-restart')`);
    await db.execute(sql`INSERT INTO factory_installation(singleton,tenant_id,execution_epoch) VALUES (1,'restart-tenant',1)`);
    await db.execute(sql`INSERT INTO factory_projects(tenant_id,project_id) VALUES ('restart-tenant','restart-project')`);
    await db.execute(sql`INSERT INTO factory_runs(tenant_id,project_id,run_id,definition_digest,interpreter_build,execution_epoch,request_digest,request_payload) VALUES ('restart-tenant','restart-project','restart-run',${`sha256:${"a".repeat(64)}`},'test',1,'request','{}')`);
    const scope = { tenantId: "restart-tenant", projectId: "restart-project", logicalRunId: "restart-run", interpreterId: "root" };
    const artifacts = new FactoryArtifacts(db, new FileBlobStore(directory), scope.tenantId);
    const content = new TextEncoder().encode(JSON.stringify({ text: "x".repeat(96 * 1024) }));
    const candidates = [];
    for (const [node, generation] of [["node-a", 0], ["node-b", 0], ["node-a", 1]] as const) {
      candidates.push(await db.transaction(tx => artifacts.stageCandidateOutputInTransaction(tx, scope, node, generation, content)));
    }
    const partitions = [];
    for (const partitionId of ["partition-a", "partition-b"]) partitions.push(await artifacts.stage(scope, "partition", new TextEncoder().encode(partitionId), { partitionId }));
    const constraints = async () => rows<{ oid: number; definition: string }>(await db.execute(sql`SELECT oid,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid IN ('factory_artifacts'::regclass,'factory_execution_terminals'::regclass,'factory_release_candidate_history'::regclass) AND contype IN ('p','f') ORDER BY oid`));
    const before = await constraints();
    for (let boot = 0; boot < 2; boot++) {
      await fixture.migrate();
      expect(await constraints()).toEqual(before);
      for (const candidate of candidates) expect((await artifacts.load(scope, { objectId: candidate.artifactId, digest: candidate.digest, encodedBytes: candidate.encodedBytes }, ["candidate_output"])).content).toEqual(content);
      for (const partition of partitions) expect((await artifacts.load(scope, partition, ["partition"])).reference).toEqual(partition);
      const indexes = rows<{ definition: string }>(await db.execute(sql`SELECT pg_get_indexdef('factory_artifacts_admission_identity'::regclass) AS definition`));
      for (const column of ["partition_id", "candidate_node_instance_id", "candidate_generation"]) expect(indexes[0]!.definition).toContain(column);
    }
  });

  test("repeated migration preserves auxiliary material records, their chunks and the widened artifact kind", async () => {
    const db = fixture.db;
    const scope = { tenantId: "restart-tenant", projectId: "restart-project", runId: "restart-run", attemptId: "restart-attempt", operationId: "restart-run:node-a:0:0" };
    const objectId = "factory-artifact-material-restart";
    const materialDigest = `sha256:${"b".repeat(64)}`;
    await db.execute(sql`INSERT INTO factory_executions(attempt_id,tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_number,grant_revision,reservation_generation,execution_epoch,cancellation_epoch,deadline_at,request_hash,request_json,status) VALUES (${scope.attemptId},${scope.tenantId},${scope.projectId},${scope.runId},'node-a',0,1,1,1,1,0,NOW() + INTERVAL '1 hour',${"c".repeat(64)},'{}'::jsonb,'admitted')`);
    await db.execute(sql`INSERT INTO factory_artifacts(object_id,tenant_id,project_id,run_id,kind,material_key,digest,blob_digest,storage_version,encoded_bytes) VALUES (${objectId},${scope.tenantId},${scope.projectId},${scope.runId},'material',${`sha256:${"d".repeat(64)}`},${`sha256:${"e".repeat(64)}`},${"f".repeat(64)},'version-1',512)`);
    await db.execute(sql`INSERT INTO factory_artifact_materials(tenant_id,project_id,run_id,attempt_id,operation_id,object_name,version,media_type,digest,total_bytes,chunk_count,storage_version,sealed,object_id) VALUES (${scope.tenantId},${scope.projectId},${scope.runId},${scope.attemptId},${scope.operationId},'workspace/checkpoint.tar',1,'application/octet-stream',${materialDigest},9,1,'version-1',TRUE,${objectId})`);
    await db.execute(sql`INSERT INTO factory_artifact_material_chunks(tenant_id,project_id,run_id,attempt_id,operation_id,object_name,version,chunk_index,chunk_digest,encoded_bytes,blob_digest,storage_version) VALUES (${scope.tenantId},${scope.projectId},${scope.runId},${scope.attemptId},${scope.operationId},'workspace/checkpoint.tar',1,0,${materialDigest},9,${"a".repeat(64)},'version-1')`);
    const materialConstraints = async () => rows<{ definition: string }>(await db.execute(sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid IN ('factory_artifact_materials'::regclass,'factory_artifact_material_chunks'::regclass) AND contype IN ('p','f') ORDER BY oid`));
    const before = await materialConstraints();
    expect(before).toHaveLength(5);
    for (let boot = 0; boot < 2; boot++) {
      await fixture.migrate();
      expect(await materialConstraints()).toEqual(before);
      const stored = rows<{ digest: string; total_bytes: number | string; chunk_count: number; sealed: boolean; object_id: string }>(await db.execute(sql`SELECT digest, total_bytes, chunk_count, sealed, object_id FROM factory_artifact_materials WHERE tenant_id=${scope.tenantId} AND attempt_id=${scope.attemptId}`));
      expect(stored.map(row => ({ ...row, total_bytes: Number(row.total_bytes) }))).toEqual([{ digest: materialDigest, total_bytes: 9, chunk_count: 1, sealed: true, object_id: objectId }]);
      expect(rows(await db.execute(sql`SELECT chunk_index, chunk_digest, encoded_bytes FROM factory_artifact_material_chunks WHERE tenant_id=${scope.tenantId} AND attempt_id=${scope.attemptId}`))).toEqual([{ chunk_index: 0, chunk_digest: materialDigest, encoded_bytes: 9 }]);
      expect(rows<{ definition: string }>(await db.execute(sql`SELECT pg_get_indexdef('factory_artifacts_admission_identity'::regclass) AS definition`))[0]!.definition).toContain("material_key");
      const unkeyed = await db.execute(sql`INSERT INTO factory_artifacts(object_id,tenant_id,project_id,run_id,kind,digest,blob_digest,storage_version,encoded_bytes) VALUES ('factory-artifact-material-unkeyed',${scope.tenantId},${scope.projectId},${scope.runId},'material',${`sha256:${"e".repeat(64)}`},${"f".repeat(64)},'version-1',512)`).then(() => null, (error: unknown) => error);
      expect(unkeyed).toBeInstanceOf(Error);
      expect(rows(await db.execute(sql`SELECT object_id FROM factory_artifacts WHERE object_id='factory-artifact-material-unkeyed'`))).toEqual([]);
    }
  });

  test("the attempt-launch upgrade backfills one durable invocation identity and keeps every package receipt", async () => {
    const db = fixture.db;
    const attemptId = "restart-launch-attempt"; // distinct from the materials case, which shares this fixture
    const receipt = JSON.stringify({ projectId: "restart-project", artifactDigest: "b".repeat(64) });
    await db.execute(sql`INSERT INTO factory_executions(attempt_id,tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_number,grant_revision,reservation_generation,execution_epoch,cancellation_epoch,deadline_at,request_hash,request_json,status) VALUES (${attemptId},'restart-tenant','restart-project','restart-run','restart-node',0,2,1,1,1,0,NOW() + INTERVAL '1 hour',${"c".repeat(64)},'{}','admitted')`);
    await db.execute(sql`INSERT INTO factory_attempt_launches(attempt_id,tenant_id,project_id,run_id,request_digest,request_json,reservation_id,grant_revision,allocation_generation,holder_generation,allocation_token,host_id,package_receipt_digest,package_receipt_json,artifact_digest,worker_id,invocation_id,state) VALUES (${attemptId},'restart-tenant','restart-project','restart-run',${"c".repeat(64)},'{}','restart-reservation',1,1,1,'restart-allocation','restart-host',${`sha256:${"d".repeat(64)}`},${receipt}::jsonb,${"b".repeat(64)},'restart-worker','restart-invocation','prepared')`);
    // Reproduce the pre-upgrade shape this migration must repair.
    await db.execute(sql`ALTER TABLE factory_attempt_launches DROP COLUMN invocation_id, DROP COLUMN device_grant_json, DROP COLUMN device_grant_digest`);
    await db.execute(sql`ALTER TABLE factory_attempt_launches ALTER COLUMN package_receipt_json DROP NOT NULL`);
    const expected = `factory_${createHash("sha256").update(`${attemptId}:0:2`).digest("hex").slice(0, 48)}`;
    for (let boot = 0; boot < 2; boot++) {
      await fixture.migrate();
      const row = rows<{ invocation_id: string; device_grant_json: unknown; device_grant_digest: string | null; package_receipt_json: unknown }>(await db.execute(sql`SELECT invocation_id,device_grant_json,device_grant_digest,package_receipt_json FROM factory_attempt_launches WHERE attempt_id=${attemptId}`))[0];
      expect(row?.invocation_id).toBe(expected);
      expect(typeof row?.device_grant_json === "string" ? JSON.parse(row.device_grant_json) : row?.device_grant_json).toEqual({ devices: [], cdiDevices: [], capabilities: [] });
      expect(row?.device_grant_digest).toBeNull();
      expect(typeof row?.package_receipt_json === "string" ? JSON.parse(row.package_receipt_json) : row?.package_receipt_json).toEqual(JSON.parse(receipt));
      const nullable = rows<{ is_nullable: string }>(await db.execute(sql`SELECT is_nullable FROM information_schema.columns WHERE table_name='factory_attempt_launches' AND column_name IN ('package_receipt_json','invocation_id') ORDER BY column_name`));
      expect(nullable.map(column => column.is_nullable)).toEqual(["NO", "NO"]);
      const unique = rows<{ indexdef: string }>(await db.execute(sql`SELECT indexdef FROM pg_indexes WHERE tablename='factory_attempt_launches' AND indexname='uq_factory_attempt_launches_invocation'`));
      expect(unique).toHaveLength(1);
      expect(unique[0]!.indexdef).toContain("UNIQUE");
    }
    await expect((async () => { await db.execute(sql`INSERT INTO factory_attempt_launches(attempt_id,tenant_id,project_id,run_id,request_digest,request_json,reservation_id,grant_revision,allocation_generation,holder_generation,allocation_token,host_id,package_receipt_digest,package_receipt_json,artifact_digest,worker_id,invocation_id,state) VALUES ('restart-attempt-duplicate','restart-tenant','restart-project','restart-run',${"c".repeat(64)},'{}','restart-reservation',1,1,1,'restart-allocation','restart-host',${`sha256:${"d".repeat(64)}`},${receipt}::jsonb,${"b".repeat(64)},'restart-worker-duplicate',${expected},'prepared')`); })()).rejects.toThrow();
  });

  test("the task-stop table keeps a live sealed-launch stop and still binds a terminal-outcome stop", async () => {
    const db = fixture.db;
    const attemptId = "restart-stop-attempt";
    const receipt = JSON.stringify({ projectId: "restart-project", artifactDigest: "b".repeat(64) });
    await db.execute(sql`INSERT INTO factory_executions(attempt_id,tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_number,grant_revision,reservation_generation,execution_epoch,cancellation_epoch,deadline_at,request_hash,request_json,status) VALUES (${attemptId},'restart-tenant','restart-project','restart-run','restart-stop-node',0,1,1,1,1,0,NOW() + INTERVAL '1 hour',${"e".repeat(64)},'{}','running')`);
    await db.execute(sql`INSERT INTO factory_attempt_launches(attempt_id,tenant_id,project_id,run_id,request_digest,request_json,reservation_id,grant_revision,allocation_generation,holder_generation,allocation_token,host_id,package_receipt_digest,package_receipt_json,artifact_digest,worker_id,invocation_id,state) VALUES (${attemptId},'restart-tenant','restart-project','restart-run',${"e".repeat(64)},'{}','restart-stop-reservation',1,1,1,'restart-stop-allocation','restart-stop-host',${`sha256:${"d".repeat(64)}`},${receipt}::jsonb,${"b".repeat(64)},'restart-stop-worker','restart-stop-invocation','launched')`);
    await db.execute(sql`INSERT INTO factory_audit_batches(tenant_id,project_id,run_id,interpreter_id,source_sequence,sequence,digest,payload) VALUES ('restart-tenant','restart-project','restart-run','root',41,41,'restart-stop-batch','{}')`);
    await db.execute(sql`INSERT INTO factory_transition_commands(tenant_id,project_id,run_id,interpreter_id,command_id,source_sequence,command_digest) VALUES ('restart-tenant','restart-project','restart-run','root','restart-stop-cancel',41,${`sha256:${"b".repeat(64)}`})`);
    await db.execute(sql`INSERT INTO factory_task_stops(tenant_id,project_id,run_id,interpreter_id,cancel_command_id,attempt_id,reservation_id,request_json,request_digest,source,state,accepted_at_ms) VALUES ('restart-tenant','restart-project','restart-run','root','restart-stop-cancel',${attemptId},'restart-stop-reservation','{}',${`sha256:${"a".repeat(64)}`},'sealed-launch','accepted',17)`);
    for (let boot = 0; boot < 2; boot++) {
      await fixture.migrate();
      const stored = rows<{ source: string; state: string; attempt_command_id: string | null; accepted_at_ms: number | string }>(await db.execute(sql`SELECT source,state,attempt_command_id,accepted_at_ms FROM factory_task_stops WHERE attempt_id=${attemptId}`));
      expect(stored).toEqual([{ source: "sealed-launch", state: "accepted", attempt_command_id: null, accepted_at_ms: stored[0]!.accepted_at_ms }]);
      expect(Number(stored[0]!.accepted_at_ms)).toBe(17);
      const definitions = rows<{ definition: string }>(await db.execute(sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='factory_task_stops'::regclass ORDER BY conname`)).map(row => row.definition).join("\n");
      expect(definitions).toContain("FOREIGN KEY (attempt_id) REFERENCES factory_attempt_launches(attempt_id)");
      expect(definitions).toContain("accepted_at_ms >= 0");
      expect(definitions).toContain("state = 'stopped'::text) = ((stop_receipt_json IS NOT NULL) AND (stopped_event_json IS NOT NULL))");
      const terminalWithoutOutcome = await db.execute(sql`INSERT INTO factory_task_stops(tenant_id,project_id,run_id,interpreter_id,cancel_command_id,attempt_id,reservation_id,request_json,request_digest,source,state,accepted_at_ms) VALUES ('restart-tenant','restart-project','restart-run','root','restart-stop-cancel-2','restart-stop-attempt-2','restart-stop-reservation','{}',${`sha256:${"a".repeat(64)}`},'terminal-outcome','accepted',17)`).then(() => null, (error: unknown) => error);
      expect(terminalWithoutOutcome).toBeInstanceOf(Error);
      const withoutLaunch = await db.execute(sql`INSERT INTO factory_task_stops(tenant_id,project_id,run_id,interpreter_id,cancel_command_id,attempt_id,reservation_id,request_json,request_digest,source,state,accepted_at_ms) VALUES ('restart-tenant','restart-project','restart-run','root','restart-stop-cancel-3','restart-stop-unlaunched','restart-stop-reservation','{}',${`sha256:${"a".repeat(64)}`},'sealed-launch','accepted',17)`).then(() => null, (error: unknown) => error);
      expect(withoutLaunch).toBeInstanceOf(Error);
    }
  });

  test("the usage-settlement table keeps every revision and one row per provider receipt", async () => {
    const db = fixture.db;
    const reservationId = "restart-usage-reservation";
    const digest = (fill: string) => `sha256:${fill.repeat(64)}`;
    await db.execute(sql`INSERT INTO factory_budget_envelopes(tenant_id,project_id,run_id,envelope_id,request_digest,limits,allocated,spent,deadline_ms,state) VALUES ('restart-tenant','restart-project','restart-run','restart-usage-envelope',${digest("9")},'{"costMicros":"10","tokens":"10","computeMs":"10"}','{"costMicros":"0","tokens":"0","computeMs":"0"}','{"costMicros":"0","tokens":"0","computeMs":"0"}',9999999999999,'open')`);
    await db.execute(sql`INSERT INTO factory_budget_reservations(tenant_id,project_id,run_id,reservation_id,envelope_id,request_digest,amount,state) VALUES ('restart-tenant','restart-project','restart-run',${reservationId},'restart-usage-envelope',${digest("a")},'{"costMicros":"5","tokens":"5","computeMs":"5"}','uncertain')`);
    await db.execute(sql`INSERT INTO factory_usage_settlements(tenant_id,project_id,run_id,reservation_id,revision,attempt_id,source,known_cost_micros,unknown_cost_micros,settled_at_ms,settlement_digest,event_json,event_digest) VALUES ('restart-tenant','restart-project','restart-run',${reservationId},1,'restart-usage-attempt','stop','2','3',11,${digest("b")},'{}',${digest("c")})`);
    await db.execute(sql`INSERT INTO factory_usage_settlements(tenant_id,project_id,run_id,reservation_id,revision,attempt_id,source,known_cost_micros,provider_receipt_digest,settled_at_ms,settlement_digest,event_json,event_digest) VALUES ('restart-tenant','restart-project','restart-run',${reservationId},2,'restart-usage-attempt','reconciliation','5',${digest("d")},12,${digest("e")},'{}',${digest("f")})`);
    for (let boot = 0; boot < 2; boot++) {
      await fixture.migrate();
      const stored = rows<{ revision: number | string; source: string; known_cost_micros: string; unknown_cost_micros: string | null }>(await db.execute(sql`SELECT revision,source,known_cost_micros,unknown_cost_micros FROM factory_usage_settlements WHERE reservation_id=${reservationId} ORDER BY revision`));
      expect(stored.map(row => ({ ...row, revision: Number(row.revision) }))).toEqual([
        { revision: 1, source: "stop", known_cost_micros: "2", unknown_cost_micros: "3" },
        { revision: 2, source: "reconciliation", known_cost_micros: "5", unknown_cost_micros: null },
      ]);
      const duplicateReceipt = await db.execute(sql`INSERT INTO factory_usage_settlements(tenant_id,project_id,run_id,reservation_id,revision,attempt_id,source,known_cost_micros,provider_receipt_digest,settled_at_ms,settlement_digest,event_json,event_digest) VALUES ('restart-tenant','restart-project','restart-run',${reservationId},3,'restart-usage-attempt','reconciliation','6',${digest("d")},13,${digest("e")},'{}',${digest("f")})`).then(() => null, (error: unknown) => error);
      expect(duplicateReceipt).toBeInstanceOf(Error);
      const reconciliationWithoutReceipt = await db.execute(sql`INSERT INTO factory_usage_settlements(tenant_id,project_id,run_id,reservation_id,revision,attempt_id,source,known_cost_micros,settled_at_ms,settlement_digest,event_json,event_digest) VALUES ('restart-tenant','restart-project','restart-run',${reservationId},4,'restart-usage-attempt','reconciliation','6',13,${digest("e")},'{}',${digest("f")})`).then(() => null, (error: unknown) => error);
      expect(reconciliationWithoutReceipt).toBeInstanceOf(Error);
    }
  });

  test("repeated migration keeps the typed admission origin, its checks, and one identity per validator reservation", async () => {
    const db = fixture.db;
    const tenantId = "restart-tenant", projectId = "restart-project", runId = "restart-run";
    const digest = (fill: string) => `sha256:${fill.repeat(64).slice(0, 64)}`;
    const originJson = JSON.stringify({ schemaVersion: "factory.admission-origin.v1", kind: "protected-validator", acceptanceCommandId: "acceptance-1" });
    const admission = (reservationId: string, originKind: string, originDigest: string | null) => db.execute(sql`INSERT INTO factory_compute_admissions(tenant_id,project_id,run_id,reservation_id,request_digest,request_json,state,next_poll_at,origin_kind,origin_json,origin_digest) VALUES (${tenantId},${projectId},${runId},${reservationId},${digest("1")},'{}','pending',0,${originKind},${originDigest === null ? null : originJson},${originDigest})`);
    await db.execute(sql`INSERT INTO factory_budget_envelopes(tenant_id,project_id,run_id,envelope_id,request_digest,limits,allocated,spent,deadline_ms,state) VALUES (${tenantId},${projectId},${runId},'root',${digest("1")},'{}','{}','{}',1,'open')`);
    for (const [reservationId, originKind] of [["reservation-task", "dispatch-node"], ["reservation-validator", "protected-validator"], ["reservation-validator-two", "protected-validator"]] as const) {
      await db.execute(sql`INSERT INTO factory_budget_reservations(tenant_id,project_id,run_id,reservation_id,envelope_id,request_digest,amount,state,origin_kind) VALUES (${tenantId},${projectId},${runId},${reservationId},'root',${digest("1")},'{}','held',${originKind})`);
    }
    await admission("reservation-task", "dispatch-node", null);
    await admission("reservation-validator", "protected-validator", digest("2"));

    const originChecks = async () => rows<{ definition: string }>(await db.execute(sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid IN ('factory_compute_admissions'::regclass,'factory_budget_reservations'::regclass) AND contype='c' AND conname LIKE '%origin%' ORDER BY conname`));
    const before = await originChecks();
    const beforeOids = rows(await db.execute(sql`SELECT conname,oid FROM pg_constraint WHERE conrelid='factory_compute_admissions'::regclass AND conname LIKE '%origin%' ORDER BY conname`));
    expect(before).toHaveLength(6);
    for (let boot = 0; boot < 2; boot++) {
      await fixture.migrate();
      expect(await originChecks()).toEqual(before);
      expect(rows(await db.execute(sql`SELECT conname,oid FROM pg_constraint WHERE conrelid='factory_compute_admissions'::regclass AND conname LIKE '%origin%' ORDER BY conname`))).toEqual(beforeOids);
      expect(rows(await db.execute(sql`SELECT reservation_id,origin_kind,origin_digest FROM factory_compute_admissions WHERE tenant_id=${tenantId} AND run_id=${runId} ORDER BY reservation_id`))).toEqual([
        { reservation_id: "reservation-task", origin_kind: "dispatch-node", origin_digest: null },
        { reservation_id: "reservation-validator", origin_kind: "protected-validator", origin_digest: digest("2") },
      ]);
      expect(rows(await db.execute(sql`SELECT DISTINCT origin_kind FROM factory_budget_reservations WHERE tenant_id=${tenantId} AND reservation_id='reservation-task'`))).toEqual([{ origin_kind: "dispatch-node" }]);
      // One admission per validator identity, and a body that does not match its kind is refused.
      const repeated = await admission("reservation-validator-two", "protected-validator", digest("2")).then(() => null, (error: unknown) => error);
      expect(repeated).toBeInstanceOf(Error);
      const unsealed = await admission("reservation-validator-two", "protected-validator", null).then(() => null, (error: unknown) => error);
      expect(unsealed).toBeInstanceOf(Error);
      const forged = await db.execute(sql`INSERT INTO factory_compute_admissions(tenant_id,project_id,run_id,reservation_id,request_digest,request_json,state,next_poll_at,origin_kind,origin_json,origin_digest) VALUES (${tenantId},${projectId},${runId},'reservation-validator-two',${digest("1")},'{}','pending',0,'cancel-node',${originJson},${digest("3")})`).then(() => null, (error: unknown) => error);
      expect(forged).toBeInstanceOf(Error);
    }
  });

  test("the legacy unscoped key upgrades once and preserves dependent foreign keys on rerun", async () => {
    await fixture.db.transaction(async tx => {
      await tx.execute(sql`CREATE SCHEMA factory_old_key`);
      await tx.execute(sql`SET LOCAL search_path TO factory_old_key, public`);
      await tx.execute(sql`CREATE TABLE factory_artifacts (object_id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,project_id TEXT NOT NULL)`);
      await tx.execute(sql`INSERT INTO factory_artifacts VALUES ('same-id','tenant','project-a')`);
      await scopePrimaryKey(tx);
      await tx.execute(sql`CREATE TABLE linked_output (tenant_id TEXT,project_id TEXT,object_id TEXT,FOREIGN KEY (tenant_id,project_id,object_id) REFERENCES factory_artifacts(tenant_id,project_id,object_id))`);
      await tx.execute(sql`INSERT INTO linked_output VALUES ('tenant','project-a','same-id')`);
      await tx.execute(sql`INSERT INTO factory_artifacts VALUES ('same-id','tenant','project-b')`);
      await scopePrimaryKey(tx);
      expect(rows(await tx.execute(sql`SELECT * FROM linked_output`))).toEqual([{ tenant_id: "tenant", project_id: "project-a", object_id: "same-id" }]);
      expect(rows(await tx.execute(sql`SELECT object_id FROM factory_artifacts`))).toHaveLength(2);
    });
  });
}
