import { afterEach, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";
import { FactoryExecutionJournal, type FactoryAttemptAuthority } from "./executions";
import type { FactoryRunnerRequest, JsonValue } from "@ezcorp/factory-sdk";
import { factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";

const databases: PGlite[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map(database => database.close()));
});

function authority(overrides: Partial<FactoryAttemptAuthority> = {}): FactoryAttemptAuthority {
  return {
    attemptId: "attempt-1",
    tenantId: "tenant-a",
    projectId: "project-a",
    runId: "run-a",
    nodeInstanceId: "node-a",
    candidateGeneration: 2,
    attemptNumber: 3,
    grantRevision: 4,
    reservationGeneration: 5,
    executionEpoch: 6,
    cancellationEpoch: 0,
    requestDigest: "a".repeat(64),
    deadlineAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

function runnerRequest(attempt: FactoryAttemptAuthority, input: JsonValue = { b: 2, a: 1 }): FactoryRunnerRequest {
  return {
    schemaVersion: "factory.runner.request.v1",
    authority: { attemptId: attempt.attemptId, tenantId: attempt.tenantId, projectId: attempt.projectId, runId: attempt.runId, nodeInstanceId: attempt.nodeInstanceId, candidateGeneration: attempt.candidateGeneration, attemptNumber: attempt.attemptNumber, grantRevision: attempt.grantRevision, reservationGeneration: attempt.reservationGeneration, executionEpoch: attempt.executionEpoch, cancellationEpoch: attempt.cancellationEpoch, deadlineAtMs: attempt.deadlineAt.getTime(), nextOperationIndex: 0 },
    runner: { package: "runner", version: "1", digest: `sha256:${"a".repeat(64)}`, export: "run" }, input: { kind: "inline", value: input }, grants: [], resources: {}, tools: [], broker: { attemptToken: "ephemeral-broker-token", audience: "gateway" },
  };
}

function admission(attempt: FactoryAttemptAuthority, input?: JsonValue) {
  const request = runnerRequest(attempt, input);
  return { ...attempt, requestDigest: factoryRunnerRequestDigest(request), request };
}

function operation(index: number) {
  const attempt = authority();
  return {
    operationId: `${attempt.runId}:${attempt.nodeInstanceId}:${attempt.candidateGeneration}:${index}`,
    operationIndex: index,
    kind: "model" as const,
    requestDigest: "a".repeat(64),
  };
}

test("durably admits, journals, cancels, and reconciles a tenant-scoped factory attempt", async () => {
  const database = new PGlite({ extensions: { vector, pg_trgm } });
  databases.push(database);
  await database.waitReady;
  const db = drizzle(database, { schema });
  await migrate(db);
  const definitionDigest = `sha256:${"a".repeat(64)}`;
  await db.execute(sql`INSERT INTO projects(id, name, path) VALUES ('project-a', 'Project A', '/tmp/project-a')`);
  await db.execute(sql`INSERT INTO factory_installation(singleton, tenant_id, execution_epoch) VALUES (1, 'tenant-a', 6)`);
  await db.execute(sql`INSERT INTO factory_projects(tenant_id, project_id) VALUES ('tenant-a', 'project-a')`);
  await db.execute(sql`INSERT INTO factory_runs(tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload) VALUES ('tenant-a', 'project-a', 'run-a', ${definitionDigest}, 'test', 6, 'run-request', '{}')`);

  const authorizations: string[] = [];
  const journal = new FactoryExecutionJournal(db, async (_transaction, current) => { authorizations.push(current.attemptId); });
  const attempt = admission(authority());
  expect(await journal.admit(attempt)).toMatchObject({ reused: false });
  expect(await journal.admit({ ...attempt, request: { ...attempt.request, broker: { ...attempt.request.broker, attemptToken: "reissued-broker-token" } } })).toMatchObject({ reused: true });
  await expect(journal.admit({ ...attempt, request: runnerRequest(attempt, { a: 3 }) })).rejects.toThrow("does not match");
  await expect(journal.admit(admission(authority({ tenantId: "tenant-b" })))).rejects.toThrow("epoch is stale");
  await expect(journal.admit(admission(authority({ attemptId: "unknown-project", projectId: "missing" })))).rejects.toThrow();

  const first = operation(0);
  await journal.prepare(attempt, first);
  expect(authorizations).toContain("attempt-1");
  await journal.prepare(attempt, first);
  await expect(journal.prepare(attempt, { ...first, requestDigest: "b".repeat(64) })).rejects.toThrow("conflicts");
  await expect(journal.prepare(attempt, { ...first, operationId: "foreign" })).rejects.toThrow("does not match");
  const ahead = operation(1);
  await journal.prepare(attempt, ahead);
  await expect(journal.prepare(attempt, operation(3))).rejects.toThrow("not contiguous");
  expect(await journal.dispatch(attempt, first.operationId)).toEqual({ claimed: true });
  expect(await journal.dispatch(attempt, ahead.operationId)).toEqual({ claimed: true });
  expect(await journal.dispatch(attempt, first.operationId)).toEqual({ claimed: false });
  await expect(journal.settle(attempt, first.operationId, "completed", { resultDigest: "result" })).rejects.toThrow("needs result, usage, and workspace checkpoint");
  await journal.settle(attempt, ahead.operationId, "completed", { resultDigest: "ahead", result: { output: "ahead" }, usage: { output: 2 }, workspaceCheckpoint: { revision: "checkpoint-2" } });
  expect(await journal.status(attempt)).toMatchObject({ status: "running", journalCursor: -1 });
  await journal.settle(attempt, first.operationId, "completed", { resultDigest: "result", result: { output: "first" }, usage: { output: 2 }, workspaceCheckpoint: { revision: "checkpoint-1" } });
  await journal.settle(attempt, first.operationId, "completed", { resultDigest: "result", result: { output: "first" }, usage: { output: 2 }, workspaceCheckpoint: { revision: "checkpoint-1" } });
  expect(await journal.operation(attempt, first.operationId)).toEqual({ state: "completed", result: { output: "first" } });
  expect(await journal.operations(attempt)).toEqual(expect.arrayContaining([
    expect.objectContaining({ operationId: first.operationId, operationIndex: 0, state: "completed", resultDigest: "result", usage: { output: 2 }, workspaceCheckpoint: { revision: "checkpoint-1" } }),
    expect.objectContaining({ operationId: ahead.operationId, operationIndex: 1, state: "completed", resultDigest: "ahead" }),
  ]));
  expect(await journal.status(attempt)).toMatchObject({ terminalResult: { output: "ahead" }, workspaceCheckpoint: { revision: "checkpoint-2" } });
  await journal.prepare(attempt, first);
  expect(await journal.dispatch(attempt, first.operationId)).toEqual({ claimed: false });
  await expect(journal.settle(attempt, first.operationId, "completed", { resultDigest: "changed", result: { output: "first" }, usage: { output: 2 }, workspaceCheckpoint: { revision: "checkpoint-1" } })).rejects.toThrow("cannot settle");
  expect(await journal.status(attempt)).toMatchObject({ status: "running", journalCursor: 1, cancelAcceptedAt: null });
  await expect(journal.prepare({ ...attempt, cancellationEpoch: 1 }, operation(2))).rejects.toThrow("stale, cancelled, or expired");

  const second = operation(2);
  await journal.prepare(attempt, second);
  await journal.dispatch(attempt, second.operationId);
  const expired = { ...attempt, deadlineAt: new Date(Date.now() - 1) };
  expect(await journal.cancel(expired)).toBe(true);
  expect(await journal.cancel(attempt)).toBe(false);
  expect(await journal.status(attempt)).toMatchObject({ status: "cancel_accepted", journalCursor: 1 });
  await expect(journal.settle(attempt, second.operationId, "failed", { resultDigest: "late" })).rejects.toThrow("stale, cancelled, or expired");
  await journal.reconcileLate(expired, second.operationId, { providerReceiptDigest: "provider-receipt", resultDigest: "late-result", usage: { charged: 1 }, workspaceCheckpoint: { revision: "late" } });
  await expect(journal.reconcileLate({ ...expired, requestDigest: "b".repeat(64) }, second.operationId, { providerReceiptDigest: "provider-receipt", resultDigest: "late-result", usage: { charged: 1 }, workspaceCheckpoint: { revision: "late" } })).rejects.toThrow("unavailable");
  expect(await journal.status(attempt)).toMatchObject({ status: "cancel_accepted", journalCursor: 1 });
  expect(await journal.confirmStopped(expired)).toBe(true);
  expect(await journal.status(attempt)).toMatchObject({ status: "stopped" });
  expect(await journal.confirmStopped(attempt)).toBe(false);

  const resumed = admission(authority({ attemptId: "attempt-resumed", attemptNumber: 4 }));
  expect(await journal.admit(resumed)).toMatchObject({ reused: false });
  await expect(journal.prepare(resumed, operation(0))).rejects.toThrow("not contiguous");
  await journal.prepare(resumed, operation(3));

  await expect(journal.status({ ...attempt, grantRevision: 99 })).rejects.toThrow("unavailable");
  expect(await journal.cancel(expired)).toBe(false);

  const mutable = admission(authority({ attemptId: "attempt-snapshot", attemptNumber: 9 }));
  const expected = { ...mutable, deadlineAt: new Date(mutable.deadlineAt) };
  const snapshotJournal = new FactoryExecutionJournal(db, async () => {
    (mutable as { tenantId: string }).tenantId = "tenant-b";
    mutable.deadlineAt.setTime(0);
  });
  expect(await snapshotJournal.admit(mutable)).toMatchObject({ reused: false });
  expect(await snapshotJournal.status(expected)).toMatchObject({ status: "admitted" });
});
