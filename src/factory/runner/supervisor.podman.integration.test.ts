import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@ezcorp/extension-contract";
import { PodmanRunner, buildLimits, filesDigest } from "@ezcorp/extension-runner";
import { provision, source } from "../../../packages/@ezcorp/extension-runner/tests/helpers";
import * as schema from "../../db/schema";
import { migrate } from "../../db/migrate";
import { FactoryExecutionJournal } from "../executions";
import { FactoryRunnerSupervisor } from "./supervisor";

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
    const authority = { attemptId: "attempt-1", tenantId: "tenant-a", projectId: "project-a", runId: "run-a", nodeInstanceId: "node-a", candidateGeneration: 2, attemptNumber: 3, grantRevision: 4, reservationGeneration: 5, executionEpoch: 6, deadlineAt: new Date(Date.now() + 60_000) };
    const request = { authority, artifactDigest: build.artifactDigest!, operationIndex: 0, toolName: "echo", toolInput: { text: "workspace bytes" } as JsonValue, workspace: { checkpoint: async ({ result }: { result: JsonValue }) => ({ revision: "checkpoint-1", result }) } };
    const supervisor = new FactoryRunnerSupervisor({ runner, journal: new FactoryExecutionJournal(db, async () => {}), authorizeAttempt: async () => {}, invokeTool: async input => ({ persisted: input }) });
    const outcome = await supervisor.invoke(request);
    expect(outcome).toEqual({ claimed: true, result: { stored: { persisted: { text: "workspace bytes" } } } });
    expect(await new FactoryExecutionJournal(db, async () => {}).status(authority)).toMatchObject({ status: "running", journalCursor: 0 });
    await runner.close();
    const restarted = new PodmanRunner({ root, ...await provision() });
    try {
      const recovered = new FactoryRunnerSupervisor({ runner: restarted, journal: new FactoryExecutionJournal(db, async () => {}), authorizeAttempt: async () => {}, invokeTool: async () => { throw new Error("recovery must not repeat the tool effect"); } });
      expect(await recovered.invoke(request)).toEqual({ claimed: false });
      expect(await new FactoryExecutionJournal(db, async () => {}).status(authority)).toMatchObject({ journalCursor: 0 });
    } finally { await restarted.close(); }
  } finally {
    await runner.close();
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
