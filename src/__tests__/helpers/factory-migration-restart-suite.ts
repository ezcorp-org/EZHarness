import { afterAll, beforeAll, expect, test } from "bun:test";
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

  test("repeated migration keeps one validator attempt's several claim-keyed results and their assignment key", async () => {
    const db = fixture.db;
    const tenantId = "restart-tenant", projectId = "restart-project", runId = "restart-run";
    const digest = (fill: string) => `sha256:${fill.repeat(64).slice(0, 64)}`;
    const bare = (fill: string) => fill.repeat(64).slice(0, 64);
    const lock = digest("1");
    const execution = (attemptId: string, node: string) => db.execute(sql`INSERT INTO factory_executions(attempt_id,tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_number,grant_revision,reservation_generation,execution_epoch,cancellation_epoch,deadline_at,request_hash,request_json,status) VALUES (${attemptId},${tenantId},${projectId},${runId},${node},0,1,1,1,1,0,NOW() + INTERVAL '1 hour',${bare("2")},'{}'::jsonb,'admitted')`);
    const terminal = (attemptId: string, node: string, artifactId: string) => db.execute(sql`INSERT INTO factory_execution_terminals(tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_id,request_digest,result_digest,terminal_result_digest,result_json,output_artifact_id,output_digest,output_bytes,execution_epoch,cancellation_epoch,terminal_fact_digest) VALUES (${tenantId},${projectId},${runId},${node},0,${attemptId},${bare("2")},${bare("3")},${digest("4")},'{}',${artifactId},${digest("5")},64,1,0,${digest("6")})`);
    const output = (artifactId: string, node: string) => db.execute(sql`INSERT INTO factory_artifacts(object_id,tenant_id,project_id,run_id,kind,candidate_node_instance_id,candidate_generation,digest,blob_digest,storage_version,encoded_bytes) VALUES (${artifactId},${tenantId},${projectId},${runId},'candidate_output',${node},0,${digest("5")},${bare("7")},'version-1',64)`);

    await db.execute(sql`INSERT INTO users(id,email,password_hash,name,role) VALUES ('restart-trust-admin','restart-trust@example.test','x','Restart trust','admin')`);
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
      await db.execute(sql`INSERT INTO factory_validator_results(tenant_id,project_id,validator_attempt_id,validator_id,terminal_fact_digest,artifact_id,artifact_digest,artifact_bytes,claims_json,issued_at_ms,expires_at_ms,evidence_digest,result_digest) VALUES (${tenantId},${projectId},'restart-validator-attempt',${claimId},${digest("6")},'restart-validator-output',${digest("5")},64,${`[{"id":"${claimId}","passed":true,"decisive":true}]`},1,2,${digest("3")},${digest("4")})`);
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
        { validator_id: "claim-a", claims_json: '[{"id":"claim-a","passed":true,"decisive":true}]' },
        { validator_id: "claim-b", claims_json: '[{"id":"claim-b","passed":true,"decisive":true}]' },
      ]);
      expect(rows<{ indexdef: string }>(await db.execute(sql`SELECT indexdef FROM pg_indexes WHERE indexname='uq_factory_validator_assignment_attempt_claim'`))).toHaveLength(1);
      const duplicate = await db.execute(sql`INSERT INTO factory_validator_results(tenant_id,project_id,validator_attempt_id,validator_id,terminal_fact_digest,artifact_id,artifact_digest,artifact_bytes,claims_json,issued_at_ms,expires_at_ms,evidence_digest,result_digest) VALUES (${tenantId},${projectId},'restart-validator-attempt','claim-a',${digest("6")},'restart-validator-output',${digest("5")},64,'[]',1,2,${digest("3")},${digest("4")})`).then(() => null, (error: unknown) => error);
      expect(duplicate).toBeInstanceOf(Error);
      const unassigned = await db.execute(sql`INSERT INTO factory_validator_results(tenant_id,project_id,validator_attempt_id,validator_id,terminal_fact_digest,artifact_id,artifact_digest,artifact_bytes,claims_json,issued_at_ms,expires_at_ms,evidence_digest,result_digest) VALUES (${tenantId},${projectId},'restart-validator-attempt','claim-never-assigned',${digest("6")},'restart-validator-output',${digest("5")},64,'[]',1,2,${digest("3")},${digest("4")})`).then(() => null, (error: unknown) => error);
      expect(unassigned).toBeInstanceOf(Error);
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
