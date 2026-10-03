import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@ezcorp/extension-contract";
import type { FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import { factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";
import { PodmanRunner, RunnerClient, buildLimits, executionLimits, filesDigest } from "@ezcorp/extension-runner";
import { provision, source } from "../../../packages/@ezcorp/extension-runner/tests/helpers";
import { startRunnerService } from "../../../packages/@ezcorp/extension-runner/src/service";
import * as schema from "../../db/schema";
import { migrate } from "../../db/migrate";
import { FactoryExecutionJournal, type FactoryAttemptAuthority } from "../executions";
import { FactoryRunnerSupervisor } from "./supervisor";

function serviceCall(socketPath: string, token: string, path: string, data: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const outgoing = httpRequest({ socketPath, path, method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on("data", chunk => { chunks.push(Buffer.from(chunk)); });
      incoming.on("error", reject);
      incoming.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (error) { reject(error); }
      });
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

function runnerRequest(attempt: FactoryAttemptAuthority): FactoryRunnerRequest {
  return { schemaVersion: "factory.runner.request.v1", authority: { attemptId: attempt.attemptId, tenantId: attempt.tenantId, projectId: attempt.projectId, runId: attempt.runId, nodeInstanceId: attempt.nodeInstanceId, candidateGeneration: attempt.candidateGeneration, attemptNumber: attempt.attemptNumber, grantRevision: attempt.grantRevision, reservationGeneration: attempt.reservationGeneration, executionEpoch: attempt.executionEpoch, cancellationEpoch: attempt.cancellationEpoch, deadlineAtMs: attempt.deadlineAt.getTime(), nextOperationIndex: 0 }, runner: { package: "runner", manifestName: "runner", version: "1", digest: `sha256:${"a".repeat(64)}`, export: "run" }, input: { kind: "inline", value: {} }, grants: [], resources: {}, tools: [], broker: { attemptToken: "ephemeral-podman-token", audience: "gateway" } };
}

function admission(attempt: FactoryAttemptAuthority) {
  const request = runnerRequest(attempt);
  return { ...attempt, requestDigest: factoryRunnerRequestDigest(request), request };
}

test("real rootless Podman Bun tool crosses the factory journal and checkpoint boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-supervisor-podman-"));
  const database = new PGlite({ extensions: { vector, pg_trgm } });
  const runner = new PodmanRunner({ root, ...await provision() });
  try {
    await database.waitReady;
    const db = drizzle(database, { schema });
    await migrate(db);
    await db.execute(sql`INSERT INTO projects(id, name, path) VALUES ('project-a', 'Project A', '/tmp/project-a')`);
    await db.execute(sql`INSERT INTO factory_installation(singleton, tenant_id, execution_epoch) VALUES (1, 'tenant-a', 6)`);
    await db.execute(sql`INSERT INTO factory_projects(tenant_id, project_id) VALUES ('tenant-a', 'project-a')`);
    await db.execute(sql`INSERT INTO factory_runs(tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload) VALUES ('tenant-a', 'project-a', 'run-a', ${`sha256:${"a".repeat(64)}`}, 'test', 6, 'request', '{}')`);
    const files = source("async(input,ctx)=>({stored:await ctx.call('factory.tool',input)})");
    const build = await runner.build({ operationId: crypto.randomUUID(), sourceDigest: filesDigest(files), files, entrypoint: "extension.ts", limits: buildLimits });
    expect(build.diagnostics).toEqual([]);
    const authority = admission({ attemptId: "attempt-1", tenantId: "tenant-a", projectId: "project-a", runId: "run-a", nodeInstanceId: "node-a", candidateGeneration: 2, attemptNumber: 3, grantRevision: 4, reservationGeneration: 5, executionEpoch: 6, cancellationEpoch: 0, requestDigest: "a".repeat(64), deadlineAt: new Date(Date.now() + 60_000) });
    const request = { authority, artifactDigest: build.artifactDigest!, operationIndex: 0, toolName: "echo", toolInput: { text: "workspace bytes" } as JsonValue, workspace: { checkpoint: async ({ operationIndex }: { operationIndex: number }) => ({ artifactId: "checkpoint-workspace", digest: `sha256:${"c".repeat(64)}`, encodedBytes: 96, journalCursor: operationIndex }) } };
    const journal = new FactoryExecutionJournal(db, async () => {});
    await journal.admit(authority);
    const supervisor = new FactoryRunnerSupervisor({ runner, journal, authorizeAttempt: async () => {}, invokeTool: async input => ({ persisted: input }) });
    const outcome = await supervisor.invoke(request);
    expect(outcome).toEqual({ claimed: true, result: { stored: { persisted: { text: "workspace bytes" } } } });
    expect(await new FactoryExecutionJournal(db, async () => {}).status(authority)).toMatchObject({ status: "running", journalCursor: 0 });
    await runner.close();
    const restarted = new PodmanRunner({ root, ...await provision() });
    try {
      const recovered = new FactoryRunnerSupervisor({ runner: restarted, journal: new FactoryExecutionJournal(db, async () => {}), authorizeAttempt: async () => {}, invokeTool: async () => { throw new Error("recovery must not repeat the tool effect"); } });
      expect(await recovered.invoke(request)).toEqual({ claimed: false, result: { stored: { persisted: { text: "workspace bytes" } } } });
      expect(await new FactoryExecutionJournal(db, async () => {}).status(authority)).toMatchObject({ journalCursor: 0 });
    } finally { await restarted.close(); }
  } finally {
    await runner.close();
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);

test("a fresh factory supervisor attaches through the v4 service to a surviving real Podman worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-supervisor-attach-"));
  const database = new PGlite({ extensions: { vector, pg_trgm } });
  const runner = new PodmanRunner({ root, ...await provision() });
  const token = "test-service-credential-32-bytes-minimum";
  const socketPath = join(root, "runner.sock");
  let service: Awaited<ReturnType<typeof startRunnerService>> | undefined;
  try {
    await database.waitReady;
    const db = drizzle(database, { schema });
    await migrate(db);
    await db.execute(sql`INSERT INTO projects(id, name, path) VALUES ('project-a', 'Project A', '/tmp/project-a')`);
    await db.execute(sql`INSERT INTO factory_installation(singleton, tenant_id, execution_epoch) VALUES (1, 'tenant-a', 6)`);
    await db.execute(sql`INSERT INTO factory_projects(tenant_id, project_id) VALUES ('tenant-a', 'project-a')`);
    await db.execute(sql`INSERT INTO factory_runs(tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload) VALUES ('tenant-a', 'project-a', 'run-a', ${`sha256:${"a".repeat(64)}`}, 'test', 6, 'request', '{}')`);
    const files = source("async(input,ctx)=>({stored:await ctx.call('factory.tool',input)})");
    const build = await runner.build({ operationId: crypto.randomUUID(), sourceDigest: filesDigest(files), files, entrypoint: "extension.ts", limits: buildLimits });
    const authority = admission({ attemptId: "attempt-live", tenantId: "tenant-a", projectId: "project-a", runId: "run-a", nodeInstanceId: "node-a", candidateGeneration: 2, attemptNumber: 3, grantRevision: 4, reservationGeneration: 5, executionEpoch: 6, cancellationEpoch: 0, requestDigest: "a".repeat(64), deadlineAt: new Date(Date.now() + 60_000) });
    const workerId = `factory_${createHash("sha256").update(`${authority.attemptId}:0`).digest("hex").slice(0, 48)}`;
    const invocationId = `factory_${createHash("sha256").update(`${authority.attemptId}:0:invocation`).digest("hex").slice(0, 48)}`;
    const context = { workerId, invocationId, releaseId: build.artifactDigest!, principalId: authority.tenantId, scopeId: authority.projectId, token: `factory-runner:${authority.attemptId}`, deadline: authority.deadlineAt.getTime() };
    service = await startRunnerService({ runner, socketPath, token, allowedUid: process.getuid!() });
    await serviceCall(socketPath, token, "/v4/start", { workerId, artifactDigest: build.artifactDigest!, context, limits: executionLimits });
    const journal = new FactoryExecutionJournal(db, async () => {});
    await journal.admit(authority);
    const supervisor = new FactoryRunnerSupervisor({ runner: new RunnerClient({ socketPath, token }), journal, authorizeAttempt: async () => {}, invokeTool: async input => ({ persisted: input }) });
    expect(await supervisor.invoke({ authority, artifactDigest: build.artifactDigest!, operationIndex: 0, toolName: "echo", toolInput: { text: "survived" }, workspace: { checkpoint: async ({ operationIndex }) => ({ artifactId: "checkpoint-survived", digest: `sha256:${"d".repeat(64)}`, encodedBytes: 96, journalCursor: operationIndex }) } })).toEqual({ claimed: true, result: { stored: { persisted: { text: "survived" } } } });
  } finally {
    await service?.close();
    await runner.close();
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
