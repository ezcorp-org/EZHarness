import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { sql } from "drizzle-orm";
import { migrate } from "../../src/db/migrate";
import { __test } from "../../src/db/connection";
import { releaseRows } from "../../src/db/queries/extension-releases";
import * as schema from "../../src/db/schema";
import { FactoryExecutionJournal, type FactoryAttemptAuthority } from "../../src/factory/executions";

const url = process.env.FACTORY_TEST_POSTGRES_URL;
if (!url) throw new Error("FACTORY_TEST_POSTGRES_URL is required for real PostgreSQL conformance.");

function authority(overrides: Partial<FactoryAttemptAuthority> = {}): FactoryAttemptAuthority {
  return { attemptId: "execution-attempt", tenantId: "execution-tenant", projectId: "execution-project", runId: "execution-run", nodeInstanceId: "execution-node", candidateGeneration: 1, attemptNumber: 1, grantRevision: 1, reservationGeneration: 1, executionEpoch: 1, deadlineAt: new Date(Date.now() + 60_000), ...overrides };
}

function operation(index: number) {
  const attempt = authority();
  return { operationId: `${attempt.runId}:${attempt.nodeInstanceId}:${attempt.candidateGeneration}:${index}`, operationIndex: index, kind: "model" as const, requestDigest: "e".repeat(64) };
}

describe("factory execution journal on real Bun.sql PostgreSQL", () => {
  let admin: SQL;
  let client: SQL;
  let databaseName: string;
  let db: ReturnType<typeof drizzle>;
  let journal: FactoryExecutionJournal;

  beforeAll(async () => {
    admin = new SQL(url!, { max: 1 });
    databaseName = `factory_execution_${randomUUID().replaceAll("-", "")}`;
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    const isolated = new URL(url!);
    isolated.pathname = `/${databaseName}`;
    client = new SQL(isolated.toString(), { max: 4 });
    db = drizzle(client, { schema });
    await __test.applyBunSqlJsonbFix();
    __test.setState(db, null);
    await __test.withPostgresMigrateLock(migrationDb => migrate(migrationDb));
    await db.execute(sql`INSERT INTO projects(id, name, path) VALUES ('execution-project', 'Execution', '/tmp/execution')`);
    await db.execute(sql`INSERT INTO factory_installation(singleton, tenant_id, execution_epoch) VALUES (1, 'execution-tenant', 1)`);
    await db.execute(sql`INSERT INTO factory_projects(tenant_id, project_id) VALUES ('execution-tenant', 'execution-project')`);
    await db.execute(sql`INSERT INTO factory_runs(tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload) VALUES ('execution-tenant', 'execution-project', 'execution-run', ${`sha256:${"a".repeat(64)}`}, 'postgres-test', 1, 'request', '{}')`);
    journal = new FactoryExecutionJournal(db, async () => {});
  });

  afterAll(async () => {
    await client?.close();
    if (databaseName) await admin.unsafe(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin?.close();
  });

  test("canonical admission rejects a foreign authority and a response-loss retry reuses one row", async () => {
    const attempt = authority();
    expect(await journal.admit({ ...attempt, request: { b: 2, a: 1 } })).toMatchObject({ reused: false });
    expect(await journal.admit({ ...attempt, request: { a: 1, b: 2 } })).toMatchObject({ reused: true });
    await expect(journal.admit({ ...attempt, tenantId: "foreign-tenant", request: { a: 1, b: 2 } })).rejects.toThrow("epoch is stale");
    expect(releaseRows(await db.execute(sql`SELECT attempt_id FROM factory_executions`))).toHaveLength(1);
  });

  test("racing attempt authorities admit at most one canonical identity", async () => {
    const base = authority({ attemptId: "racing-attempt" });
    const outcomes = await Promise.allSettled([
      journal.admit({ ...base, grantRevision: 10, request: { task: "same" } }),
      journal.admit({ ...base, grantRevision: 11, request: { task: "same" } }),
    ]);
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1);
    expect(releaseRows(await db.execute(sql`SELECT attempt_id FROM factory_executions WHERE attempt_id = 'racing-attempt'`))).toHaveLength(1);
  });

  test("out-of-order results cannot advance the cursor across an unfinished operation", async () => {
    const attempt = authority();
    const zero = operation(0);
    const one = operation(1);
    await journal.prepare(attempt, zero);
    await journal.prepare(attempt, one);
    await journal.dispatch(attempt, zero.operationId);
    await journal.dispatch(attempt, one.operationId);
    await journal.settle(attempt, one.operationId, "completed", { resultDigest: "one", usage: { tokens: 1 }, workspaceCheckpoint: { snapshot: 1 } });
    expect(await journal.status(attempt)).toMatchObject({ journalCursor: -1 });
    await journal.settle(attempt, zero.operationId, "completed", { resultDigest: "zero", usage: { tokens: 1 }, workspaceCheckpoint: { snapshot: 0 } });
    await journal.settle(attempt, zero.operationId, "completed", { resultDigest: "zero", usage: { tokens: 1 }, workspaceCheckpoint: { snapshot: 0 } });
    await expect(journal.settle(attempt, zero.operationId, "completed", { resultDigest: "changed", usage: { tokens: 1 }, workspaceCheckpoint: { snapshot: 0 } })).rejects.toThrow("cannot settle");
    expect(await journal.status(attempt)).toMatchObject({ journalCursor: 1 });
  });
});
