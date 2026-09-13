import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import type { FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import { factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";
import { migrate } from "../../db/migrate";
import * as schema from "../../db/schema";
import type { TransactionalDb } from "../../db/migrations/types";
import type { FactoryPreparedPackageReceipt } from "../../factory/package-preparation";
import type { FactoryAttemptLease } from "../../factory/runner/attempt-runtime";

const raw = "a".repeat(64);
export const factoryLaunchDigest = `sha256:${raw}`;
export const factoryLaunchArtifactDigest = raw;

/** One canonical C02 runner request. Every identity field is explicit so a test can vary exactly one. */
export function factoryLaunchRequest(overrides: { attemptId?: string; candidateGeneration?: number; attemptNumber?: number; model?: string; configurationDigest?: string } = {}): FactoryRunnerRequest {
  return {
    schemaVersion: "factory.runner.request.v1",
    authority: {
      attemptId: overrides.attemptId ?? "attempt-recovery",
      tenantId: "tenant-recovery", projectId: "project-recovery", runId: "run-recovery", nodeInstanceId: "node-recovery",
      candidateGeneration: overrides.candidateGeneration ?? 2, attemptNumber: overrides.attemptNumber ?? 3,
      grantRevision: 4, reservationGeneration: 5, executionEpoch: 6, cancellationEpoch: 0,
      deadlineAtMs: Date.now() + 600_000, nextOperationIndex: 0,
    },
    runner: { package: "runner", version: "1", digest: factoryLaunchDigest, export: "run", model: overrides.model ?? "recovery-model", configurationDigest: overrides.configurationDigest ?? factoryLaunchDigest },
    input: { kind: "inline", value: { prompt: "recovery" } },
    grants: [], resources: {}, tools: [],
    broker: { audience: "gateway", attemptToken: "ephemeral-token" },
  };
}

export const factoryLaunchLease: FactoryAttemptLease = { reservationId: "reservation-recovery", grantRevision: 4, allocationGeneration: 5, holderGeneration: 5, allocationToken: "allocation-recovery", hostId: "host-recovery" };

export function factoryLaunchPackage(request: FactoryRunnerRequest, artifactDigest = factoryLaunchArtifactDigest): FactoryPreparedPackageReceipt {
  return { projectId: request.authority.projectId, reference: request.runner, trustRevision: 1, packageTrustDigest: factoryLaunchDigest, releaseDigest: factoryLaunchDigest, sourceDigest: factoryLaunchDigest, artifactDigest, imageDigest: factoryLaunchDigest, manifestDigest: factoryLaunchDigest, evidenceDigest: factoryLaunchDigest, buildIdentity: "build-recovery", receiptDigest: factoryLaunchDigest };
}

export interface FactoryLaunchFixture {
  readonly db: TransactionalDb;
  admit(request: FactoryRunnerRequest): Promise<void>;
  close(): Promise<void>;
}

/**
 * A migrated product database holding the project, run, and admitted attempt
 * rows that a durable launch intent needs. Every launch suite shares it so the
 * seeding stays in one place.
 */
export async function createFactoryLaunchFixture(request: FactoryRunnerRequest): Promise<FactoryLaunchFixture> {
  const database = new PGlite({ extensions: { vector, pg_trgm } });
  await database.waitReady;
  const db = drizzle(database, { schema }) as unknown as TransactionalDb;
  await migrate(db as never);
  const { tenantId, projectId, runId } = request.authority;
  await db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${projectId},'Factory launch','/tmp/factory-launch')`);
  await db.execute(sql`INSERT INTO factory_installation(singleton,tenant_id,execution_epoch) VALUES (1,${tenantId},${request.authority.executionEpoch})`);
  await db.execute(sql`INSERT INTO factory_projects(tenant_id,project_id) VALUES (${tenantId},${projectId})`);
  await db.execute(sql`INSERT INTO factory_runs(tenant_id,project_id,run_id,definition_digest,interpreter_build,execution_epoch,request_digest,request_payload) VALUES (${tenantId},${projectId},${runId},${factoryLaunchDigest},'recovery',${request.authority.executionEpoch},${factoryLaunchDigest},'{}')`);
  const fixture: FactoryLaunchFixture = {
    db,
    admit: async (admitted: FactoryRunnerRequest) => {
      const authority = admitted.authority;
      await db.execute(sql`INSERT INTO factory_executions(attempt_id,tenant_id,project_id,run_id,node_instance_id,candidate_generation,attempt_number,grant_revision,reservation_generation,execution_epoch,cancellation_epoch,deadline_at,request_hash,request_json,status) VALUES (${authority.attemptId},${authority.tenantId},${authority.projectId},${authority.runId},${authority.nodeInstanceId},${authority.candidateGeneration},${authority.attemptNumber},${authority.grantRevision},${authority.reservationGeneration},${authority.executionEpoch},${authority.cancellationEpoch},${new Date(authority.deadlineAtMs)},${factoryRunnerRequestDigest(admitted)},'{}','admitted')`);
    },
    close: async () => { await database.close(); },
  };
  await fixture.admit(request);
  return fixture;
}

/** One canonical completed result whose checkpoint and cursor agree with its single operation. */
export function factoryLaunchCompletedResult(seed = "recovery"): import("@ezcorp/factory-sdk").FactoryRunnerResult {
  const resultDigest = "b".repeat(64);
  const checkpoint = { artifactId: `checkpoint-${seed}`, digest: `sha256:${"c".repeat(64)}`, encodedBytes: 128, journalCursor: 0 };
  return {
    schemaVersion: "factory.runner.result.v1",
    status: "completed",
    journalCursor: 0,
    operations: [{
      operationId: `operation-${seed}:0`, operationIndex: 0, kind: "model", requestDigest: "d".repeat(64),
      state: "completed", resultDigest: "e".repeat(64),
      usage: { kind: "measured", inputTokens: 11, outputTokens: 7, computeMs: 21, costMicros: "1200" },
      workspaceCheckpoint: checkpoint,
    }],
    resultDigest,
    output: { artifactId: `output-${seed}`, digest: `sha256:${resultDigest}`, encodedBytes: 256 },
    usage: { kind: "measured", inputTokens: 11, outputTokens: 7, computeMs: 21, costMicros: "1200" },
    workspaceCheckpoint: checkpoint,
  };
}
