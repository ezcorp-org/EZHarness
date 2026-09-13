import { afterEach, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { canonicalJson } from "@ezcorp/extension-contract";
import type { Runner, RunnerExecution, StartRequest } from "@ezcorp/extension-contract";
import * as schema from "../../db/schema";
import { migrate } from "../../db/migrate";
import { FactoryExecutionJournal, type FactoryAttemptAuthority } from "../executions";
import { FactoryRunnerSupervisor } from "./supervisor";

const databases: PGlite[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map(database => database.close())); });

function authority(): FactoryAttemptAuthority {
  return { attemptId: "attempt-1", tenantId: "tenant-a", projectId: "project-a", runId: "run-a", nodeInstanceId: "node-a", candidateGeneration: 2, attemptNumber: 3, grantRevision: 4, reservationGeneration: 5, executionEpoch: 6, deadlineAt: new Date(Date.now() + 60_000) };
}

test("supervisor journals before a v4 runner tool effect and checkpoints before acknowledging", async () => {
  const database = new PGlite({ extensions: { vector, pg_trgm } });
  databases.push(database);
  await database.waitReady;
  const db = drizzle(database, { schema });
  await migrate(db);
  await db.execute(sql`INSERT INTO projects(id, name, path) VALUES ('project-a', 'Project A', '/tmp/project-a')`);
  await db.execute(sql`INSERT INTO factory_installation(singleton, tenant_id, execution_epoch) VALUES (1, 'tenant-a', 6)`);
  await db.execute(sql`INSERT INTO factory_projects(tenant_id, project_id) VALUES ('tenant-a', 'project-a')`);
  await db.execute(sql`INSERT INTO factory_runs(tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload) VALUES ('tenant-a', 'project-a', 'run-a', ${`sha256:${"a".repeat(64)}`}, 'test', 6, 'request', '{}')`);
  const order: string[] = [];
  let starts = 0;
  const runner: Runner = {
    build: async () => { throw new Error("build is external to the supervisor"); }, cancel: async () => {}, inspect: async () => ({ id: "unused", state: "unknown", diagnostics: [] }), collectArtifacts: async () => ({}),
    start: async (input: StartRequest, reverse): Promise<RunnerExecution> => {
      starts++;
      return {
        workerId: input.workerId,
        onNotification: () => () => {},
        close: async () => { order.push("close"); },
        request: async (method, params) => {
          expect(method).toBe("extension/invoke");
          expect(params).toMatchObject({ context: input.context });
          order.push("runner");
          if ((params as { name: string }).name === "reject") return reverse("host.denied", { context: input.context, input: {} });
          const effect = await reverse("factory.tool", { context: input.context, input: { bytes: "new workspace" } });
          return { effect };
        },
      };
    },
  };
  const journal = new FactoryExecutionJournal(db, async () => {});
  const supervisor = new FactoryRunnerSupervisor({ runner, journal, authorizeAttempt: async () => { order.push("authorize"); }, invokeTool: async value => { order.push("effect"); return { stored: value }; } });
  const request = { authority: authority(), artifactDigest: "a".repeat(64), operationIndex: 0, toolName: "write", toolInput: { path: "output.txt" }, workspace: { checkpoint: async () => { order.push("checkpoint"); return { revision: "snapshot-1" }; } } } as const;
  expect(await supervisor.invoke(request)).toEqual({ claimed: true, result: { effect: { stored: { bytes: "new workspace" } } } });
  expect(order).toEqual(["authorize", "runner", "authorize", "effect", "checkpoint", "close"]);
  expect(await new FactoryExecutionJournal(db, async () => {}).status(request.authority)).toMatchObject({ status: "running", journalCursor: 0 });
  expect(await supervisor.invoke(request)).toEqual({ claimed: false, result: { effect: { stored: { bytes: "new workspace" } } } });
  expect(starts).toBe(1);
  const uncertainAuthority = { ...request.authority, attemptId: "attempt-uncertain", attemptNumber: 4 };
  const requestDigest = createHash("sha256").update(canonicalJson({ artifactDigest: request.artifactDigest, toolName: request.toolName, toolInput: request.toolInput })).digest("hex");
  const uncertainOperation = { operationId: "run-a:node-a:2:1", operationIndex: 1, kind: "tool" as const, requestDigest };
  await journal.admit({ ...uncertainAuthority, request: { artifactDigest: request.artifactDigest, toolName: request.toolName, toolInput: request.toolInput } });
  await journal.prepare(uncertainAuthority, uncertainOperation);
  await journal.dispatch(uncertainAuthority, uncertainOperation.operationId);
  await expect(supervisor.invoke({ ...request, authority: uncertainAuthority, operationIndex: 1 })).rejects.toThrow("outcome is uncertain");
  expect(starts).toBe(1);
  const stoppedAuthority = { ...request.authority, attemptId: "attempt-stopped", attemptNumber: 5 };
  await journal.admit({ ...stoppedAuthority, request: { artifactDigest: request.artifactDigest, toolName: request.toolName, toolInput: request.toolInput } });
  await journal.prepare(stoppedAuthority, { operationId: "run-a:node-a:2:2", operationIndex: 2, kind: "tool", requestDigest });
  expect(await journal.cancel(stoppedAuthority)).toBe(true);
  expect(await journal.confirmStopped(stoppedAuthority)).toBe(true);
  await expect(supervisor.invoke({ ...request, authority: stoppedAuthority, operationIndex: 2 })).rejects.toThrow("stale, cancelled, or expired");
  expect(starts).toBe(1);
  await expect(supervisor.invoke({ ...request, authority: { ...request.authority, attemptId: "attempt-2", attemptNumber: 6 }, operationIndex: 3, toolName: "reject" })).rejects.toThrow("capability is denied");
  await supervisor.stop("unknown-attempt");

  let recoveryStarts = 0;
  let recoveryAttaches = 0;
  const recoveredRunner: Runner = {
    build: async () => { throw new Error("build is external to recovery"); }, cancel: async () => {}, collectArtifacts: async () => ({}),
    inspect: async id => ({ id, state: "running", diagnostics: [] }),
    start: async () => { recoveryStarts++; throw new Error("recovery must attach a surviving worker"); },
    attach: async (input, reverse) => {
      recoveryAttaches++;
      return { workerId: input.workerId, close: async () => {}, onNotification: () => () => {}, request: async () => ({ recovered: await reverse("factory.tool", { context: input.context, input: { bytes: "survived" } }) }) };
    },
  };
  const recovered = new FactoryRunnerSupervisor({ runner: recoveredRunner, journal, authorizeAttempt: async () => {}, invokeTool: async value => ({ persisted: value }) });
  expect(await recovered.invoke({ ...request, authority: { ...request.authority, attemptId: "attempt-recovered", attemptNumber: 7 }, operationIndex: 4 })).toEqual({ claimed: true, result: { recovered: { persisted: { bytes: "survived" } } } });
  expect({ recoveryStarts, recoveryAttaches }).toEqual({ recoveryStarts: 0, recoveryAttaches: 1 });
});
