import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { sql } from "drizzle-orm";
import type { FactoryRunnerRequest, JsonValue } from "@ezcorp/factory-sdk";
import { factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";
import { migrate } from "../../src/db/migrate";
import { __test } from "../../src/db/connection";
import { releaseRows } from "../../src/db/queries/extension-releases";
import * as schema from "../../src/db/schema";
import { FactoryExecutionJournal, type FactoryAttemptAuthority } from "../../src/factory/executions";
import { FactoryDatabaseAttemptLaunchStore, type FactoryAttemptDeviceAuthorization, type FactoryAttemptLease } from "../../src/factory/runner/attempt-runtime";
import { factoryLaunchPackage } from "../../src/__tests__/helpers/factory-attempt-launch-fixture";
import { nativeFactoryJournal } from "../../src/factory/runner/native";
import { verifyFactoryExecutionAdmission } from "../../src/__tests__/helpers/factory-execution-admission-suite";

const url = process.env.FACTORY_TEST_POSTGRES_URL;
if (!url) throw new Error("FACTORY_TEST_POSTGRES_URL is required for real PostgreSQL conformance.");

function authority(overrides: Partial<FactoryAttemptAuthority> = {}): FactoryAttemptAuthority {
  return { attemptId: "execution-attempt", tenantId: "execution-tenant", projectId: "execution-project", runId: "execution-run", nodeInstanceId: "execution-node", candidateGeneration: 1, attemptNumber: 1, grantRevision: 1, reservationGeneration: 1, executionEpoch: 1, cancellationEpoch: 0, requestDigest: "a".repeat(64), deadlineAt: new Date(Date.now() + 60_000), ...overrides };
}

function runnerRequest(attempt: FactoryAttemptAuthority, input: JsonValue = { task: "same" }): FactoryRunnerRequest {
  return { schemaVersion: "factory.runner.request.v1", authority: { attemptId: attempt.attemptId, tenantId: attempt.tenantId, projectId: attempt.projectId, runId: attempt.runId, nodeInstanceId: attempt.nodeInstanceId, candidateGeneration: attempt.candidateGeneration, attemptNumber: attempt.attemptNumber, grantRevision: attempt.grantRevision, reservationGeneration: attempt.reservationGeneration, executionEpoch: attempt.executionEpoch, cancellationEpoch: attempt.cancellationEpoch, deadlineAtMs: attempt.deadlineAt.getTime(), nextOperationIndex: 0 }, runner: { package: "runner", manifestName: "runner", version: "1", digest: `sha256:${"a".repeat(64)}`, export: "run" }, input: { kind: "inline", value: input }, grants: [], resources: {}, tools: [], broker: { attemptToken: "ephemeral-postgres-token", audience: "gateway" } };
}

function admission(attempt: FactoryAttemptAuthority, input?: JsonValue) {
  const request = runnerRequest(attempt, input);
  return { ...attempt, requestDigest: factoryRunnerRequestDigest(request), request };
}

function operationFor(attempt: FactoryAttemptAuthority, index: number) {
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
    const attempt = admission(authority(), { b: 2, a: 1 });
    expect(await journal.admit(attempt)).toMatchObject({ reused: false });
    expect(await journal.admit({ ...attempt, request: { ...attempt.request, broker: { ...attempt.request.broker, attemptToken: "reissued-postgres-token" } } })).toMatchObject({ reused: true });
    await expect(journal.admit(admission(authority({ tenantId: "foreign-tenant" }), { a: 1, b: 2 }))).rejects.toThrow("epoch is stale");
    expect(releaseRows(await db.execute(sql`SELECT attempt_id FROM factory_executions`))).toHaveLength(1);
  });

  test("transactional admission and durable request recovery match PGlite", async () => {
    const transactionalAuthority = authority({ attemptId: "transactional-attempt", nodeInstanceId: "transactional-node", candidateGeneration: 17 });
    await expect(verifyFactoryExecutionAdmission({
      db,
      journal,
      admission: input => admission(transactionalAuthority, input),
      foreignAuthority: admission({ ...transactionalAuthority, tenantId: "foreign-tenant" }),
    })).resolves.toBeUndefined();
  });

  test("racing attempt authorities admit at most one canonical identity", async () => {
    const base = authority({ attemptId: "racing-attempt" });
    const outcomes = await Promise.allSettled([
      journal.admit(admission({ ...base, grantRevision: 10 })),
      journal.admit(admission({ ...base, grantRevision: 11 })),
    ]);
    expect(outcomes.filter(outcome => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.status === "rejected")).toHaveLength(1);
    expect(releaseRows(await db.execute(sql`SELECT attempt_id FROM factory_executions WHERE attempt_id = 'racing-attempt'`))).toHaveLength(1);
  });

  test("native results read a single durable operation and cursor snapshot", async () => {
    const attempt = admission(authority({ attemptId: "native-snapshot-attempt", nodeInstanceId: "native-snapshot-node" }));
    await journal.admit(attempt);
    const operation = operationFor(attempt, 0);
    await journal.prepare(attempt, operation);
    await journal.dispatch(attempt, operation.operationId);
    const usage = { kind: "measured" as const, inputTokens: 1, outputTokens: 2, computeMs: 3, costMicros: "4" };
    await journal.settle(attempt, operation.operationId, "completed", { resultDigest: "a".repeat(64), result: { output: "done" }, usage, workspaceCheckpoint: { artifactId: "checkpoint", digest: `sha256:${"b".repeat(64)}`, encodedBytes: 4, journalCursor: 0 } });
    const snapshot = await nativeFactoryJournal(journal).snapshot(attempt.request);
    expect(snapshot).toMatchObject({ journalCursor: 0, usage, operations: [{ ...operation, state: "completed" }] });
    await expect(journal.evidence({ ...attempt, requestDigest: "b".repeat(64) })).rejects.toThrow("unavailable");
    await db.execute(sql`UPDATE factory_executions SET journal_cursor=9007199254740992 WHERE attempt_id=${attempt.attemptId}`);
    await expect(journal.evidence(attempt)).rejects.toThrow("Factory journal cursor is corrupt");
    await db.execute(sql`UPDATE factory_executions SET journal_cursor=0 WHERE attempt_id=${attempt.attemptId}`);
  });

  test("out-of-order results cannot advance the cursor across an unfinished operation", async () => {
    const attempt = admission(authority({ attemptId: "cursor-attempt" }));
    await journal.admit(attempt);
    const zero = operationFor(attempt, 0);
    const one = operationFor(attempt, 1);
    await journal.prepare(attempt, zero);
    await journal.prepare(attempt, one);
    await journal.dispatch(attempt, zero.operationId);
    await journal.dispatch(attempt, one.operationId);
    await journal.settle(attempt, one.operationId, "completed", { resultDigest: "one", result: { output: "one" }, usage: { kind: "measured" as const, inputTokens: 1, outputTokens: 0, computeMs: 2, costMicros: "3" }, workspaceCheckpoint: { artifactId: "cursor-checkpoint-1", digest: `sha256:${"c".repeat(64)}`, encodedBytes: 2, journalCursor: 1 } });
    expect(await journal.status(attempt)).toMatchObject({ journalCursor: -1 });
    await journal.settle(attempt, zero.operationId, "completed", { resultDigest: "zero", result: { output: "zero" }, usage: { kind: "measured" as const, inputTokens: 1, outputTokens: 0, computeMs: 2, costMicros: "3" }, workspaceCheckpoint: { artifactId: "cursor-checkpoint-0", digest: `sha256:${"c".repeat(64)}`, encodedBytes: 2, journalCursor: 0 } });
    await journal.settle(attempt, zero.operationId, "completed", { resultDigest: "zero", result: { output: "zero" }, usage: { kind: "measured" as const, inputTokens: 1, outputTokens: 0, computeMs: 2, costMicros: "3" }, workspaceCheckpoint: { artifactId: "cursor-checkpoint-0", digest: `sha256:${"c".repeat(64)}`, encodedBytes: 2, journalCursor: 0 } });
    await expect(journal.settle(attempt, zero.operationId, "completed", { resultDigest: "changed", result: { output: "zero" }, usage: { kind: "measured" as const, inputTokens: 1, outputTokens: 0, computeMs: 2, costMicros: "3" }, workspaceCheckpoint: { artifactId: "cursor-checkpoint-0", digest: `sha256:${"c".repeat(64)}`, encodedBytes: 2, journalCursor: 0 } })).rejects.toThrow("cannot settle");
    expect(await journal.status(attempt)).toMatchObject({ journalCursor: 1 });
  });

  test("project revocation serializes cancellation and effect claims before installation and run locks", async () => {
    const attempt = admission(authority({ attemptId: "project-lock-attempt", candidateGeneration: 2 }));
    await journal.admit(attempt);
    const pending = operationFor(attempt, 0);
    await journal.prepare(attempt, pending);
    let releaseProject!: () => void;
    let signalProjectLocked!: () => void;
    const projectLocked = new Promise<void>((resolve) => { signalProjectLocked = resolve; });
    const release = new Promise<void>((resolve) => { releaseProject = resolve; });
    const revoke = client.begin(async transaction => {
      await transaction.unsafe("SELECT project_id FROM factory_projects WHERE tenant_id = 'execution-tenant' AND project_id = 'execution-project' FOR UPDATE");
      signalProjectLocked();
      await release;
    });
    await projectLocked;
    let cancelFinished = false;
    let effectFinished = false;
    const cancellation = journal.cancel(attempt).finally(() => { cancelFinished = true; });
    const effect = journal.dispatch(attempt, pending.operationId).finally(() => { effectFinished = true; });
    await Bun.sleep(50);
    expect(cancelFinished).toBe(false);
    expect(effectFinished).toBe(false);
    releaseProject();
    await revoke;
    await expect(cancellation).resolves.toBe(true);
    const effectOutcome = await Promise.allSettled([effect]);
    const [outcome] = effectOutcome;
    if (!outcome) throw new Error("Factory effect did not settle after project revocation released.");
    if (outcome.status === "fulfilled") expect(outcome.value).toEqual({ claimed: true });
    else expect((outcome.reason as Error).message).toContain("stale, cancelled, or expired");
  });
  /**
   * The device-exclusivity fence under genuine concurrency.
   *
   * PGlite has one connection, so two `claimStart` calls there serialize in the
   * driver and prove nothing about the fence. This pool has four, so the two
   * transactions really do overlap, and the host-scoped advisory lock is what
   * decides between them rather than the order they happened to arrive in.
   */
  test("two simultaneous claims for the same device on one host settle with exactly one winner", async () => {
    const lease: FactoryAttemptLease = { reservationId: "device-race-reservation", grantRevision: 1, allocationGeneration: 1, holderGeneration: 1, allocationToken: "device-race-allocation", hostId: "device-race-host" };
    const devices: FactoryAttemptDeviceAuthorization = { gpuHosts: 1, devices: ["/dev/kfd", "/dev/dri/renderD128"] };
    const store = new FactoryDatabaseAttemptLaunchStore(db as never);
    const attempts = ["device-race-a", "device-race-b"];
    for (const attemptId of attempts) {
      const attempt = admission(authority({ attemptId, nodeInstanceId: `node-${attemptId}` }));
      await journal.admit(attempt);
      await store.prepare(attempt.request, lease, factoryLaunchPackage(attempt.request), devices);
    }

    // Every launch column must be a real JSONB object. Bun's SQL driver types a
    // string parameter as json, so `${text}::jsonb` is a no-op cast that stores
    // a JSON string scalar instead: `->'devices'` then reads NULL server-side
    // and the fence below silently matches nothing. PGlite hides this entirely.
    const shapes = releaseRows<{ request: string; receipt: string; grant: string; devices: unknown }>(await db.execute(sql`
      SELECT jsonb_typeof(request_json) AS request, jsonb_typeof(package_receipt_json) AS receipt,
             jsonb_typeof(device_grant_json) AS grant, device_grant_json->'devices' AS devices
        FROM factory_attempt_launches WHERE host_id=${lease.hostId}`));
    expect(shapes).toHaveLength(2);
    for (const shape of shapes) {
      expect([shape.request, shape.receipt, shape.grant]).toEqual(["object", "object", "object"]);
      expect(shape.devices).not.toBeNull();
    }

    const settled = await Promise.all(attempts.map(attemptId => store.claimStart(attemptId).then(
      claim => ({ attemptId, claimed: claim.claimed, code: undefined as string | undefined }),
      (error: unknown) => ({ attemptId, claimed: false, code: (error as { code?: string }).code }),
    )));
    const winners = settled.filter(entry => entry.claimed);
    const losers = settled.filter(entry => !entry.claimed);
    expect(winners).toHaveLength(1);
    expect(losers.map(entry => entry.code)).toEqual(["device_conflict"]);

    // The durable rows agree with the decision: one launching, one still prepared.
    const states = releaseRows<{ attempt_id: string; state: string }>(await db.execute(sql`SELECT attempt_id,state FROM factory_attempt_launches WHERE host_id=${lease.hostId} ORDER BY attempt_id`));
    expect(states.map(row => row.state).sort()).toEqual(["launching", "prepared"]);
    expect(states.find(row => row.state === "launching")?.attempt_id).toBe(winners[0]!.attemptId);

    // The loser is not poisoned: once the winner is terminal, it claims.
    await store.state(winners[0]!.attemptId, "terminal");
    expect((await store.claimStart(losers[0]!.attemptId)).claimed).toBe(true);
  });
});
