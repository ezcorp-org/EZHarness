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
    // `factory_budget_root` allows one parentless envelope per run, and the
    // sibling cases share this fixture's run, so join the root rather than
    // minting a second one. Order between the cases then does not matter.
    await db.execute(sql`INSERT INTO factory_budget_envelopes(tenant_id,project_id,run_id,envelope_id,request_digest,limits,allocated,spent,deadline_ms,state) VALUES ('restart-tenant','restart-project','restart-run','root',${digest("9")},'{"costMicros":"10","tokens":"10","computeMs":"10"}','{"costMicros":"0","tokens":"0","computeMs":"0"}','{"costMicros":"0","tokens":"0","computeMs":"0"}',9999999999999,'open') ON CONFLICT DO NOTHING`);
    await db.execute(sql`INSERT INTO factory_budget_reservations(tenant_id,project_id,run_id,reservation_id,envelope_id,request_digest,amount,state) VALUES ('restart-tenant','restart-project','restart-run',${reservationId},'root',${digest("a")},'{"costMicros":"5","tokens":"5","computeMs":"5"}','uncertain')`);
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
    await db.execute(sql`INSERT INTO factory_budget_envelopes(tenant_id,project_id,run_id,envelope_id,request_digest,limits,allocated,spent,deadline_ms,state) VALUES (${tenantId},${projectId},${runId},'root',${digest("1")},'{}','{}','{}',1,'open') ON CONFLICT DO NOTHING`);
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

  test("a settled validator admission may never carry a kernel event, and every other origin still must", async () => {
    const db = fixture.db;
    const tenantId = "restart-tenant", projectId = "restart-project", runId = "restart-run";
    const digest = (fill: string) => `sha256:${fill.repeat(64).slice(0, 64)}`;
    const originJson = JSON.stringify({ schemaVersion: "factory.admission-origin.v1", kind: "protected-validator", acceptanceCommandId: "acceptance-event" });
    await db.execute(sql`INSERT INTO factory_budget_envelopes(tenant_id,project_id,run_id,envelope_id,request_digest,limits,allocated,spent,deadline_ms,state) VALUES (${tenantId},${projectId},${runId},'root',${digest("1")},'{}','{}','{}',1,'open') ON CONFLICT DO NOTHING`);
    for (const reservationId of ["event-validator", "event-task"]) {
      await db.execute(sql`INSERT INTO factory_budget_reservations(tenant_id,project_id,run_id,reservation_id,envelope_id,request_digest,amount,state) VALUES (${tenantId},${projectId},${runId},${reservationId},'root',${digest("1")},'{}','held') ON CONFLICT DO NOTHING`);
    }
    const admission = (reservationId: string, originKind: string, originDigest: string | null, state: string, eventJson: string | null) =>
      db.execute(sql`INSERT INTO factory_compute_admissions(tenant_id,project_id,run_id,reservation_id,request_digest,request_json,state,next_poll_at,origin_kind,origin_json,origin_digest,event_json,event_digest) VALUES (${tenantId},${projectId},${runId},${reservationId},${digest("1")},'{}',${state},0,${originKind},${originKind === "protected-validator" ? originJson : null},${originDigest},${eventJson},${eventJson === null ? null : digest("5")})`);
    for (let boot = 0; boot < 2; boot++) {
      await fixture.migrate();
      await db.execute(sql`DELETE FROM factory_compute_admissions WHERE tenant_id=${tenantId} AND reservation_id IN ('event-validator','event-task')`);
      // A settled validator admission with no event is exactly what the
      // admission path writes, and it is accepted.
      await admission("event-validator", "protected-validator", digest("4"), "admitted", null);
      // An event on a validator admission is refused in any state.
      const eventful = await db.execute(sql`UPDATE factory_compute_admissions SET event_json='{}',event_digest=${digest("5")} WHERE tenant_id=${tenantId} AND reservation_id='event-validator'`).then(() => null, (error: unknown) => error);
      expect(eventful).toBeInstanceOf(Error);
      // Ordinary task work still must carry one once it settles.
      const unevented = await admission("event-task", "dispatch-node", null, "admitted", null).then(() => null, (error: unknown) => error);
      expect(unevented).toBeInstanceOf(Error);
      await admission("event-task", "dispatch-node", null, "admitted", "{}");
      expect(rows(await db.execute(sql`SELECT reservation_id,origin_kind,event_json FROM factory_compute_admissions WHERE tenant_id=${tenantId} AND reservation_id IN ('event-validator','event-task') ORDER BY reservation_id`))).toEqual([
        { reservation_id: "event-task", origin_kind: "dispatch-node", event_json: "{}" },
        { reservation_id: "event-validator", origin_kind: "protected-validator", event_json: null },
      ]);
      // Exactly one constraint governs the rule, on both the fresh and the
      // upgraded path, so the two databases cannot disagree about it.
      const governing = rows<{ conname: string }>(await db.execute(sql`SELECT conname FROM pg_constraint WHERE conrelid='factory_compute_admissions'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%event_json IS NOT NULL%' ORDER BY conname`));
      expect(governing).toEqual([{ conname: "factory_compute_admissions_terminal_event_check" }]);
    }
  });

  test("the package-quarantine upgrade backfills the v4 generation fence and keeps one named state check", async () => {
    const db = fixture.db;
    const reference = `sha256:${"e".repeat(64)}`;
    const raw = "f".repeat(64);
    await db.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES ('restart-trust-user','restart-trust@example.test','x','Restart','admin') ON CONFLICT (id) DO NOTHING`);
    await db.execute(sql`INSERT INTO extension_release_installations(id,owner_id,scope,payload) VALUES ('restart-installation','restart-trust-user','project:restart-project',${JSON.stringify({ id: "restart-installation", generation: 5 })})`);
    await db.execute(sql`INSERT INTO factory_runner_package_bindings (tenant_id,project_id,package_name,package_version,package_digest,export_name,reference_digest,reference_json,installation_id,release_id,release_digest,source_digest,artifact_digest,image_digest,manifest_digest,issuer_id,issuer_grant_revision,protected_digest) VALUES ('restart-tenant','restart-project','restart-pkg','1.0.0',${reference},'run',${reference},'{}','restart-installation','restart-release',${raw},${raw},${raw},'image',${raw},'restart-trust-user',1,${reference})`);
    // Reproduce the pre-upgrade shape: no fence column, and a CHECK with no quarantined state.
    await db.execute(sql`ALTER TABLE factory_runner_package_trust_revisions DROP COLUMN IF EXISTS installation_generation`);
    await db.execute(sql`ALTER TABLE factory_runner_package_trust_revisions DROP CONSTRAINT IF EXISTS factory_runner_package_trust_state_check`);
    await db.execute(sql`ALTER TABLE factory_runner_package_trust_revisions ADD CONSTRAINT factory_runner_package_trust_revisions_state_check CHECK (state IN ('active','revoked'))`);
    await db.execute(sql`INSERT INTO factory_runner_package_trust_revisions (tenant_id,project_id,package_name,package_version,package_digest,export_name,reference_digest,revision,state,package_trust_digest,approved_by,approval_grant_revision,protected_digest) VALUES ('restart-tenant','restart-project','restart-pkg','1.0.0',${reference},'run',${reference},1,'active',${reference},'restart-trust-user',1,${reference})`);
    for (let boot = 0; boot < 2; boot++) {
      await fixture.migrate();
      const row = rows<{ installation_generation: number | string }>(await db.execute(sql`SELECT installation_generation FROM factory_runner_package_trust_revisions WHERE reference_digest=${reference} AND revision=1`))[0];
      expect(Number(row?.installation_generation)).toBe(5);
      const nullable = rows<{ is_nullable: string }>(await db.execute(sql`SELECT is_nullable FROM information_schema.columns WHERE table_name='factory_runner_package_trust_revisions' AND column_name='installation_generation'`));
      expect(nullable.map(column => column.is_nullable)).toEqual(["NO"]);
      // Exactly one state CHECK survives, so a mis-splice cannot leave two.
      const checks = rows<{ conname: string }>(await db.execute(sql`SELECT conname FROM pg_constraint WHERE conrelid='factory_runner_package_trust_revisions'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%state%' ORDER BY conname`));
      expect(checks.map(check => check.conname)).toEqual(["factory_runner_package_trust_state_check"]);
    }
    await expect((async () => { await db.execute(sql`INSERT INTO factory_runner_package_trust_revisions (tenant_id,project_id,package_name,package_version,package_digest,export_name,reference_digest,revision,state,package_trust_digest,approved_by,approval_grant_revision,installation_generation,protected_digest) VALUES ('restart-tenant','restart-project','restart-pkg','1.0.0',${reference},'run',${reference},2,'suspended',${reference},'restart-trust-user',1,5,${reference})`); })()).rejects.toThrow();
  });

  test("repeated migration keeps one validator attempt's several claim-keyed results and their assignment key", async () => {
    const db = fixture.db;
    const tenantId = "restart-tenant", projectId = "restart-project", runId = "restart-run";
    const digest = (fill: string) => `sha256:${fill.repeat(64).slice(0, 64)}`;
    const bare = (fill: string) => fill.repeat(64).slice(0, 64);
    const lock = digest("1");
    const execution = (attemptId: string, node: string) => db.execute(sql`INSERT INTO factory_executions(attempt_id,tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_number,grant_revision,reservation_generation,execution_epoch,cancellation_epoch,deadline_at,request_hash,request_json,status) VALUES (${attemptId},${tenantId},${projectId},${runId},${node},0,1,1,1,1,0,NOW() + INTERVAL '1 hour',${bare("2")},'{}'::jsonb,'admitted')`);
    const terminal = (attemptId: string, node: string, artifactId: string) => db.execute(sql`INSERT INTO factory_execution_terminals(tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_id,request_digest,result_digest,terminal_result_digest,result_json,output_artifact_id,output_digest,output_bytes,execution_epoch,cancellation_epoch,terminal_fact_digest) VALUES (${tenantId},${projectId},${runId},${node},0,${attemptId},${bare("2")},${bare("3")},${digest("4")},'{}',${artifactId},${digest("5")},64,1,0,${digest("6")})`);
    const output = (artifactId: string, node: string) => db.execute(sql`INSERT INTO factory_artifacts(object_id,tenant_id,project_id,run_id,kind,candidate_node_instance_id,candidate_generation,digest,blob_digest,storage_version,encoded_bytes) VALUES (${artifactId},${tenantId},${projectId},${runId},'candidate_output',${node},0,${digest("5")},${bare("7")},'version-1',64)`);

    // A sibling case in this fixture already owns `restart-trust@example.test`, and the users table
    // is unique on email, so this case carries its own address as well as its own id.
    await db.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES ('restart-trust-admin','restart-validator-trust@example.test','x','Restart trust','admin') ON CONFLICT (id) DO NOTHING`);
    await db.execute(sql`INSERT INTO factory_release_trust_revisions(tenant_id,project_id,revision,state,package_lock_json,package_trust_digest,validator_trust_digest,approved_by,approval_grant_revision,protected_digest) VALUES (${tenantId},${projectId},1,'active','{}',${digest("8")},${lock},'restart-trust-admin',1,${digest("9")})`);
    await db.execute(sql`INSERT INTO factory_release_trust_current(tenant_id,project_id,revision) VALUES (${tenantId},${projectId},1)`);
    await db.execute(sql`INSERT INTO factory_drafts(tenant_id,project_id,factory_id,revision,source_digest,source_json,required_resources_json,requirements_complete,validation_diagnostic_count) VALUES (${tenantId},${projectId},'restart-factory',1,${digest("a")},'{}','[]',TRUE,0)`);
    await db.execute(sql`INSERT INTO factory_versions(tenant_id,project_id,factory_id,version,draft_revision,definition_digest,compiled_blob_digest,compiled_bytes,lock_json) VALUES (${tenantId},${projectId},'restart-factory','1.0.0',1,${digest("a")},${digest("b")},16,'{}')`);
    await db.execute(sql`INSERT INTO factory_validator_materials(tenant_id,project_id,factory_id,factory_version,definition_digest,contract_id,contract_version,contract_digest,validator_lock_digest,mandatory_claims,claim_groups,validators_json,material_digest) VALUES (${tenantId},${projectId},'restart-factory','1.0.0',${digest("a")},'restart-contract','1.0.0',${digest("c")},${lock},'[]','[]','[]',${digest("d")})`);
    await output("restart-candidate-output", "candidate-node");
    await output("restart-validator-output", "validator-node");
    await execution("restart-candidate-attempt", "candidate-node");
    await execution("restart-validator-attempt", "validator-node");
    await terminal("restart-candidate-attempt", "candidate-node", "restart-candidate-output");
    await terminal("restart-validator-attempt", "validator-node", "restart-validator-output");
    await db.execute(sql`INSERT INTO factory_release_candidate_history(tenant_id,project_id,run_id,node_instance_id,candidate_generation,candidate_digest,attempt_id,execution_epoch,cancellation_epoch,terminal_fact_digest,output_artifact_id,output_bytes,trust_revision,package_trust_digest,validator_trust_digest,proof_digest) VALUES (${tenantId},${projectId},${runId},'candidate-node',0,${digest("5")},'restart-candidate-attempt',1,0,${digest("6")},'restart-candidate-output',64,1,${digest("8")},${lock},${digest("e")})`);
    for (const claimId of ["claim-a", "claim-b"]) {
      await db.execute(sql`INSERT INTO factory_validator_assignments(tenant_id,project_id,run_id,candidate_node_instance_id,candidate_generation,validator_id,validator_attempt_id,validator_authority_json,definition_digest,validator_lock_digest,candidate_digest,candidate_artifact_id,candidate_artifact_digest,candidate_artifact_bytes,runner_json,runner_digest,environment_digest,configuration_digest,freshness_ms,trust_revision,issuer_grant_revision,assignment_digest) VALUES (${tenantId},${projectId},${runId},'candidate-node',0,${claimId},'restart-validator-attempt','{}',${digest("a")},${lock},${digest("5")},'restart-candidate-output',${digest("5")},64,'{}',${digest("f")},${digest("0")},${digest("1")},1000,1,1,${digest("2")})`);
      await db.execute(sql`INSERT INTO factory_validator_results(tenant_id,project_id,validator_attempt_id,validator_id,verdict,report_digest,terminal_fact_digest,artifact_id,artifact_digest,artifact_bytes,claims_json,issued_at_ms,expires_at_ms,evidence_digest,result_digest) VALUES (${tenantId},${projectId},'restart-validator-attempt',${claimId},'PASS',${digest("7")},${digest("6")},'restart-validator-output',${digest("5")},64,${`[{"id":"${claimId}","verdict":"PASS","decisive":true}]`},1,2,${digest("3")},${digest("4")})`);
    }

    const validatorConstraints = async () => rows<{ definition: string }>(await db.execute(sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid IN ('factory_validator_assignments'::regclass,'factory_validator_results'::regclass) AND contype IN ('p','f','u') ORDER BY definition`));
    const before = await validatorConstraints();
    const beforeOids = rows(await db.execute(sql`SELECT conname,oid FROM pg_constraint WHERE conrelid='factory_validator_results'::regclass ORDER BY conname`));
    expect(before.some(row => row.definition === "PRIMARY KEY (tenant_id, project_id, validator_attempt_id, validator_id)")).toBe(true);
    expect(before.some(row => row.definition === "UNIQUE (validator_attempt_id)")).toBe(false);
    for (let boot = 0; boot < 2; boot++) {
      await fixture.migrate();
      expect(await validatorConstraints()).toEqual(before);
      expect(rows(await db.execute(sql`SELECT conname,oid FROM pg_constraint WHERE conrelid='factory_validator_results'::regclass ORDER BY conname`))).toEqual(beforeOids);
      expect(rows(await db.execute(sql`SELECT validator_id,claims_json FROM factory_validator_results WHERE tenant_id=${tenantId} AND validator_attempt_id='restart-validator-attempt' ORDER BY validator_id`))).toEqual([
        { validator_id: "claim-a", claims_json: '[{"id":"claim-a","verdict":"PASS","decisive":true}]' },
        { validator_id: "claim-b", claims_json: '[{"id":"claim-b","verdict":"PASS","decisive":true}]' },
      ]);
      expect(rows<{ indexdef: string }>(await db.execute(sql`SELECT indexdef FROM pg_indexes WHERE indexname='uq_factory_validator_assignment_attempt_claim'`))).toHaveLength(1);
      const duplicate = await db.execute(sql`INSERT INTO factory_validator_results(tenant_id,project_id,validator_attempt_id,validator_id,verdict,terminal_fact_digest,artifact_id,artifact_digest,artifact_bytes,claims_json,issued_at_ms,expires_at_ms,evidence_digest,result_digest) VALUES (${tenantId},${projectId},'restart-validator-attempt','claim-a','PASS',${digest("6")},'restart-validator-output',${digest("5")},64,'[]',1,2,${digest("3")},${digest("4")})`).then(() => null, (error: unknown) => error);
      expect(duplicate).toBeInstanceOf(Error);
      const unassigned = await db.execute(sql`INSERT INTO factory_validator_results(tenant_id,project_id,validator_attempt_id,validator_id,verdict,terminal_fact_digest,artifact_id,artifact_digest,artifact_bytes,claims_json,issued_at_ms,expires_at_ms,evidence_digest,result_digest) VALUES (${tenantId},${projectId},'restart-validator-attempt','claim-never-assigned','PASS',${digest("6")},'restart-validator-output',${digest("5")},64,'[]',1,2,${digest("3")},${digest("4")})`).then(() => null, (error: unknown) => error);
      expect(unassigned).toBeInstanceOf(Error);
    }
  });

  test("repeated migration keeps the release profile seal and the broker-only git ref binding", async () => {
    const db = fixture.db;
    const digest = (fill: string) => `sha256:${fill.repeat(64).slice(0, 64)}`;
    const profileChecks = async () => rows<{ definition: string }>(await db.execute(sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='factory_release_operations'::regclass AND contype='c' AND (conname LIKE '%profile%' OR conname LIKE '%destination_ref%' OR conname LIKE '%destination_branch%') ORDER BY conname`));
    const before = await profileChecks();
    const beforeOids = rows(await db.execute(sql`SELECT conname,oid FROM pg_constraint WHERE conrelid='factory_release_operations'::regclass AND contype='c' ORDER BY conname`));
    expect(before).toHaveLength(6);
    for (let boot = 0; boot < 2; boot++) {
      await fixture.migrate();
      expect(await profileChecks()).toEqual(before);
      expect(rows(await db.execute(sql`SELECT conname,oid FROM pg_constraint WHERE conrelid='factory_release_operations'::regclass AND contype='c' ORDER BY conname`))).toEqual(beforeOids);
      const columns = rows<{ column_name: string; is_nullable: string }>(await db.execute(sql`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name='factory_release_operations' AND column_name IN ('profile_input_digest','profile_result_digest','profile_resolved_at_ms','destination_ref','destination_branch') ORDER BY column_name`));
      expect(columns).toEqual([
        { column_name: "destination_branch", is_nullable: "YES" },
        { column_name: "destination_ref", is_nullable: "YES" },
        { column_name: "profile_input_digest", is_nullable: "YES" },
        { column_name: "profile_resolved_at_ms", is_nullable: "YES" },
        { column_name: "profile_result_digest", is_nullable: "YES" },
      ]);
    }
    // The checks reject a half-sealed profile and a ref outside the broker namespace. A temporary
    // copy carries the same CHECKs without the operation's foreign keys.
    const sealed = async (inputDigest: string | null, resultDigest: string | null, resolvedAtMs: number | null, ref: string | null, branch: string | null) =>
      db.transaction(async tx => {
        await tx.execute(sql`CREATE TEMP TABLE release_probe (LIKE factory_release_operations INCLUDING CONSTRAINTS INCLUDING DEFAULTS) ON COMMIT DROP`);
        await tx.execute(sql`INSERT INTO release_probe (tenant_id,project_id,operation_id,run_id,node_instance_id,candidate_generation,candidate_digest,decision_id,contract_digest,execution_epoch,cancellation_epoch,release_enable_epoch,action,destination_provider,destination_account,destination_object,destination_digest,canonical_request,request_digest,material_json,material_digest,estimated_spend_micros,deadline_ms,state,profile_input_digest,profile_result_digest,profile_resolved_at_ms,destination_ref,destination_branch) VALUES ('t','p','o','r','n',0,${digest("1")},'d',${digest("2")},1,0,1,'publish','github','ez','demo',${digest("3")},'{}',${digest("4")},'{}',${digest("5")},0,1,'pending',${inputDigest},${resultDigest},${resolvedAtMs},${ref},${branch})`);
      }).then(() => null, (error: unknown) => error);
    expect(await sealed(digest("6"), digest("7"), 1, "refs/heads/ezcorp-factory/o", "ezcorp-factory/o")).toBeNull();
    expect(await sealed(digest("6"), null, 1, null, null)).toBeInstanceOf(Error);
    expect(await sealed(digest("6"), digest("7"), null, null, null)).toBeInstanceOf(Error);
    expect(await sealed(null, null, null, "refs/heads/ez-code/o", "ez-code/o")).toBeInstanceOf(Error);
    expect(await sealed(null, null, null, "refs/heads/ezcorp-factory/o", null)).toBeInstanceOf(Error);
    expect(await sealed("not-a-digest", digest("7"), 1, null, null)).toBeInstanceOf(Error);
  });

  test("repeated migration keeps the protected decision column and backfills only acceptance receipts", async () => {
    const db = fixture.db;
    const decisionChecks = async () => rows<{ definition: string }>(await db.execute(sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='factory_protected_command_effects'::regclass AND contype='c' AND conname LIKE '%decision%' ORDER BY conname`));
    const before = await decisionChecks();
    const beforeOids = rows(await db.execute(sql`SELECT conname,oid FROM pg_constraint WHERE conrelid='factory_protected_command_effects'::regclass AND contype='c' ORDER BY conname`));
    expect(before).toHaveLength(2);
    const insert = (kind: string, decision: string | null) => db.transaction(async tx => {
      await tx.execute(sql`CREATE TEMP TABLE effect_probe (LIKE factory_protected_command_effects INCLUDING CONSTRAINTS INCLUDING DEFAULTS) ON COMMIT DROP`);
      await tx.execute(sql`INSERT INTO effect_probe (tenant_id,project_id,run_id,interpreter_id,command_id,kind,command_digest,receipt_json,receipt_digest,decision) VALUES ('t','p','r','i','c',${kind},${`sha256:${"1".repeat(64)}`},'{}',${`sha256:${"2".repeat(64)}`},${decision})`);
    }).then(() => null, (error: unknown) => error);
    for (let boot = 0; boot < 2; boot++) {
      await fixture.migrate();
      expect(await decisionChecks()).toEqual(before);
      expect(rows(await db.execute(sql`SELECT conname,oid FROM pg_constraint WHERE conrelid='factory_protected_command_effects'::regclass AND contype='c' ORDER BY conname`))).toEqual(beforeOids);
      expect(await insert("request-acceptance", "accepted")).toBeNull();
      expect(await insert("request-acceptance", "rejected")).toBeNull();
      expect(await insert("request-release", null)).toBeNull();
      expect(await insert("request-acceptance", "approved")).toBeInstanceOf(Error);
      expect(await insert("request-release", "accepted")).toBeInstanceOf(Error);
    }
  });

  test("repeated migration keeps every child artifact alias ancestry key", async () => {
    const db = fixture.db;
    const aliasKeys = async () => rows<{ definition: string }>(await db.execute(sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='factory_child_artifact_aliases'::regclass AND contype IN ('p','f','u') ORDER BY definition`));
    const before = await aliasKeys();
    // One primary key, one parent-attempt unique key, and five separate ancestry foreign keys.
    expect(before).toHaveLength(7);
    expect(before.filter(row => row.definition.startsWith("FOREIGN KEY"))).toHaveLength(5);
    for (let boot = 0; boot < 2; boot++) {
      await fixture.migrate();
      expect(await aliasKeys()).toEqual(before);
      expect(rows<{ indexdef: string }>(await db.execute(sql`SELECT indexdef FROM pg_indexes WHERE indexname='idx_factory_child_artifact_aliases_child'`))).toHaveLength(1);
      const orphan = await db.execute(sql`INSERT INTO factory_child_artifact_aliases(tenant_id,project_id,alias_id,parent_run_id,parent_interpreter_id,parent_command_id,parent_node_instance_id,parent_candidate_generation,parent_attempt_id,parent_execution_epoch,parent_cancellation_epoch,child_run_id,child_decision_id,child_node_instance_id,child_candidate_generation,child_candidate_digest,child_execution_epoch,artifact_id,artifact_digest,artifact_bytes,alias_digest) VALUES ('restart-tenant','restart-project','alias','restart-run','root','no-such-command','node',0,'restart-attempt',1,0,'restart-run','no-such-decision','child',0,${`sha256:${"a".repeat(64)}`},1,'restart-candidate-output',${`sha256:${"b".repeat(64)}`},1,${`sha256:${"c".repeat(64)}`})`).then(() => null, (error: unknown) => error);
      expect(orphan).toBeInstanceOf(Error);
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
