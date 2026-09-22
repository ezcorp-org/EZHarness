/**
 * The legacy engine adapter, driven against a real `workflow_runs` table.
 *
 * `facts` is a mapping from four columns and a join onto a factory-side
 * record, and every mapping bug in it is a bug that reads as a legitimate
 * outcome: a `Date` where epoch milliseconds belong makes every lease look
 * unexpired, and a missing `result` read as `null` output makes a run that
 * produced nothing look like one that produced nothing on purpose. So the
 * rows here are real rows, written through the real schema.
 *
 * `start` is driven against a fake engine rather than a real
 * `WorkflowExecutor`, because what this adapter adds to the engine is
 * exactly one thing — it returns at the durable-row boundary instead of at
 * the end of the run — and a real executor would make that property the
 * hardest thing in the test to see.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";
import type { WorkflowDefinition, WorkflowRun } from "../types";

let pglite: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

mock.module("../db/connection", () => ({
  getDb: () => db,
  getPglite: () => pglite,
  getDbPath: () => ":memory:",
  initDb: async () => {},
  closeDb: async () => {},
  rawQuery: async (statement: string, params: (string | null)[] = []) => pglite.query(statement, params),
}));

const { FactoryLegacyEngineError, createFactoryLegacyEngine } = await import("./legacy-engine");

const definition: WorkflowDefinition = { name: "publish", steps: [{ name: "one", kind: "transform", expression: "$input" }] } as unknown as WorkflowDefinition;
const resolve = async (name: string) => (name === "publish" ? definition : undefined);

beforeAll(async () => {
  pglite = new PGlite({ extensions: { vector, pg_trgm } });
  await pglite.waitReady;
  db = drizzle(pglite, { schema });
  await migrate(db as never);
});
afterAll(async () => { await pglite.close(); });

interface RunRow {
  readonly id: string;
  readonly status: string;
  readonly result?: unknown;
  readonly cursor?: unknown;
  readonly runPhase?: string;
  readonly suspendedReason?: string | null;
  readonly resumable?: boolean;
  readonly leaseExpiresAt?: Date | null;
  readonly idempotencyKey?: string | null;
}

async function insertRun(row: RunRow): Promise<string> {
  await db.execute(sql`
    INSERT INTO workflow_runs(id, workflow_name, status, started_at, result, cursor, run_phase, suspended_reason, resumable, lease_expires_at, idempotency_key)
    VALUES (${row.id}, 'publish', ${row.status}, NOW(), ${row.result === undefined ? null : JSON.stringify(row.result)}::jsonb,
            ${row.cursor === undefined ? null : JSON.stringify(row.cursor)}::jsonb, ${row.runPhase ?? "boundary"}, ${row.suspendedReason ?? null},
            ${row.resumable ?? false}, ${row.leaseExpiresAt ?? null}, ${row.idempotencyKey ?? null})`);
  return row.id;
}

async function insertStep(runId: string, stepName: string, status: string): Promise<void> {
  await db.execute(sql`INSERT INTO workflow_step_runs(id, workflow_run_id, step_name, status) VALUES (${`${runId}:${stepName}`}, ${runId}, ${stepName}, ${status})`);
}

/** An engine whose one method the test drives directly. */
function engineThat(behaviour: (created: (run: WorkflowRun) => void) => Promise<WorkflowRun>) {
  const calls: { idempotencyKey?: string; projectId?: string; userId?: string; input: Record<string, unknown> }[] = [];
  return {
    calls,
    executor: {
      async runWorkflow(workflow: WorkflowDefinition, input: Record<string, unknown>, projectId?: string, userId?: string, _signal?: AbortSignal, options?: { idempotencyKey?: string; onRunCreated?: (run: WorkflowRun) => void }) {
        expect(workflow).toBe(definition);
        calls.push({ idempotencyKey: options?.idempotencyKey, projectId, userId, input });
        return behaviour(run => options?.onRunCreated?.(run));
      },
    },
  };
}

const startRequest = { workflowName: "publish", idempotencyKey: "factory:project-a:run-a:node-a:1:attempt-a", input: { topic: "release" }, projectId: "project-a", userId: "user-a" };

function runHandle(id: string, status: WorkflowRun["status"] = "running"): WorkflowRun {
  return { id, workflowName: "publish", status, startedAt: 1, steps: [] };
}

describe("start", () => {
  test("returns at the durable-row boundary, not at the end of the run", async () => {
    let endRun: (run: WorkflowRun) => void = () => undefined;
    const ended = new Promise<WorkflowRun>(settle => { endRun = settle; });
    const engine = engineThat(async created => { created(runHandle("run-1")); return ended; });
    const started = await createFactoryLegacyEngine({ executor: engine.executor, resolve }).start(startRequest);
    // The engine has not returned and will not for a while; the adapter
    // already knows the run's identity, which is the whole point.
    expect(started).toEqual({ legacyRunId: "run-1" });
    expect(engine.calls).toEqual([{ idempotencyKey: startRequest.idempotencyKey, projectId: "project-a", userId: "user-a", input: { topic: "release" } }]);
    endRun(runHandle("run-1", "success"));
    await ended;
  });

  test("refuses a workflow name this installation cannot resolve", async () => {
    const engine = engineThat(async () => runHandle("never"));
    await expect(createFactoryLegacyEngine({ executor: engine.executor, resolve }).start({ ...startRequest, workflowName: "absent" }))
      .rejects.toMatchObject({ code: "factory_legacy_engine_unknown_workflow" });
    // Refused before the engine was asked to do anything.
    expect(engine.calls).toEqual([]);
  });

  test("refuses to name a run whose durable record was never confirmed", async () => {
    // `runWorkflow`'s refusal paths return a `WorkflowRun` whose row was not
    // written. Reading an id off one would journal a legacy run id that names
    // nothing, and every later `facts` call would read it as deleted.
    const engine = engineThat(async () => runHandle("unwritten", "error"));
    const failure = await createFactoryLegacyEngine({ executor: engine.executor, resolve }).start(startRequest).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FactoryLegacyEngineError);
    expect(failure).toMatchObject({ code: "factory_legacy_engine_unconfirmed" });
  });

  test("passes the engine's own refusal through when nothing was confirmed", async () => {
    const raised = new Error("workflow release authority is no longer available");
    const engine = engineThat(async () => { throw raised; });
    await expect(createFactoryLegacyEngine({ executor: engine.executor, resolve }).start(startRequest)).rejects.toBe(raised);
  });

  test("a run that fails after its row is confirmed still starts, and raises nothing loose", async () => {
    const engine = engineThat(async created => { created(runHandle("run-2")); throw new Error("the run failed later"); });
    expect(await createFactoryLegacyEngine({ executor: engine.executor, resolve }).start(startRequest)).toEqual({ legacyRunId: "run-2" });
    // The rejection belongs to the polled run, not to `start`. If the adapter
    // left it unhandled this process would be reporting an unhandled rejection
    // by now; a settled microtask queue is the assertion.
    await new Promise(settle => setTimeout(settle, 0));
  });
});

describe("lookup", () => {
  test("finds a run by its key without being able to create one", async () => {
    await insertRun({ id: "run-keyed", status: "running", idempotencyKey: "factory:project-a:run-a:node-a:1:attempt-keyed" });
    const engine = createFactoryLegacyEngine({ executor: engineThat(async () => runHandle("x")).executor, resolve });
    expect(await engine.lookup("publish", "factory:project-a:run-a:node-a:1:attempt-keyed")).toEqual({ legacyRunId: "run-keyed" });
    const before = await db.execute(sql`SELECT COUNT(*)::int AS n FROM workflow_runs`);
    expect(await engine.lookup("publish", "factory:project-a:run-a:node-a:1:attempt-missing")).toBeNull();
    const after = await db.execute(sql`SELECT COUNT(*)::int AS n FROM workflow_runs`);
    // A lookup that missed created nothing, which is the property the crash
    // path depends on.
    expect(after).toEqual(before);
  });
});

describe("facts", () => {
  const engine = () => createFactoryLegacyEngine({ executor: engineThat(async () => runHandle("x")).executor, resolve });

  test("a run that is not there is absent rather than empty", async () => {
    expect(await engine().facts("run-absent", 10)).toBeNull();
  });

  test("a running run carries its lease as epoch milliseconds and its steps in a stable order", async () => {
    const lease = new Date(1_700_000_000_000);
    await insertRun({ id: "run-live", status: "running", runPhase: "step", leaseExpiresAt: lease, cursor: { batchIndex: 3, completedSteps: ["one"] } });
    await insertStep("run-live", "zebra", "running");
    await insertStep("run-live", "alpha", "running");
    await insertStep("run-live", "done", "success");
    expect(await engine().facts("run-live", 99)).toEqual({
      status: "running", runPhase: "step", suspendedReason: null, resumable: false,
      leaseExpiresAtMs: 1_700_000_000_000, cursorBatchIndex: 3,
      inFlightStepNames: ["alpha", "zebra"],
      resultErrorCode: null, resultErrorMessage: null, resultOutput: undefined,
      observedAtMs: 99,
    });
  });

  test("a structured error keeps its code, and a bare one is only a message", async () => {
    await insertRun({ id: "run-coded", status: "error", result: { success: false, output: null, error: { code: "not-resumable", message: "the release is gone" } } });
    expect(await engine().facts("run-coded", 1)).toMatchObject({ resultErrorCode: "not-resumable", resultErrorMessage: "the release is gone", resultOutput: null });
    await insertRun({ id: "run-bare", status: "error", result: { success: false, output: null, error: "it threw" } });
    expect(await engine().facts("run-bare", 1)).toMatchObject({ resultErrorCode: null, resultErrorMessage: "it threw" });
  });

  test("a suspended run carries the reason and the resumable flag the sweep wrote", async () => {
    await insertRun({ id: "run-parked", status: "suspended", suspendedReason: "orphaned-resumable", resumable: true });
    expect(await engine().facts("run-parked", 1)).toMatchObject({ status: "suspended", suspendedReason: "orphaned-resumable", resumable: true, cursorBatchIndex: null, leaseExpiresAtMs: null, inFlightStepNames: [] });
  });

  test("a success carries its output, and a cursor without a batch index is no batch index", async () => {
    await insertRun({ id: "run-done", status: "success", result: { success: true, output: { released: true } }, cursor: { completedSteps: ["one"] } });
    expect(await engine().facts("run-done", 1)).toMatchObject({ status: "success", resultOutput: { released: true }, cursorBatchIndex: null, resultErrorCode: null, resultErrorMessage: null });
  });
});
