/**
 * Workflow run history: the `workflow_runs` / `workflow_step_runs` tables,
 * their query layer, and the executor writing through to them.
 *
 * Runs against a real PGlite instance driven by the real `migrate()`, so
 * the schema.ts ⇄ migrate.ts lockstep (column names, nullability, FKs,
 * the upsert arbiter index) is verified rather than assumed.
 */
import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { migrate } from "../db/migrate";
import { EventBus } from "../runtime/events";
import { AgentExecutor } from "../runtime/executor";
import { loadAgentsStatic } from "../runtime/loader";
import { createExtensionPermissionGate } from "../runtime/tools/permissions";
import type { AgentEvents, WorkflowDefinition } from "../types";
import type { ToolCallResult } from "../extensions/types";

let pglite: PGlite;
let db: ReturnType<typeof drizzle<typeof schema>>;

mock.module("../db/connection", () => ({
  getDb: () => db,
  getPglite: () => pglite,
  getDbPath: () => ":memory:",
  initDb: async () => {},
  closeDb: async () => {},
  rawQuery: async (s: string, params: (string | null)[] = []) => pglite.query(s, params),
}));

const {
  finalizeWorkflowRunRow,
  getWorkflowRunRow,
  insertWorkflowRun,
  listWorkflowStepRunRows,
  terminalizeOrphanedWorkflowRuns,
  upsertWorkflowStepRun,
} = await import("../db/queries/workflow-runs");
const { WorkflowExecutor } = await import("../runtime/workflow-executor");

beforeAll(async () => {
  pglite = new PGlite({ extensions: { vector, pg_trgm } });
  await pglite.waitReady;
  db = drizzle(pglite, { schema });
  await migrate(db);
  // `workflow_runs.user_id` is a real FK — an attributed run needs a real
  // user row (which is exactly the point of the FK).
  await db.execute(sql`
    INSERT INTO users (id, email, password_hash, name)
    VALUES ('user-1', 'u1@example.test', 'x', 'User One')
  `);
});

afterAll(async () => {
  await pglite?.close().catch(() => {});
});

function ok(text: string): ToolCallResult {
  return { content: [{ type: "text", text }], isError: false };
}

function makeExecutor(opts: {
  toolHandler?: (conversationId: string) => Promise<ToolCallResult> | ToolCallResult;
}) {
  const bus = new EventBus<AgentEvents>();
  const agentExec = new AgentExecutor(loadAgentsStatic([]), bus);
  const handler = opts.toolHandler ?? (() => ok("tool-output"));
  return new WorkflowExecutor(agentExec, bus, {
    persist: true,
    toolRunnerFactory: () => ({
      setCurrentUserId() {},
      async executeToolCall(_t, _i, conversationId) {
        return handler(conversationId);
      },
    }),
  });
}

describe("migrate() — workflow run history tables", () => {
  test("creates both tables with the documented nullability", async () => {
    const cols = (await db.execute(sql`
      SELECT table_name, column_name, is_nullable FROM information_schema.columns
       WHERE table_name IN ('workflow_runs', 'workflow_step_runs')
    `)) as { rows: Array<{ table_name: string; column_name: string; is_nullable: string }> };
    const key = (t: string, c: string) =>
      cols.rows.find((r) => r.table_name === t && r.column_name === c)?.is_nullable;

    // YAML workflows have no definitions row → the FK must be nullable.
    expect(key("workflow_runs", "workflow_definition_id")).toBe("YES");
    expect(key("workflow_runs", "user_id")).toBe("YES");
    expect(key("workflow_runs", "project_id")).toBe("YES");
    expect(key("workflow_runs", "workflow_name")).toBe("NO");
    expect(key("workflow_runs", "status")).toBe("NO");
    // transform / gate / tool steps mint no AgentRun.
    expect(key("workflow_step_runs", "run_id")).toBe("YES");
    expect(key("workflow_step_runs", "workflow_run_id")).toBe("NO");
  });

  test("is idempotent — a second migrate() pass is a no-op", async () => {
    await migrate(db);
    const rows = (await db.execute(
      sql`SELECT to_regclass('public.workflow_runs') AS t, to_regclass('public.workflow_step_runs') AS s`,
    )) as { rows: Array<{ t: string | null; s: string | null }> };
    expect(rows.rows[0]?.t).toBeTruthy();
    expect(rows.rows[0]?.s).toBeTruthy();
  });

  test("creates the (workflow_run_id, step_name) upsert arbiter index", async () => {
    const rows = (await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'workflow_step_runs'
    `)) as { rows: Array<{ indexname: string }> };
    expect(rows.rows.map((r) => r.indexname)).toContain("uniq_workflow_step_run");
  });
});

describe("workflow-runs query layer", () => {
  test("insertWorkflowRun uses the caller's id verbatim", async () => {
    const id = crypto.randomUUID();
    await insertWorkflowRun({
      id,
      workflowName: "yaml-flow",
      input: { a: 1 },
      startedAt: new Date(),
    });
    const row = await getWorkflowRunRow(id);
    expect(row?.id).toBe(id);
    expect(row?.status).toBe("running");
    expect(row?.workflowDefinitionId).toBeNull();
    expect(row?.userId).toBeNull();
    expect(row?.input).toEqual({ a: 1 });
    expect(row?.finishedAt).toBeNull();
  });

  test("upsertWorkflowStepRun maps the empty runId sentinel to SQL NULL", async () => {
    const id = crypto.randomUUID();
    await insertWorkflowRun({ id, workflowName: "wf", input: {}, startedAt: new Date() });
    await upsertWorkflowStepRun({
      workflowRunId: id,
      stepName: "transform-step",
      runId: "",
      status: "success",
    });
    const [row] = await listWorkflowStepRunRows(id);
    // Storing "" would violate the runs FK outright.
    expect(row?.runId).toBeNull();
    expect(row?.iterations).toBeNull();
  });

  test("upsertWorkflowStepRun updates in place on the second write", async () => {
    const id = crypto.randomUUID();
    await insertWorkflowRun({ id, workflowName: "wf", input: {}, startedAt: new Date() });
    await upsertWorkflowStepRun({
      workflowRunId: id,
      stepName: "loop-step",
      runId: "",
      status: "running",
    });
    await upsertWorkflowStepRun({
      workflowRunId: id,
      stepName: "loop-step",
      runId: "",
      status: "success",
      iterations: 3,
    });
    const rows = await listWorkflowStepRunRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("success");
    expect(rows[0]?.iterations).toBe(3);
  });

  test("finalizeWorkflowRunRow is an idempotent CAS on status='running'", async () => {
    const id = crypto.randomUUID();
    await insertWorkflowRun({ id, workflowName: "wf", input: {}, startedAt: new Date() });

    const first = await finalizeWorkflowRunRow(id, "success", {
      success: true,
      output: "yay",
    });
    expect(first).toBe(1);

    // A retry / racing boot sweep must NOT clobber the richer terminal state.
    const second = await finalizeWorkflowRunRow(id, "error", {
      success: false,
      output: null,
      error: "should not stick",
    });
    expect(second).toBe(0);

    const row = await getWorkflowRunRow(id);
    expect(row?.status).toBe("success");
    expect(row?.result).toEqual({ success: true, output: "yay" });
    expect(row?.finishedAt).not.toBeNull();
  });

  test("finalizeWorkflowRunRow with no result leaves the result column untouched", async () => {
    const id = crypto.randomUUID();
    await insertWorkflowRun({ id, workflowName: "wf", input: {}, startedAt: new Date() });
    expect(await finalizeWorkflowRunRow(id, "cancelled")).toBe(1);
    const row = await getWorkflowRunRow(id);
    expect(row?.status).toBe("cancelled");
    expect(row?.result).toBeNull();
  });

  test("finalizeWorkflowRunRow persists the awaiting_approval state", async () => {
    const id = crypto.randomUUID();
    await insertWorkflowRun({ id, workflowName: "wf", input: {}, startedAt: new Date() });
    await finalizeWorkflowRunRow(id, "awaiting_approval", {
      success: false,
      output: null,
      error: { code: "awaiting_approval", message: "needs a human" },
    });
    const row = await getWorkflowRunRow(id);
    expect(row?.status).toBe("awaiting_approval");
    // Must never read as a success.
    expect(row?.status).not.toBe("success");
  });

  test("getWorkflowRunRow returns undefined for an unknown id", async () => {
    expect(await getWorkflowRunRow(crypto.randomUUID())).toBeUndefined();
  });

  test("terminalizeOrphanedWorkflowRuns drains rows a dead process left running", async () => {
    const orphan = crypto.randomUUID();
    const healthy = crypto.randomUUID();
    await insertWorkflowRun({ id: orphan, workflowName: "wf", input: {}, startedAt: new Date() });
    await insertWorkflowRun({ id: healthy, workflowName: "wf", input: {}, startedAt: new Date() });
    await finalizeWorkflowRunRow(healthy, "success");

    const drained = await terminalizeOrphanedWorkflowRuns();
    expect(drained).toBeGreaterThanOrEqual(1);

    const row = await getWorkflowRunRow(orphan);
    expect(row?.status).toBe("error");
    expect(row?.finishedAt).not.toBeNull();
    expect(String((row?.result as { error?: unknown })?.error)).toContain("orphaned");

    // The already-terminal run is untouched, and a second sweep finds nothing.
    expect((await getWorkflowRunRow(healthy))?.status).toBe("success");
    expect(await terminalizeOrphanedWorkflowRuns()).toBe(0);
  });
});

describe("WorkflowExecutor persistence", () => {
  test("persist:false writes nothing at all", async () => {
    const bus = new EventBus<AgentEvents>();
    const agentExec = new AgentExecutor(loadAgentsStatic([]), bus);
    const wf = new WorkflowExecutor(agentExec, bus);
    const def: WorkflowDefinition = {
      name: "unpersisted",
      description: "",
      steps: [{ name: "t", kind: "transform", output: { a: "x" } }],
    };
    const run = await wf.runWorkflow(def, {});
    expect(await getWorkflowRunRow(run.id)).toBeUndefined();
  });

  test("persist:true mirrors the run and each step through to terminal state", async () => {
    const wf = makeExecutor({});
    const def: WorkflowDefinition = {
      name: "persisted-flow",
      description: "",
      steps: [
        { name: "prep", kind: "transform", output: { ready: "yes" } },
        { name: "call", kind: "tool", tool: "demo__x" },
      ],
    };

    const run = await wf.runWorkflow(def, { seed: 7 }, undefined, undefined);

    const row = await getWorkflowRunRow(run.id);
    expect(row?.status).toBe("success");
    expect(row?.workflowName).toBe("persisted-flow");
    expect(row?.input).toEqual({ seed: 7 });
    expect(row?.result).toEqual({ success: true, output: "tool-output" });
    expect(row?.finishedAt).not.toBeNull();

    const steps = await listWorkflowStepRunRows(run.id);
    expect(steps.map((s) => [s.stepName, s.status]).sort()).toEqual([
      ["call", "success"],
      ["prep", "success"],
    ]);
    // Neither kind mints an AgentRun.
    expect(steps.every((s) => s.runId === null)).toBe(true);
  });

  test("resolves workflow_definition_id for a DB-defined workflow", async () => {
    const defId = crypto.randomUUID();
    await db.insert(schema.workflowDefinitions).values({
      id: defId,
      name: "db-defined",
      description: "",
      steps: [{ name: "t", kind: "transform", output: { a: "x" } }],
    });

    const wf = makeExecutor({});
    const run = await wf.runWorkflow(
      {
        name: "db-defined",
        description: "",
        steps: [{ name: "t", kind: "transform", output: { a: "x" } }],
      },
      {},
    );

    expect((await getWorkflowRunRow(run.id))?.workflowDefinitionId).toBe(defId);
  });

  test("persists a failed run as error with its message", async () => {
    const wf = makeExecutor({});
    const def: WorkflowDefinition = {
      name: "failing",
      description: "",
      steps: [
        {
          name: "gate",
          kind: "gate",
          condition: { ref: "$input.nope", op: "truthy" },
        },
      ],
    };
    const run = await wf.runWorkflow(def, {});
    const row = await getWorkflowRunRow(run.id);
    expect(row?.status).toBe("error");
    expect(String((row?.result as { error?: unknown })?.error)).toContain('Gate "gate" failed');
    const steps = await listWorkflowStepRunRows(run.id);
    expect(steps[0]?.status).toBe("error");
  });

  test("persists an approval-blocked run as awaiting_approval, not success", async () => {
    const wf = makeExecutor({
      toolHandler: async (conversationId) => {
        await createExtensionPermissionGate({
          promptId: `p-${crypto.randomUUID()}`,
          conversationId,
          userId: "user-1",
          extensionId: "extension-author",
          toolName: "install_draft",
          capabilityKind: "fs.write",
        });
        return ok("unreachable");
      },
    });
    const def: WorkflowDefinition = {
      name: "needs-approval",
      description: "",
      steps: [{ name: "install", kind: "tool", tool: "extension-author__install_draft" }],
    };

    const run = await wf.runWorkflow(def, {}, undefined, "user-1");

    const row = await getWorkflowRunRow(run.id);
    expect(row?.status).toBe("awaiting_approval");
    expect(row?.status).not.toBe("success");
    const steps = await listWorkflowStepRunRows(run.id);
    expect(steps[0]?.status).toBe("awaiting_approval");
  });

  test("a persistence failure is swallowed — the run still completes", async () => {
    const wf = makeExecutor({});
    const def: WorkflowDefinition = {
      name: "fk-violating",
      description: "",
      steps: [{ name: "t", kind: "transform", output: { a: "x" } }],
    };

    // A projectId with no `projects` row makes the up-front INSERT fail on
    // its FK. The run must not care: a DB glitch cannot fail a workflow
    // that otherwise succeeded.
    const run = await wf.runWorkflow(def, {}, "no-such-project-id");

    expect(run.status).toBe("success");
    expect(await getWorkflowRunRow(run.id)).toBeUndefined();
  });
});
