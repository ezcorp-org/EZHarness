import { afterEach, beforeEach, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import type { FactoryRunnerRequest, FactoryRunnerResult } from "@ezcorp/factory-sdk";
import { factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";
import { migrate } from "../../db/migrate";
import * as schema from "../../db/schema";
import type { MigrationDb, TransactionalDb } from "../../db/migrations/types";
import { FactoryAttemptQueue } from "../attempt-queue";
import { FactoryExecutionJournal, type FactoryAttemptAuthority } from "../executions";
import { FactoryPackagePreparationError } from "../package-preparation";
import type { FactoryPreparedPackageReceipt } from "../package-preparation";
import type { TrustedFactoryCommandReference, TrustedFactoryServiceIdentity } from "../trusted-command-gateway";
import { createFactoryAttemptDispatchDriver } from "./attempt-dispatch-driver";
import type { FactoryAttemptLease, FactoryAttemptOpen, FactoryAttemptRuntime } from "./attempt-runtime";

const tenantId = "dispatch-tenant";
const projectId = "dispatch-project";
const runId = "dispatch-run";
const digest = `sha256:${"a".repeat(64)}`;
const service: TrustedFactoryServiceIdentity = { subject: "dispatch-service", tenantId };
const lease: FactoryAttemptLease = { reservationId: "reservation-dispatch", grantRevision: 1, allocationGeneration: 1, holderGeneration: 1, allocationToken: "allocation-dispatch", hostId: "host-dispatch" };
const prepared: FactoryPreparedPackageReceipt = { projectId, reference: { package: "runner", manifestName: "runner", version: "1", digest, export: "run" }, trustRevision: 1, packageTrustDigest: digest, releaseDigest: digest, sourceDigest: digest, artifactDigest: "a".repeat(64), imageDigest: digest, manifestDigest: digest, evidenceDigest: digest, buildIdentity: "build-dispatch", receiptDigest: digest };
const completed: FactoryRunnerResult = { schemaVersion: "factory.runner.result.v1", status: "cancelled", journalCursor: 0, operations: [] };

let database: PGlite;
let db: TransactionalDb;
let queue: FactoryAttemptQueue;
let now: number;

function authority(attemptId: string): FactoryAttemptAuthority {
  return { attemptId, tenantId, projectId, runId, nodeInstanceId: `node-${attemptId}`, candidateGeneration: 1, attemptNumber: 1, grantRevision: 1, reservationGeneration: 1, executionEpoch: 1, cancellationEpoch: 0, requestDigest: "a".repeat(64), deadlineAt: new Date(now + 600_000) };
}
function request(value: FactoryAttemptAuthority): FactoryRunnerRequest {
  return { schemaVersion: "factory.runner.request.v1", authority: { attemptId: value.attemptId, tenantId, projectId, runId, nodeInstanceId: value.nodeInstanceId, candidateGeneration: 1, attemptNumber: 1, grantRevision: 1, reservationGeneration: 1, executionEpoch: 1, cancellationEpoch: 0, deadlineAtMs: value.deadlineAt.getTime(), nextOperationIndex: 0 }, runner: { package: "runner", manifestName: "runner", version: "1", digest, export: "run" }, input: { kind: "inline", value: { attemptId: value.attemptId } }, grants: [], resources: {}, tools: [], broker: { attemptToken: `token-${value.attemptId}`, audience: "factory-gateway" } };
}
function admission(attemptId: string) {
  const value = authority(attemptId);
  const runnerRequest = request(value);
  return { ...value, requestDigest: factoryRunnerRequestDigest(runnerRequest), request: runnerRequest };
}
const commandReference = (attemptId: string): TrustedFactoryCommandReference => ({ tenantId, projectId, logicalRunId: runId, interpreterId: "partition-1", commandId: attemptId });

/** Records what the dispatcher settled without standing in for the stores' own proofs. */
function recorder() {
  const completions: string[] = [];
  const outcomes: string[] = [];
  return {
    completions,
    outcomes,
    completionStore: {
      completeInTransaction: async (_t: MigrationDb, _s: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference) => { completions.push(reference.commandId); return { commandId: reference.commandId } as never; },
      readInTransaction: async () => undefined,
    },
    outcomeStore: {
      recordInTransaction: async (_t: MigrationDb, _s: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference) => { outcomes.push(reference.commandId); return { commandId: reference.commandId } as never; },
      readInTransaction: async () => undefined,
    },
  };
}

beforeEach(async () => {
  now = Date.now();
  database = new PGlite({ extensions: { vector, pg_trgm } });
  await database.waitReady;
  db = drizzle(database, { schema }) as unknown as TransactionalDb;
  await migrate(db as never);
  await db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${projectId},'Dispatch','/tmp/dispatch')`);
  await db.execute(sql`INSERT INTO factory_installation(singleton,tenant_id,execution_epoch) VALUES (1,${tenantId},1)`);
  await db.execute(sql`INSERT INTO factory_projects(tenant_id,project_id) VALUES (${tenantId},${projectId})`);
  await db.execute(sql`INSERT INTO factory_runs(tenant_id,project_id,run_id,definition_digest,interpreter_build,execution_epoch,request_digest,request_payload) VALUES (${tenantId},${projectId},${runId},${digest},'dispatch',1,'run-request','{}')`);
  queue = new FactoryAttemptQueue(db, new FactoryExecutionJournal(db, async () => {}, () => new Date(now)), tenantId, () => now);
});
afterEach(async () => { await database.close(); });

function driver(options: { runtime: FactoryAttemptRuntime; ready?: () => Promise<FactoryPreparedPackageReceipt>; store?: ReturnType<typeof recorder> }) {
  const store = options.store ?? recorder();
  return {
    store,
    driver: createFactoryAttemptDispatchDriver({
      database: db, service, installationId: "installation-dispatch", attemptTokenSecret: "s".repeat(48), queue,
      completions: store.completionStore as never,
      outcomes: store.outcomeStore as never,
      readiness: { assertDispatchReady: options.ready ?? (async () => prepared) },
      runtime: options.runtime,
      preflight: { lease: async () => lease, preparedPackage: async () => prepared },
    }),
  };
}

const openWith = (result: FactoryRunnerResult, opened: string[]): FactoryAttemptRuntime => ({
  open: async (value) => {
    opened.push(value.authority.attemptId);
    return { disposition: "started", workerId: "worker", invocationId: "invocation", wait: async () => result, stop: async () => { throw new Error("stop is not part of this dispatch"); } } as FactoryAttemptOpen;
  },
});

test("an empty queue is idle and never reaches the runtime", async () => {
  const opened: string[] = [];
  const composed = driver({ runtime: openWith(completed, opened) });
  expect(await composed.driver.dispatchOne()).toEqual({ kind: "idle" });
  expect(opened).toEqual([]);
});

test("a queued attempt is claimed, dispatched through the runtime, and settled", async () => {
  const opened: string[] = [];
  const composed = driver({ runtime: openWith(completed, opened) });
  const queued = admission("attempt-dispatch-1");
  await queue.enqueue(queued, commandReference(queued.attemptId), lease.reservationId);

  const result = await composed.driver.dispatchOne();
  expect(result.kind).not.toBe("idle");
  // The runtime saw exactly the claimed attempt, once.
  expect(opened).toEqual([queued.attemptId]);
  expect([...composed.store.completions, ...composed.store.outcomes]).toContain(queued.attemptId);

  // The attempt is no longer claimable, so a second pass is idle.
  expect(await composed.driver.dispatchOne()).toEqual({ kind: "idle" });
  expect(opened).toEqual([queued.attemptId]);
});

test("a package the readiness check denies never reaches the runtime", async () => {
  const opened: string[] = [];
  const composed = driver({
    runtime: openWith(completed, opened),
    ready: async () => { throw new FactoryPackagePreparationError("factory_package_revoked"); },
  });
  const queued = admission("attempt-dispatch-denied");
  await queue.enqueue(queued, commandReference(queued.attemptId), lease.reservationId);

  expect(await composed.driver.dispatchOne()).toEqual({ kind: "cancelled", attemptId: queued.attemptId });
  expect(opened).toEqual([]);
});

test("a readiness failure that is merely unavailable retries instead of cancelling", async () => {
  const opened: string[] = [];
  const composed = driver({
    runtime: openWith(completed, opened),
    ready: async () => { throw new FactoryPackagePreparationError("factory_package_not_prepared"); },
  });
  const queued = admission("attempt-dispatch-retry");
  await queue.enqueue(queued, commandReference(queued.attemptId), lease.reservationId);

  expect(await composed.driver.dispatchOne()).toEqual({ kind: "retry", attemptId: queued.attemptId });
  expect(opened).toEqual([]);
});
