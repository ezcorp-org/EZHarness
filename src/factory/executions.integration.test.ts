import { afterEach, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";
import { FactoryExecutionJournal, type FactoryAttemptAuthority } from "./executions";

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
    deadlineAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
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
  await db.execute(sql`INSERT INTO projects(id, name, path) VALUES ('project-a', 'Project A', '/tmp/project-a')`);
  await db.execute(sql`INSERT INTO runs(id, agent_name, project_id, status, started_at) VALUES ('run-a', 'agent', 'project-a', 'running', NOW())`);

  const journal = new FactoryExecutionJournal(db);
  const attempt = authority();
  expect(await journal.admit({ ...attempt, request: { b: 2, a: 1 } })).toMatchObject({ reused: false });
  expect(await journal.admit({ ...attempt, request: { a: 1, b: 2 } })).toMatchObject({ reused: true });
  await expect(journal.admit({ ...attempt, request: { a: 3 } })).rejects.toThrow("conflicts");
  await expect(journal.admit({ ...authority({ attemptId: "unknown-project", projectId: "missing" }), request: {} })).rejects.toThrow("project does not exist");

  const first = operation(7);
  await journal.prepare(attempt, first);
  await journal.prepare(attempt, first);
  await expect(journal.prepare(attempt, { ...first, requestDigest: "b".repeat(64) })).rejects.toThrow("conflicts");
  await expect(journal.prepare(attempt, { ...first, operationId: "foreign" })).rejects.toThrow("does not match");
  await journal.dispatch(attempt, first.operationId);
  await journal.dispatch(attempt, first.operationId);
  await expect(journal.settle(attempt, first.operationId, "completed", { resultDigest: "result" })).rejects.toThrow("needs result, usage, and workspace checkpoint");
  await journal.settle(attempt, first.operationId, "completed", { resultDigest: "result", usage: { output: 2 }, workspaceCheckpoint: { revision: "checkpoint-1" } });
  expect(await journal.status(attempt)).toMatchObject({ status: "running", journalCursor: 7, cancelAcceptedAt: null });

  const second = operation(8);
  await journal.prepare(attempt, second);
  await journal.dispatch(attempt, second.operationId);
  expect(await journal.cancel(attempt)).toBe(true);
  expect(await journal.cancel(attempt)).toBe(false);
  expect(await journal.status(attempt)).toMatchObject({ status: "cancel_accepted", journalCursor: 7 });
  await expect(journal.settle(attempt, second.operationId, "failed", { resultDigest: "late" })).rejects.toThrow("stale, cancelled, or expired");
  await journal.reconcileLate(attempt, second.operationId, "provider-receipt");
  expect(await journal.status(attempt)).toMatchObject({ status: "cancel_accepted", journalCursor: 7 });
  expect(await journal.confirmStopped(attempt)).toBe(true);
  expect(await journal.status(attempt)).toMatchObject({ status: "stopped" });
  expect(await journal.confirmStopped(attempt)).toBe(false);

  await expect(journal.status(authority({ grantRevision: 99 }))).rejects.toThrow("unavailable");
  await expect(journal.cancel(authority({ deadlineAt: new Date(Date.now() - 1) }))).rejects.toThrow("stale, or expired");
});
