import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { FactoryRunnerAuthority } from "@ezcorp/factory-sdk";
import type { TransactionalDb } from "../../db/migrations/types";
import { FileBlobStore } from "../../extensions/v4/blobs";
import type { BlobStore } from "../../extensions/v4/types";
import { FactoryArtifacts } from "../../factory/artifacts";
import { FactoryAttemptMaterials, FactoryScopedMaterials, type FactoryMaterialScope } from "../../factory/artifact-materials";
import { EncryptedBlobStore, InstallationDataKey, StaticMasterKeyProvider, type InstallationKeyWrap, type InstallationKeyWrapStore } from "../../factory/encryption";
import { FactoryExecutionJournal, type FactoryAttemptAuthority } from "../../factory/executions";
import { REFERENCE_DATA_HEADER } from "../../factory/reference-data/csv";

/** C10's golden three-row input. */
export const REFERENCE_DATA_GOLDEN_CSV = `${REFERENCE_DATA_HEADER}\na,alpha,100\nb,beta,250\nc,alpha,50\n`;

/** The one tenant every reference-data world is admitted under. */
export const REFERENCE_DATA_TENANT = "reference-data-tenant";

/** One admitted attempt's W04 materials, as the reference-data pack consumes them. */
export interface ReferenceDataMaterialsWorld {
  readonly db: TransactionalDb;
  readonly materials: FactoryAttemptMaterials;
  readonly reader: FactoryScopedMaterials;
  /** The journey's BASE scope. */
  readonly scope: FactoryMaterialScope;
  /** The runner authority every request of this attempt repeats. */
  readonly authority: Omit<FactoryRunnerAuthority, "nodeInstanceId">;
  /** An empty directory for the journey's per-attempt material directories. */
  readonly workRoot: string;
}

/**
 * Admits one fresh project, run and attempt in `db` and wires the real W04
 * materials and scoped reader over encrypted blobs, so a reference-data journey
 * seals and reads exactly what production would.
 *
 * Every world gets its own project, run and attempt, so several worlds share
 * one database without seeing each other's materials. Every temporary
 * directory this creates is handed to `track`; the caller removes them.
 */
export async function referenceDataMaterialsWorld(
  fixture: { readonly db: TransactionalDb; readonly blobs?: BlobStore },
  track: (directory: string) => void,
): Promise<ReferenceDataMaterialsWorld> {
  const db = fixture.db;
  const tenantId = REFERENCE_DATA_TENANT;
  const projectId = `refdata-project-${randomUUID()}`;
  const runId = `refdata-run-${randomUUID()}`;
  const attemptId = `refdata-attempt-${randomUUID()}`;
  await db.execute(sql`INSERT INTO projects(id, name, path) VALUES (${projectId}, 'Reference data', ${`/tmp/${projectId}`})`);
  await db.execute(sql`INSERT INTO factory_installation(singleton, tenant_id, execution_epoch) VALUES (1, ${tenantId}, 6) ON CONFLICT (singleton) DO UPDATE SET tenant_id=EXCLUDED.tenant_id, execution_epoch=EXCLUDED.execution_epoch`);
  await db.execute(sql`INSERT INTO factory_projects(tenant_id, project_id) VALUES (${tenantId}, ${projectId})`);
  await db.execute(sql`INSERT INTO factory_runs(tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload) VALUES (${tenantId}, ${projectId}, ${runId}, ${`sha256:${"a".repeat(64)}`}, 'test', 6, 'request', '{}')`);
  const authority: FactoryAttemptAuthority = {
    attemptId, tenantId, projectId, runId, nodeInstanceId: "reference-data", candidateGeneration: 0, attemptNumber: 1,
    grantRevision: 1, reservationGeneration: 1, executionEpoch: 6, cancellationEpoch: 0, requestDigest: "a".repeat(64),
    deadlineAt: new Date(Date.now() + 3_600_000),
  };
  await db.execute(sql`INSERT INTO factory_executions(attempt_id,tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_number,grant_revision,reservation_generation,execution_epoch,cancellation_epoch,deadline_at,request_hash,request_json,status)
    VALUES (${authority.attemptId},${authority.tenantId},${authority.projectId},${authority.runId},${authority.nodeInstanceId},${authority.candidateGeneration},${authority.attemptNumber},${authority.grantRevision},${authority.reservationGeneration},${authority.executionEpoch},${authority.cancellationEpoch},${authority.deadlineAt},${authority.requestDigest},'{}'::jsonb,'admitted')`);
  const root = await mkdtemp(join(tmpdir(), "refdata-blobs-"));
  track(root);
  const wraps: InstallationKeyWrap[] = [];
  const store: InstallationKeyWrapStore = { async load() { return wraps; }, async save(value) { wraps.push(value); } };
  const key = await InstallationDataKey.loadOrCreate("refdata-installation", store, new StaticMasterKeyProvider({ id: "operator", bytes: new Uint8Array(32).fill(5) }));
  const blobs = new EncryptedBlobStore(fixture.blobs ?? new FileBlobStore(root), key, tenantId);
  const artifacts = new FactoryArtifacts(db, blobs, tenantId);
  const journal = new FactoryExecutionJournal(db, async () => {}, () => new Date());
  const workRoot = await mkdtemp(join(tmpdir(), "refdata-work-"));
  track(workRoot);
  return {
    db,
    materials: new FactoryAttemptMaterials({ database: db, artifacts, blobs, journal, authority }),
    reader: new FactoryScopedMaterials({ database: db, artifacts, blobs }),
    scope: { tenantId, projectId, runId, attemptId, operationId: `${runId}:reference-data:0:0` },
    authority: {
      attemptId, tenantId, projectId, runId, candidateGeneration: 0, attemptNumber: 1, grantRevision: 1,
      reservationGeneration: 1, executionEpoch: 6, cancellationEpoch: 0, deadlineAtMs: Date.now() + 3_600_000, nextOperationIndex: 0,
    },
    workRoot,
  };
}
