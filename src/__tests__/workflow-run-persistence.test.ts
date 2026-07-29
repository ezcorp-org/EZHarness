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
    // Per-step model telemetry: NULL means "this step ran no LLM", which
    // is true of every row written before the columns existed.
    expect(key("workflow_step_runs", "provider")).toBe("YES");
    expect(key("workflow_step_runs", "model")).toBe("YES");
  });

  test("adds default_model to workflow_definitions without touching history", async () => {
    const cols = (await db.execute(sql`
      SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name = 'workflow_definitions' AND column_name = 'default_model'
    `)) as { rows: Array<{ column_name: string; is_nullable: string }> };
    expect(cols.rows[0]?.is_nullable).toBe("YES");
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

// ── Durable resume state (C4 build-order step 1) ──────────────────
//
// Schema-only. No executor writes these yet — the point of landing them
// alone is that the migration proves backward-safe in isolation.
describe("migrate() — durable workflow-run columns", () => {
  test("run_phase defaults every pre-existing row to 'boundary' and resumable to false", async () => {
    // This is THE backward-safety property. A row written by the
    // pre-C4 insert path (which names none of the new columns) must read
    // as "parked at a boundary, not resumable" — anything else would
    // misclassify historical rows the moment recovery starts branching
    // on run_phase.
    const id = crypto.randomUUID();
    await insertWorkflowRun({
      id,
      workflowName: "pre-c4-shaped-insert",
      input: {},
      startedAt: new Date(),
    });

    const row = (await db.execute(sql`
      SELECT run_phase, resumable, cursor, suspended_reason, claimed_by,
             lease_expires_at, definition_hash, job_ref, idempotency_key
        FROM workflow_runs WHERE id = ${id}
    `)) as {
      rows: Array<{
        run_phase: string;
        resumable: boolean;
        cursor: unknown;
        suspended_reason: string | null;
        claimed_by: string | null;
        lease_expires_at: Date | null;
        definition_hash: string | null;
        job_ref: string | null;
        idempotency_key: string | null;
      }>;
    };
    const r = row.rows[0];
    expect(r?.run_phase).toBe("boundary");
    expect(r?.resumable).toBe(false);
    // Everything else is genuinely absent for a run that predates resume.
    expect(r?.cursor).toBeNull();
    expect(r?.suspended_reason).toBeNull();
    expect(r?.claimed_by).toBeNull();
    expect(r?.lease_expires_at).toBeNull();
    expect(r?.definition_hash).toBeNull();
    expect(r?.job_ref).toBeNull();
    expect(r?.idempotency_key).toBeNull();
  });

  test("run_phase is NOT NULL; every other resume column is nullable", async () => {
    const cols = (await db.execute(sql`
      SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name = 'workflow_runs'
    `)) as { rows: Array<{ column_name: string; is_nullable: string }> };
    const nullable = (c: string) =>
      cols.rows.find((r) => r.column_name === c)?.is_nullable;

    expect(nullable("run_phase")).toBe("NO");
    expect(nullable("resumable")).toBe("NO");
    for (const c of [
      "cursor",
      "suspended_reason",
      "claimed_by",
      "lease_expires_at",
      "definition_hash",
      "job_ref",
      "idempotency_key",
    ]) {
      expect(nullable(c)).toBe("YES");
    }
    // The resume prerequisite on the step table.
    const stepCols = (await db.execute(sql`
      SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name = 'workflow_step_runs' AND column_name = 'output'
    `)) as { rows: Array<{ is_nullable: string }> };
    expect(stepCols.rows[0]?.is_nullable).toBe("YES");
  });

  test("cursor round-trips as JSONB", async () => {
    const id = crypto.randomUUID();
    await insertWorkflowRun({
      id,
      workflowName: "cursor-roundtrip",
      input: {},
      startedAt: new Date(),
    });
    const cursor = { batchIndex: 2, completedSteps: ["a", "b"], prevStepName: "b" };
    await db.execute(
      sql`UPDATE workflow_runs SET cursor = ${JSON.stringify(cursor)}::jsonb WHERE id = ${id}`,
    );

    const read = (await db.execute(
      sql`SELECT cursor FROM workflow_runs WHERE id = ${id}`,
    )) as { rows: Array<{ cursor: typeof cursor }> };
    expect(read.rows[0]?.cursor).toEqual(cursor);
  });

  test("the idempotency index is PARTIAL — many NULL keys coexist, a duplicate key collides", async () => {
    // Two keyless runs of the same workflow must not collide: without the
    // `WHERE idempotency_key IS NOT NULL` predicate this index would
    // still permit it (SQL NULLs are distinct), but the predicate also
    // keeps the index off every non-idempotent run, which is the point.
    for (let i = 0; i < 2; i++) {
      await insertWorkflowRun({
        id: crypto.randomUUID(),
        workflowName: "same-name-no-key",
        input: {},
        startedAt: new Date(),
      });
    }

    const first = crypto.randomUUID();
    await insertWorkflowRun({
      id: first,
      workflowName: "idem-workflow",
      input: {},
      startedAt: new Date(),
    });
    await db.execute(sql`UPDATE workflow_runs SET idempotency_key = 'k1' WHERE id = ${first}`);

    const second = crypto.randomUUID();
    await insertWorkflowRun({
      id: second,
      workflowName: "idem-workflow",
      input: {},
      startedAt: new Date(),
    });
    // `.rejects` needs a real Promise; drizzle's builder is only a
    // thenable, so awaiting it inside an async fn is what produces one.
    const reuseKey = async (): Promise<void> => {
      await db.execute(sql`UPDATE workflow_runs SET idempotency_key = 'k1' WHERE id = ${second}`);
    };
    await expect(reuseKey()).rejects.toThrow();

    // ...and the SAME key under a DIFFERENT workflow name is fine — the
    // uniqueness is per (workflow_name, idempotency_key).
    const third = crypto.randomUUID();
    await insertWorkflowRun({
      id: third,
      workflowName: "other-workflow",
      input: {},
      startedAt: new Date(),
    });
    await db.execute(sql`UPDATE workflow_runs SET idempotency_key = 'k1' WHERE id = ${third}`);
    const read = (await db.execute(
      sql`SELECT idempotency_key FROM workflow_runs WHERE id = ${third}`,
    )) as { rows: Array<{ idempotency_key: string }> };
    expect(read.rows[0]?.idempotency_key).toBe("k1");
  });

  test("creates the claimable index the daemon and the sweep share", async () => {
    const rows = (await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'workflow_runs'
    `)) as { rows: Array<{ indexname: string }> };
    const names = rows.rows.map((r) => r.indexname);
    expect(names).toContain("idx_workflow_runs_claimable");
    expect(names).toContain("uniq_workflow_runs_idem");
  });

  test("step output round-trips, including the truncation sentinel", async () => {
    const runId = crypto.randomUUID();
    await insertWorkflowRun({
      id: runId,
      workflowName: "step-output",
      input: {},
      startedAt: new Date(),
    });
    await upsertWorkflowStepRun({
      workflowRunId: runId,
      stepName: "s1",
      runId: "",
      status: "success",
    });
    const result = { success: true, output: { draftId: "d-1" } };
    await db.execute(sql`
      UPDATE workflow_step_runs SET output = ${JSON.stringify(result)}::jsonb
       WHERE workflow_run_id = ${runId} AND step_name = 's1'
    `);
    const read = (await db.execute(sql`
      SELECT output FROM workflow_step_runs WHERE workflow_run_id = ${runId} AND step_name = 's1'
    `)) as { rows: Array<{ output: typeof result }> };
    expect(read.rows[0]?.output).toEqual(result);

    // The overflow sentinel is deliberately NOT AgentResult-shaped, so a
    // resume can tell "this is not the value" from "this step produced
    // nothing".
    const truncated = { __truncated: true, bytes: 400_000 };
    await db.execute(sql`
      UPDATE workflow_step_runs SET output = ${JSON.stringify(truncated)}::jsonb
       WHERE workflow_run_id = ${runId} AND step_name = 's1'
    `);
    const read2 = (await db.execute(sql`
      SELECT output FROM workflow_step_runs WHERE workflow_run_id = ${runId} AND step_name = 's1'
    `)) as { rows: Array<{ output: typeof truncated }> };
    expect(read2.rows[0]?.output).toEqual(truncated);
  });
});

describe("migrate() — workflow_approvals", () => {
  async function seedRun(): Promise<string> {
    const id = crypto.randomUUID();
    await insertWorkflowRun({
      id,
      workflowName: "approval-host",
      input: {},
      startedAt: new Date(),
    });
    return id;
  }

  test("stores an approval with the documented defaults", async () => {
    const runId = await seedRun();
    await db.execute(sql`
      INSERT INTO workflow_approvals (id, workflow_run_id, step_name, choices)
      VALUES (${crypto.randomUUID()}, ${runId}, 'publish-gate', '["approve","reject"]'::jsonb)
    `);
    const read = (await db.execute(sql`
      SELECT prompt, status, require_item_consent, consent_all_used, item_ids,
             answered_by, expires_at
        FROM workflow_approvals WHERE workflow_run_id = ${runId}
    `)) as {
      rows: Array<{
        prompt: string;
        status: string;
        require_item_consent: boolean;
        consent_all_used: boolean;
        item_ids: unknown;
        answered_by: string | null;
        expires_at: Date | null;
      }>;
    };
    const r = read.rows[0];
    expect(r?.status).toBe("pending");
    expect(r?.prompt).toBe("");
    expect(r?.require_item_consent).toBe(false);
    // A blanket clear is allowed but never silent — it starts false and is
    // only ever set by the guard that permitted it.
    expect(r?.consent_all_used).toBe(false);
    expect(r?.item_ids).toBeNull();
    expect(r?.answered_by).toBeNull();
    expect(r?.expires_at).toBeNull();
  });

  test("one live approval per (run, step)", async () => {
    const runId = await seedRun();
    // Awaited inside an async fn so `.rejects` sees a real Promise —
    // drizzle's builder is only a thenable.
    const insert = async (): Promise<void> => {
      await db.execute(sql`
        INSERT INTO workflow_approvals (id, workflow_run_id, step_name, choices)
        VALUES (${crypto.randomUUID()}, ${runId}, 'gate', '["yes"]'::jsonb)
      `);
    };
    await insert();
    // A resumed-then-re-suspended step must update in place, not stack a
    // second row the inbox would render twice.
    await expect(insert()).rejects.toThrow();
  });

  test("deleting the run CASCADES its approvals away", async () => {
    const runId = await seedRun();
    await db.execute(sql`
      INSERT INTO workflow_approvals (id, workflow_run_id, step_name, choices)
      VALUES (${crypto.randomUUID()}, ${runId}, 'gate', '["yes"]'::jsonb)
    `);
    await db.execute(sql`DELETE FROM workflow_runs WHERE id = ${runId}`);
    const left = (await db.execute(sql`
      SELECT id FROM workflow_approvals WHERE workflow_run_id = ${runId}
    `)) as { rows: Array<{ id: string }> };
    // An approval without its run is meaningless — unlike run HISTORY,
    // which is deliberately preserved via SET NULL.
    expect(left.rows).toHaveLength(0);
  });

  test("deleting the answering user un-attributes the answer but keeps it", async () => {
    const runId = await seedRun();
    await db.execute(sql`
      INSERT INTO users (id, email, password_hash, name)
      VALUES ('approver-1', 'approver@example.test', 'x', 'Approver')
    `);
    const approvalId = crypto.randomUUID();
    await db.execute(sql`
      INSERT INTO workflow_approvals (id, workflow_run_id, step_name, choices, status, answered_by, answer_choice)
      VALUES (${approvalId}, ${runId}, 'gate', '["yes"]'::jsonb, 'answered', 'approver-1', 'yes')
    `);
    await db.execute(sql`DELETE FROM users WHERE id = 'approver-1'`);

    const read = (await db.execute(sql`
      SELECT answered_by, answer_choice, status FROM workflow_approvals WHERE id = ${approvalId}
    `)) as {
      rows: Array<{ answered_by: string | null; answer_choice: string; status: string }>;
    };
    // Same IDOR-guard rationale as runs.user_id: the answer loses its
    // attribution, it does not erase that an approval happened.
    expect(read.rows[0]?.answered_by).toBeNull();
    expect(read.rows[0]?.answer_choice).toBe("yes");
    expect(read.rows[0]?.status).toBe("answered");
  });

  test("creates the pending-inbox and answered_by indexes", async () => {
    const rows = (await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'workflow_approvals'
    `)) as { rows: Array<{ indexname: string }> };
    const names = rows.rows.map((r) => r.indexname);
    expect(names).toContain("uniq_workflow_approval");
    expect(names).toContain("idx_workflow_approvals_pending");
    expect(names).toContain("idx_workflow_approvals_answered_by");
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
    // A transform step ran no LLM — both model columns stay NULL.
    expect(row?.provider).toBeNull();
    expect(row?.model).toBeNull();
  });

  test("upsertWorkflowStepRun records the resolved provider/model", async () => {
    const id = crypto.randomUUID();
    await insertWorkflowRun({ id, workflowName: "wf", input: {}, startedAt: new Date() });
    // The step starts before the agent has resolved anything...
    await upsertWorkflowStepRun({
      workflowRunId: id,
      stepName: "verify",
      runId: "",
      status: "running",
    });
    expect((await listWorkflowStepRunRows(id))[0]?.model).toBeNull();

    // ...and the terminal write fills the columns in.
    await upsertWorkflowStepRun({
      workflowRunId: id,
      stepName: "verify",
      runId: "",
      status: "success",
      provider: "anthropic",
      model: "claude-opus-5",
    });
    const rows = await listWorkflowStepRunRows(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.provider).toBe("anthropic");
    expect(rows[0]?.model).toBe("claude-opus-5");
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

  test("the boot sweep does NOT terminalize a run that started after the cutoff", async () => {
    // The sweep is fired-and-forgotten during boot, so its UPDATE can
    // still be in flight when the first request inserts a fresh row.
    // Without the cutoff it drained that LIVE run, and the run's real
    // finalize then lost its CAS — the row permanently (and falsely)
    // claimed the process had restarted mid-run.
    const cutoff = new Date();
    const live = crypto.randomUUID();
    const stale = crypto.randomUUID();
    await insertWorkflowRun({
      id: live,
      workflowName: "started-after-boot",
      input: {},
      startedAt: new Date(cutoff.getTime() + 1000),
    });
    await insertWorkflowRun({
      id: stale,
      workflowName: "started-before-boot",
      input: {},
      startedAt: new Date(cutoff.getTime() - 1000),
    });

    await terminalizeOrphanedWorkflowRuns(cutoff);

    // The cutoff DISCRIMINATES: the pre-boot row is drained in the very
    // same sweep that leaves the post-boot one alone. (Asserting a zero
    // row count would be vacuous — other rows in this DB are orphaned
    // too.)
    expect((await getWorkflowRunRow(stale))?.status).toBe("error");
    expect((await getWorkflowRunRow(live))?.status).toBe("running");
    // ...and the live run can still record its true outcome.
    expect(await finalizeWorkflowRunRow(live, "success", { success: true, output: "real" })).toBe(1);
    expect((await getWorkflowRunRow(live))?.status).toBe("success");
  });

  test("the boot sweep drains a half-written row (finished_at set, status still running)", async () => {
    // The predicate used to carry `AND finished_at IS NULL`, which
    // silently skipped exactly the partially-written state the sweep
    // exists to clean up — leaving it stuck `running` forever.
    const half = crypto.randomUUID();
    await insertWorkflowRun({
      id: half,
      workflowName: "half-written",
      input: {},
      startedAt: new Date(Date.now() - 60_000),
    });
    await db.execute(sql`UPDATE workflow_runs SET finished_at = NOW() WHERE id = ${half}`);

    const drained = await terminalizeOrphanedWorkflowRuns();

    expect(drained).toBeGreaterThanOrEqual(1);
    expect((await getWorkflowRunRow(half))?.status).toBe("error");
  });

  test("concurrent finalizes produce exactly one winner", async () => {
    const id = crypto.randomUUID();
    await insertWorkflowRun({ id, workflowName: "wf", input: {}, startedAt: new Date() });
    const [a, b] = await Promise.all([
      finalizeWorkflowRunRow(id, "success", { success: true, output: "A" }),
      finalizeWorkflowRunRow(id, "error", { success: false, output: null, error: "B" }),
    ]);
    // The CAS is a single UPDATE ... WHERE status='running'; the loser
    // re-evaluates its predicate against the winner's committed row.
    expect(a + b).toBe(1);
    expect((await getWorkflowRunRow(id))?.status).toBe("success");
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
