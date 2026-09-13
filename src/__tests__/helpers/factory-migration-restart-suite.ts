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
