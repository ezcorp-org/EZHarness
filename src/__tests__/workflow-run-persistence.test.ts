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
import type { AgentEvents, WorkflowDefinition, WorkflowStep } from "../types";
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
  loadStepResults,
  terminalizeOrphanedWorkflowRuns,
  upsertWorkflowStepRun,
} = await import("../db/queries/workflow-runs");
const { WorkflowExecutor, WorkflowSuspendedError } = await import(
  "../runtime/workflow-executor"
);
const { workflowDefinitionHash } = await import("../runtime/workflow-definition-hash");
const {
  expireWorkflowApproval,
  getWorkflowApproval,
  getWorkflowApprovalById,
  listExpiredWorkflowApprovals,
  listPendingWorkflowApprovals,
  parkWorkflowApproval,
  recordWorkflowApprovalAnswer,
} = await import("../db/queries/workflow-approvals");
type ParkApprovalInput = Parameters<typeof parkWorkflowApproval>[0];

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

/**
 * Row shapes for the raw `db.execute` reads below.
 *
 * Named aliases rather than an inline `` `)) as { rows: … } ``, for two
 * reasons. The first is ordinary DRY — several tests read the same
 * shapes. The second is a gate interaction worth recording: a line that
 * BEGINS with a backtick opens a template literal which
 * `scripts/gate-integrity.ts`'s `stripNoise` never closes, because it
 * declares its `quote` state per LINE (`:271-273`). The `{` of a trailing
 * `as {` is therefore swallowed while its matching `}` a few lines down
 * still counts, the brace depth closes the test body early, and every
 * `expect()` below becomes invisible to the vacuous-test check — which
 * then reports a well-asserted test as having no assertions.
 *
 * Keeping braces off any line that starts with a backtick avoids it
 * entirely. Fixing `stripNoise` itself would be the real repair, but that
 * file is CODEOWNERS-owned.
 */
type Rows<T> = { rows: T[] };
type NullabilityRow = { is_nullable: string };
type ColumnRow = { column_name: string; is_nullable: string };
type TableColumnRow = { table_name: string; column_name: string; is_nullable: string };
type IndexRow = { indexname: string };
type IdRow = { id: string };
type CursorValue = { batchIndex: number; completedSteps: string[]; prevStepName: string | null };
type DurableRunRow = {
  run_phase: string;
  resumable: boolean;
  cursor: unknown;
  suspended_reason: string | null;
  claimed_by: string | null;
  lease_expires_at: Date | null;
  definition_hash: string | null;
  job_ref: string | null;
  idempotency_key: string | null;
};
type PositionRow = {
  run_phase: string;
  cursor: CursorValue | null;
  definition_hash: string | null;
};
type StepOutputRow<T> = { output: T };
type ApprovalDefaultsRow = {
  prompt: string;
  status: string;
  require_item_consent: boolean;
  consent_all_used: boolean;
  item_ids: unknown;
  answered_by: string | null;
  expires_at: Date | null;
};
type ApprovalAnswerRow = {
  answered_by: string | null;
  answer_choice: string;
  status: string;
};

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
    `)) as Rows<TableColumnRow>;
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
    `)) as Rows<ColumnRow>;
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
    `)) as Rows<IndexRow>;
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
    `)) as Rows<DurableRunRow>;
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
    `)) as Rows<ColumnRow>;
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
    `)) as Rows<NullabilityRow>;
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
    `)) as Rows<IndexRow>;
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
    `)) as Rows<StepOutputRow<typeof result>>;
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
    `)) as Rows<StepOutputRow<typeof truncated>>;
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
    `)) as Rows<ApprovalDefaultsRow>;
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
    `)) as Rows<IdRow>;
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
    `)) as Rows<ApprovalAnswerRow>;
    // Same IDOR-guard rationale as runs.user_id: the answer loses its
    // attribution, it does not erase that an approval happened.
    expect(read.rows[0]?.answered_by).toBeNull();
    expect(read.rows[0]?.answer_choice).toBe("yes");
    expect(read.rows[0]?.status).toBe("answered");
  });

  test("creates the pending-inbox and answered_by indexes", async () => {
    const rows = (await db.execute(sql`
      SELECT indexname FROM pg_indexes WHERE tablename = 'workflow_approvals'
    `)) as Rows<IndexRow>;
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

    // The cutoff DISCRIMINATES: the pre-boot row is swept in the very
    // same sweep that leaves the post-boot one alone. (Asserting a zero
    // row count would be vacuous — other rows in this DB are orphaned
    // too.) The pre-boot row was at a boundary, so it parks as
    // `suspended` rather than dying — that is the recovery model, not a
    // missed sweep.
    expect((await getWorkflowRunRow(stale))?.status).toBe("suspended");
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
    // Swept, not skipped — which is the property this test exists for.
    // The row was at a boundary, so the sweep parks it rather than
    // killing it; either way it no longer claims to be running.
    expect((await getWorkflowRunRow(half))?.status).toBe("suspended");
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

  test("terminalizeOrphanedWorkflowRuns sweeps rows a dead process left running", async () => {
    const orphan = crypto.randomUUID();
    const healthy = crypto.randomUUID();
    await insertWorkflowRun({ id: orphan, workflowName: "wf", input: {}, startedAt: new Date() });
    await insertWorkflowRun({ id: healthy, workflowName: "wf", input: {}, startedAt: new Date() });
    await finalizeWorkflowRunRow(healthy, "success");

    const drained = await terminalizeOrphanedWorkflowRuns();
    expect(drained).toBeGreaterThanOrEqual(1);

    const row = await getWorkflowRunRow(orphan);
    expect(row?.status).toBe("suspended");

    // The already-terminal run is untouched, and a second sweep finds nothing.
    expect((await getWorkflowRunRow(healthy))?.status).toBe("success");
    expect(await terminalizeOrphanedWorkflowRuns()).toBe(0);
  });
});

// ── Crash recovery (C4 build-order step 4) ────────────────────────
//
// Deterministic by construction: no process is killed and no wall clock
// is consulted. The row state a crash WOULD have left is written
// directly, and both cutoffs are injected — the established pattern for
// this table.
describe("crash recovery — the sweep branches on run_phase", () => {
  const BOOT = new Date("2026-07-29T12:00:00Z");
  const NOW = new Date("2026-07-29T12:05:00Z");

  async function orphanAt(
    runPhase: "boundary" | "in-batch",
    opts: { cursorBatch?: number; lease?: Date | null } = {},
  ): Promise<string> {
    const id = crypto.randomUUID();
    await insertWorkflowRun({
      id,
      workflowName: "recovered",
      input: {},
      // Before the boot cutoff ⇒ the classic no-lease orphan.
      startedAt: new Date(BOOT.getTime() - 60_000),
    });
    const cursor = {
      batchIndex: opts.cursorBatch ?? 2,
      completedSteps: ["a", "b"],
      prevStepName: "b",
    };
    await db.execute(sql`
      UPDATE workflow_runs
         SET run_phase = ${runPhase}, cursor = ${JSON.stringify(cursor)}::jsonb,
             lease_expires_at = ${opts.lease ?? null}, claimed_by = ${opts.lease ? "worker-1" : null}
       WHERE id = ${id}
    `);
    return id;
  }

  test("a boundary orphan becomes suspended and resumable, keeping its cursor", async () => {
    const id = await orphanAt("boundary", { cursorBatch: 2 });

    await terminalizeOrphanedWorkflowRuns(BOOT, NOW);

    const row = await getWorkflowRunRow(id);
    expect(row?.status).toBe("suspended");
    expect(row?.resumable).toBe(true);
    expect(row?.suspendedReason).toBe("orphaned-resumable");
    // Not finished — it is going to continue, and a finish time would
    // make it read as terminal in any list that sorts on one.
    expect(row?.finishedAt).toBeNull();
    // The coordinate the daemon will resume from survives untouched.
    expect(row?.cursor?.batchIndex).toBe(2);
    // The dead owner's claim is cleared, or nothing could ever pick it up.
    expect(row?.claimedBy).toBeNull();
    expect(row?.leaseExpiresAt).toBeNull();
  });

  test("a mid-batch orphan fails closed, naming the batch and the steps in flight", async () => {
    const id = await orphanAt("in-batch", { cursorBatch: 3 });
    // Two steps the dead process had dispatched but never finished.
    for (const stepName of ["charlie", "alpha"]) {
      await upsertWorkflowStepRun({
        workflowRunId: id,
        stepName,
        runId: "",
        status: "running",
      });
    }

    await terminalizeOrphanedWorkflowRuns(BOOT, NOW);

    const row = await getWorkflowRunRow(id);
    // A restart cannot safely re-enter a half-executed step: a
    // `write_file` may be applied, an LLM call already billed.
    expect(row?.status).toBe("error");
    expect(row?.resumable).toBe(false);
    expect(row?.finishedAt).not.toBeNull();
    const message = String((row?.result as { error?: unknown })?.error);
    expect(message).toContain("orphaned");
    // The operator needs to know WHERE to retry from.
    expect(message).toContain("batch 3");
    expect(message).toContain("alpha, charlie");
  });

  test("an expired lease is swept even though the run started after the boot cutoff", async () => {
    // The dead-daemon case: a run this process's boot cutoff would never
    // match, caught by the lease half of the predicate instead.
    const id = crypto.randomUUID();
    await insertWorkflowRun({
      id,
      workflowName: "leased",
      input: {},
      startedAt: new Date(BOOT.getTime() + 60_000),
    });
    await db.execute(sql`
      UPDATE workflow_runs
         SET claimed_by = 'worker-1', lease_expires_at = ${new Date(NOW.getTime() - 1000)}
       WHERE id = ${id}
    `);

    await terminalizeOrphanedWorkflowRuns(BOOT, NOW);
    expect((await getWorkflowRunRow(id))?.status).toBe("suspended");
  });

  test("a LIVE lease is left alone", async () => {
    const id = crypto.randomUUID();
    await insertWorkflowRun({
      id,
      workflowName: "live-lease",
      input: {},
      // Deliberately older than the boot cutoff: the lease is what says
      // this run is alive, and it must win over the age heuristic.
      startedAt: new Date(BOOT.getTime() - 60_000),
    });
    await db.execute(sql`
      UPDATE workflow_runs
         SET claimed_by = 'worker-1', lease_expires_at = ${new Date(NOW.getTime() + 60_000)}
       WHERE id = ${id}
    `);

    await terminalizeOrphanedWorkflowRuns(BOOT, NOW);
    const row = await getWorkflowRunRow(id);
    expect(row?.status).toBe("running");
    expect(row?.claimedBy).toBe("worker-1");
  });

  test("ORDERING INVARIANT: a run whose cursor advance did not land is never resumable", async () => {
    // Recovery's fail-closed behaviour rests on this ordering:
    //   1. `run_phase = 'in-batch'` is written BEFORE the batch dispatches;
    //   2. it returns to `'boundary'` only in the SAME UPDATE that
    //      advances the cursor.
    //
    // So a cursor advance that never landed leaves the run at
    // `in-batch`, and the sweep must fail it closed. If that ordering
    // were ever broken — the phase cleared separately from the cursor —
    // the row would read `boundary` with a STALE cursor, and recovery
    // would resume it and re-execute a completed batch: duplicate tool
    // steps, duplicated side effects, silently.
    //
    // This is why the cursor advance stays on the strict write path even
    // though a swallowed advance is survivable today: relaxed, that
    // safety would depend on this invariant holding forever, and the
    // failure it guards against is neither loud nor recoverable.
    const id = crypto.randomUUID();
    await insertWorkflowRun({
      id,
      workflowName: "advance-never-landed",
      input: {},
      startedAt: new Date(BOOT.getTime() - 60_000),
    });
    // Exactly the state a batch that completed but whose advance was lost
    // leaves behind: phase still `in-batch`, cursor still pointing at the
    // batch that already ran.
    await db.execute(sql`
      UPDATE workflow_runs
         SET run_phase = 'in-batch',
             cursor = ${JSON.stringify({ batchIndex: 1, completedSteps: ["a"], prevStepName: "a" })}::jsonb
       WHERE id = ${id}
    `);

    await terminalizeOrphanedWorkflowRuns(BOOT, NOW);

    const row = await getWorkflowRunRow(id);
    expect(row?.status).toBe("error");
    expect(row?.resumable).toBe(false);
    // Never parked, never picked up, never re-executed.
    expect(row?.status).not.toBe("suspended");
    expect(row?.suspendedReason).toBeNull();
  });

  test("an already-parked run is a zero-row no-op", async () => {
    // `suspended` is excluded structurally by the `status='running'`
    // predicate — a parked run must never be re-swept, or every answer
    // would race the sweep.
    const id = await orphanAt("boundary");
    await terminalizeOrphanedWorkflowRuns(BOOT, NOW);
    expect((await getWorkflowRunRow(id))?.status).toBe("suspended");

    const second = await terminalizeOrphanedWorkflowRuns(BOOT, NOW);
    expect(second).toBe(0);
    expect((await getWorkflowRunRow(id))?.status).toBe("suspended");
  });

  test("one sweep classifies a mixed batch of orphans independently", async () => {
    // The selection is a single predicate; only the action branches. Both
    // kinds must therefore be handled in the SAME pass.
    const boundary = await orphanAt("boundary");
    const midBatch = await orphanAt("in-batch");

    // ONE sweep call — the two divergent outcomes below are the proof
    // that both were classified in the same pass. The count is only a
    // floor: this DB carries other rows from earlier tests, so asserting
    // an exact total would break the moment one is added above.
    const swept = await terminalizeOrphanedWorkflowRuns(BOOT, NOW);
    expect(swept).toBeGreaterThanOrEqual(2);

    expect((await getWorkflowRunRow(boundary))?.status).toBe("suspended");
    expect((await getWorkflowRunRow(midBatch))?.status).toBe("error");
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

  test("persists each successful step's output, so $steps can be rehydrated", async () => {
    // The resume prerequisite, end to end through the real executor: what
    // the sync path now records is exactly what a resumed run reads back.
    const wf = makeExecutor({ toolHandler: () => ok('{"draftId":"d-9"}') });
    const def: WorkflowDefinition = {
      name: "output-persisted",
      description: "",
      steps: [
        { name: "prep", kind: "transform", output: { ready: "yes" } },
        { name: "call", kind: "tool", tool: "demo__x" },
      ],
    };

    const run = await wf.runWorkflow(def, {}, undefined, undefined);
    expect(run.status).toBe("success");

    const loaded = await loadStepResults(run.id);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.reason);
    // Both steps are addressable, not just the last one — any later step
    // can reference any earlier one via `$steps.<name>`.
    expect(loaded.stepResults.get("prep")).toEqual({
      success: true,
      output: { ready: "yes" },
    });
    // The tool step's JSON was parsed by the executor before storage, so
    // the rehydrated value is path-addressable exactly as it was live.
    expect(loaded.stepResults.get("call")).toEqual({
      success: true,
      output: { draftId: "d-9" },
    });
  });

  test("a step output carrying an sk-… key is stored redacted", async () => {
    const wf = makeExecutor({
      toolHandler: () => ok('{"token":"sk-aaaaaaaaaaaaaaaaaaaaaa"}'),
    });
    const def: WorkflowDefinition = {
      name: "output-redacted",
      description: "",
      steps: [{ name: "leaky", kind: "tool", tool: "demo__x" }],
    };

    const run = await wf.runWorkflow(def, {}, undefined, undefined);

    const steps = await listWorkflowStepRunRows(run.id);
    // Redaction is not optional: this column carries whatever an
    // extension tool returned, and the run-history UI renders it.
    expect(steps[0]?.output).toEqual({
      success: true,
      output: { token: "[REDACTED]" },
    });
    // The LIVE run still saw the real value — redaction is a storage
    // concern and must not change what the graph computed on.
    expect(run.result?.output).toEqual({ token: "sk-aaaaaaaaaaaaaaaaaaaaaa" });
  });
});

describe("durable position — run_phase, cursor, definition_hash", () => {
  async function readPosition(runId: string) {
    const row = (await db.execute(sql`
      SELECT run_phase, cursor, definition_hash FROM workflow_runs WHERE id = ${runId}
    `)) as Rows<PositionRow>;
    return row.rows[0];
  }

  test("records the definition hash at insert", async () => {
    const wf = makeExecutor({});
    const def: WorkflowDefinition = {
      name: "hashed",
      description: "",
      steps: [{ name: "only", kind: "transform", output: { a: "1" } }],
    };
    const run = await wf.runWorkflow(def, {}, undefined, undefined);
    // Pins the graph the run was authorized against, so a resume can
    // refuse to continue into an edited one.
    expect((await readPosition(run.id))?.definition_hash).toBe(
      workflowDefinitionHash(def),
    );
  });

  test("lands at a boundary with the cursor past the last batch", async () => {
    const wf = makeExecutor({});
    const def: WorkflowDefinition = {
      name: "three-sequential",
      description: "",
      steps: [
        { name: "a", kind: "transform", output: { v: "1" } },
        { name: "b", kind: "transform", output: { v: "2" } },
        { name: "c", kind: "transform", output: { v: "3" } },
      ],
    };
    const run = await wf.runWorkflow(def, {}, undefined, undefined);
    expect(run.status).toBe("success");

    const pos = await readPosition(run.id);
    // No deps ⇒ one step per batch, so a completed run sits at batch 3.
    expect(pos?.run_phase).toBe("boundary");
    expect(pos?.cursor?.batchIndex).toBe(3);
    expect(pos?.cursor?.completedSteps).toEqual(["a", "b", "c"]);
  });

  test("cursor.prevStepName names the step whose result IS $prev", async () => {
    // THE property the cursor design rests on. `results` is Promise.all
    // over `batch.map`, so it is in batch order, and any failure throws
    // before the cursor advances — therefore
    // `results[results.length - 1]` is always `batch[batch.length - 1]`.
    // A refactor that makes `prevResult` lazy, or reorders the batch,
    // breaks this and must fail loudly here rather than silently give a
    // resumed run a different `$prev` than the same run straight through.
    const wf = makeExecutor({});
    const def: WorkflowDefinition = {
      name: "parallel-then-join",
      description: "",
      steps: [
        { name: "seed", kind: "transform", output: { v: "seed" } },
        { name: "left", kind: "transform", dependsOn: ["seed"], output: { v: "left" } },
        { name: "right", kind: "transform", dependsOn: ["seed"], output: { v: "right" } },
        // Reads $prev, so its output records which sibling won the race
        // — that is the order-fragility the cursor must reproduce.
        { name: "join", kind: "transform", dependsOn: ["left", "right"], output: { saw: "$prev.output.v" } },
      ],
    };

    const run = await wf.runWorkflow(def, {}, undefined, undefined);
    expect(run.status).toBe("success");

    const pos = await readPosition(run.id);
    expect(pos?.cursor?.prevStepName).toBe("join");

    // And the value `join` actually saw is the LAST step of its batch in
    // declaration order — `right`, not `left`.
    const loaded = await loadStepResults(run.id);
    if (!loaded.ok) throw new Error(loaded.reason);
    expect(loaded.stepResults.get("join")).toEqual({
      success: true,
      output: { saw: "right" },
    });
  });

  test("a run mid-tool-step is running/in-batch — never suspended", async () => {
    // The phase's central safety claim, asserted from INSIDE the await.
    //
    // The rejected design was to write `suspended` before every await
    // point. Five of the eight await sites are mid-step, and the `tool`
    // dispatch is the one that makes it a correctness bug rather than an
    // imprecision: a row saying "resume me" while a side effect is
    // in flight invites a resume that re-enters a half-executed step —
    // a `write_file` applied twice, an LLM call re-billed.
    //
    // So the tool handler reads its own run's row at the moment the
    // dispatch is suspended. `in-batch` is what makes recovery fail this
    // run closed; `suspended` here would mean the opposite.
    let observed: { status: string; run_phase: string } | undefined;
    let observedFor: string | undefined;
    const wf = makeExecutor({
      toolHandler: async () => {
        const row = (await db.execute(sql`
          SELECT id, status, run_phase FROM workflow_runs
           WHERE workflow_name = 'inspects-itself-mid-step'
        `)) as Rows<{ id: string; status: string; run_phase: string }>;
        observed = row.rows[0];
        observedFor = row.rows[0]?.id;
        return ok("{}");
      },
    });
    const def: WorkflowDefinition = {
      name: "inspects-itself-mid-step",
      description: "",
      steps: [{ name: "t", kind: "tool", tool: "demo__x" }],
    };

    const run = await wf.runWorkflow(def, {}, undefined, undefined);
    expect(run.status).toBe("success");

    // Read from inside the dispatch, not inferred afterwards.
    expect(observedFor).toBe(run.id);
    expect(observed?.status).toBe("running");
    expect(observed?.run_phase).toBe("in-batch");
    expect(observed?.status).not.toBe("suspended");

    // ...and the completed run is back at a boundary, so the two states
    // are genuinely distinguished rather than one being unreachable.
    expect((await readPosition(run.id))?.run_phase).toBe("boundary");
  });

  test("a failed cursor write fails the run closed rather than reporting success", async () => {
    // `persistWrite` swallows by contract, which is right for telemetry
    // and fatal for a cursor: a dropped cursor leaves the next resume at
    // a stale batchIndex and re-executes a completed batch. Simulated by
    // a CHECK the advance cannot satisfy — dropped again immediately so
    // the shared DB is untouched for later tests.
    // NOT VALID: earlier tests in this file already left non-NULL
    // cursors, and we only want to reject the write under test, not
    // re-validate the table.
    await db.execute(
      sql`ALTER TABLE workflow_runs ADD CONSTRAINT no_cursor_writes CHECK (cursor IS NULL) NOT VALID`,
    );
    try {
      const wf = makeExecutor({});
      const def: WorkflowDefinition = {
        name: "cursor-write-fails",
        description: "",
        steps: [{ name: "a", kind: "transform", output: { v: "1" } }],
      };
      const run = await wf.runWorkflow(def, {}, undefined, undefined);

      expect(run.status).toBe("error");
      // Coded distinctly so an operator can tell a durability failure
      // from a workflow one — the steps themselves all succeeded.
      expect(run.result?.error).toMatchObject({ code: "cursor-write-failed" });
      expect(run.steps.every((s) => s.status === "success")).toBe(true);
    } finally {
      await db.execute(sql`ALTER TABLE workflow_runs DROP CONSTRAINT no_cursor_writes`);
    }
  });

  test("a failed in-batch marker fails closed before the batch dispatches", async () => {
    // The marker is what makes a crash mid-step non-resumable, so losing
    // it silently would let recovery treat a half-executed step as safe.
    // NOT VALID for the same reason as above — and specifically because
    // the previous test deliberately leaves a row stranded at
    // `in-batch`, which is exactly the state recovery exists to classify.
    await db.execute(
      sql`ALTER TABLE workflow_runs ADD CONSTRAINT no_inbatch CHECK (run_phase <> 'in-batch') NOT VALID`,
    );
    let dispatched = 0;
    try {
      const wf = makeExecutor({
        toolHandler: () => {
          dispatched++;
          return ok("{}");
        },
      });
      const def: WorkflowDefinition = {
        name: "inbatch-write-fails",
        description: "",
        steps: [{ name: "t", kind: "tool", tool: "demo__x" }],
      };
      const run = await wf.runWorkflow(def, {}, undefined, undefined);

      expect(run.status).toBe("error");
      expect(run.result?.error).toMatchObject({ code: "cursor-write-failed" });
      // The whole point of flushing before `batch.map`: the side effect
      // never happened.
      expect(dispatched).toBe(0);
    } finally {
      await db.execute(sql`ALTER TABLE workflow_runs DROP CONSTRAINT no_inbatch`);
    }
  });

  test("persist:false runs never touch the strict path", async () => {
    // A DB-less harness must be unaffected by strict bookkeeping —
    // otherwise every unit test without a wired DB would start failing.
    const bus = new EventBus<AgentEvents>();
    const agentExec = new AgentExecutor(loadAgentsStatic([]), bus);
    const wf = new (await import("../runtime/workflow-executor")).WorkflowExecutor(
      agentExec,
      bus,
      { persist: false },
    );
    const run = await wf.runWorkflow(
      {
        name: "unpersisted",
        description: "",
        steps: [{ name: "a", kind: "transform", output: { v: "1" } }],
      },
      {},
      undefined,
      undefined,
    );
    expect(run.status).toBe("success");
    expect(await getWorkflowRunRow(run.id)).toBeUndefined();
  });
});

describe("loadStepResults — fail-closed rehydration", () => {
  async function seedStep(
    status: "success" | "error" | "running",
    output: unknown | undefined,
  ): Promise<string> {
    const runId = crypto.randomUUID();
    await insertWorkflowRun({
      id: runId,
      workflowName: "rehydrate",
      input: {},
      startedAt: new Date(),
    });
    await upsertWorkflowStepRun({
      workflowRunId: runId,
      stepName: "s1",
      runId: "",
      status,
    });
    if (output !== undefined) {
      await db.execute(sql`
        UPDATE workflow_step_runs SET output = ${JSON.stringify(output)}::jsonb
         WHERE workflow_run_id = ${runId} AND step_name = 's1'
      `);
    }
    return runId;
  }

  test("only successful steps contribute", async () => {
    // A failed or still-running step produced no value the graph can
    // reference, so it must not appear in the map at all — and its NULL
    // output must not be mistaken for a lost one.
    for (const status of ["error", "running"] as const) {
      const runId = await seedStep(status, undefined);
      const loaded = await loadStepResults(runId);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) throw new Error(loaded.reason);
      expect(loaded.stepResults.size).toBe(0);
    }
  });

  test("fails closed when a successful step's output was never persisted", async () => {
    // The persistence path never throws by contract, so a swallowed write
    // is reachable. Resuming here would run the second half of the graph
    // against a different `$steps` than the first half saw.
    const runId = await seedStep("success", undefined);
    const loaded = await loadStepResults(runId);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) throw new Error("expected a fail-closed refusal");
    expect(loaded.reason).toContain('step "s1"');
    expect(loaded.reason).toContain("not persisted");
  });

  test("fails closed on a truncated output, naming the step and the size", async () => {
    const runId = await seedStep("success", { __truncated: true, bytes: 999_999 });
    const loaded = await loadStepResults(runId);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) throw new Error("expected a fail-closed refusal");
    expect(loaded.reason).toContain('step "s1"');
    // The operator needs the number to know how far over the cap it went.
    expect(loaded.reason).toContain("999999");
  });

  test("an empty run rehydrates to an empty map, not a refusal", async () => {
    const runId = crypto.randomUUID();
    await insertWorkflowRun({
      id: runId,
      workflowName: "no-steps-yet",
      input: {},
      startedAt: new Date(),
    });
    const loaded = await loadStepResults(runId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error(loaded.reason);
    expect(loaded.stepResults.size).toBe(0);
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

// ── Suspend / resume (C4 build-order step 5) ──────────────────────
//
// Driven directly against the executor — no daemon, no HTTP surface.
// Suspension is triggered by a `tool` step whose dispatcher throws the
// sentinel, which is how an `approval` step will park once that kind
// exists; the machinery under test is identical either way.
describe("suspend and resume", () => {
  function suspendingExecutor(parkOn: string, opts: { parkOnce?: boolean } = {}) {
    let parked = false;
    const bus = new EventBus<AgentEvents>();
    const starts: string[] = [];
    bus.on("workflow:start", ({ workflowRun }) => starts.push(workflowRun.id));
    const agentExec = new AgentExecutor(loadAgentsStatic([]), bus);
    const executed: string[] = [];
    const wf = new WorkflowExecutor(agentExec, bus, {
      persist: true,
      toolRunnerFactory: () => ({
        setCurrentUserId() {},
        async executeToolCall(toolName: string) {
          executed.push(toolName);
          if (toolName === parkOn && !(opts.parkOnce && parked)) {
            parked = true;
            throw new WorkflowSuspendedError(parkOn, "awaiting-human");
          }
          return ok(`{"tool":"${toolName}"}`);
        },
      }),
    });
    return { wf, bus, starts, executed };
  }

  test("a parked run is suspended, not finished, and keeps its cursor", async () => {
    const { wf } = suspendingExecutor("gate__ask");
    const def: WorkflowDefinition = {
      name: "parks",
      description: "",
      steps: [
        { name: "prep", kind: "transform", output: { v: "1" } },
        { name: "ask", kind: "tool", tool: "gate__ask" },
      ],
    };

    const run = await wf.runWorkflow(def, {}, undefined, undefined);

    expect(run.status).toBe("suspended");
    // Alive, so it must NOT look finished.
    expect(run.finishedAt).toBeUndefined();

    const row = await getWorkflowRunRow(run.id);
    expect(row?.status).toBe("suspended");
    expect(row?.finishedAt).toBeNull();
    expect(row?.suspendedReason).toBe("awaiting-human");
    // Back at a boundary: nothing is in flight, which is what makes the
    // row safe for another process to pick up.
    expect(row?.runPhase).toBe("boundary");
    // Parked re-entering batch 1 (the `ask` step's batch), with the
    // earlier batch's work recorded.
    expect(row?.cursor?.batchIndex).toBe(1);
    expect(row?.cursor?.completedSteps).toEqual(["prep"]);
  });

  test("resume completes the run and does NOT re-emit workflow:start", async () => {
    const { wf, bus, starts } = suspendingExecutor("gate__ask", { parkOnce: true });
    const def: WorkflowDefinition = {
      name: "parks-then-resumes",
      description: "",
      steps: [
        { name: "prep", kind: "transform", output: { v: "1" } },
        { name: "ask", kind: "tool", tool: "gate__ask" },
      ],
    };

    const first = await wf.runWorkflow(def, {}, undefined, undefined);
    expect(first.status).toBe("suspended");
    expect(starts).toEqual([first.id]);

    const resumedEvents: string[] = [];
    bus.on("workflow:complete", ({ workflowRun }) => resumedEvents.push(workflowRun.id));

    const row = await getWorkflowRunRow(first.id);
    const resumed = await wf.resumeWorkflow(def, {
      id: row!.id,
      workflowName: row!.workflowName,
      status: row!.status,
      input: row!.input,
      cursor: row!.cursor,
      definitionHash: row!.definitionHash,
      projectId: row!.projectId,
      userId: row!.userId,
      startedAt: row!.startedAt,
    });

    expect(resumed.status).toBe("success");
    expect(resumedEvents).toEqual([first.id]);
    // THE property: re-emitting `workflow:start` prepends a second card
    // to the client store, rendering one parked job as two runs.
    expect(starts).toEqual([first.id]);

    expect((await getWorkflowRunRow(first.id))?.status).toBe("success");
  });

  test("resume does not re-execute a step the parked run already completed", async () => {
    // The partial-batch property. `sibling` and `ask` share a batch; the
    // sibling succeeds, then `ask` parks. Re-running the sibling on
    // resume would duplicate its side effect.
    const { wf, executed } = suspendingExecutor("gate__ask", { parkOnce: true });
    const def: WorkflowDefinition = {
      name: "partial-batch",
      description: "",
      steps: [
        { name: "seed", kind: "transform", output: { v: "s" } },
        { name: "sibling", kind: "tool", tool: "side__effect", dependsOn: ["seed"] },
        { name: "ask", kind: "tool", tool: "gate__ask", dependsOn: ["seed"] },
      ],
    };

    const first = await wf.runWorkflow(def, {}, undefined, undefined);
    expect(first.status).toBe("suspended");
    expect(executed.filter((t) => t === "side__effect")).toHaveLength(1);

    const row = await getWorkflowRunRow(first.id);
    // The sibling is recorded as complete even though its batch never
    // reached a boundary — appended on success, not at the boundary.
    expect(row?.cursor?.completedSteps).toContain("sibling");

    const resumed = await wf.resumeWorkflow(def, {
      id: row!.id,
      workflowName: row!.workflowName,
      status: row!.status,
      input: row!.input,
      cursor: row!.cursor,
      definitionHash: row!.definitionHash,
      projectId: row!.projectId,
      userId: row!.userId,
      startedAt: row!.startedAt,
    });

    expect(resumed.status).toBe("success");
    // Still exactly one dispatch across BOTH halves of the run.
    expect(executed.filter((t) => t === "side__effect")).toHaveLength(1);
  });

  test("resume fails closed when the definition changed, naming the drift", async () => {
    const { wf } = suspendingExecutor("gate__ask", { parkOnce: true });
    const def: WorkflowDefinition = {
      name: "drifts",
      description: "",
      steps: [{ name: "ask", kind: "tool", tool: "gate__ask" }],
    };
    const first = await wf.runWorkflow(def, {}, undefined, undefined);
    expect(first.status).toBe("suspended");

    // An extra step moves every later batch — `cursor.batchIndex` would
    // now address something the operator never parked.
    const edited: WorkflowDefinition = {
      ...def,
      steps: [{ name: "inserted", kind: "transform", output: {} }, ...def.steps],
    };

    const row = await getWorkflowRunRow(first.id);
    const resumed = await wf.resumeWorkflow(edited, {
      id: row!.id,
      workflowName: row!.workflowName,
      status: row!.status,
      input: row!.input,
      cursor: row!.cursor,
      definitionHash: row!.definitionHash,
      projectId: row!.projectId,
      userId: row!.userId,
      startedAt: row!.startedAt,
    });

    expect(resumed.status).toBe("error");
    expect(resumed.result?.error).toMatchObject({ code: "definition-changed" });
    // The refusal must be actionable, not a bare "changed".
    expect(String((resumed.result?.error as { message: string }).message)).toContain("drifts");
    // And it is RECORDED — a fail-closed decision left only in memory
    // would leave the row `suspended` and the daemon retrying forever.
    const after = await getWorkflowRunRow(first.id);
    expect(after?.status).toBe("error");
  });

  test("resume refuses a run that is not suspended", async () => {
    const { wf } = suspendingExecutor("none");
    const def: WorkflowDefinition = {
      name: "already-done",
      description: "",
      steps: [{ name: "a", kind: "transform", output: { v: "1" } }],
    };
    const done = await wf.runWorkflow(def, {}, undefined, undefined);
    expect(done.status).toBe("success");

    const row = await getWorkflowRunRow(done.id);
    const resumed = await wf.resumeWorkflow(def, {
      id: row!.id,
      workflowName: row!.workflowName,
      status: row!.status,
      input: row!.input,
      cursor: row!.cursor,
      definitionHash: row!.definitionHash,
      projectId: row!.projectId,
      userId: row!.userId,
      startedAt: row!.startedAt,
    });
    expect(resumed.status).toBe("error");
    expect(resumed.result?.error).toMatchObject({ code: "not-resumable" });
  });

  test("resume fails closed when a completed step's output is gone", async () => {
    const { wf } = suspendingExecutor("gate__ask", { parkOnce: true });
    const def: WorkflowDefinition = {
      name: "lost-output",
      description: "",
      steps: [
        { name: "prep", kind: "transform", output: { v: "1" } },
        { name: "ask", kind: "tool", tool: "gate__ask" },
      ],
    };
    const first = await wf.runWorkflow(def, {}, undefined, undefined);
    expect(first.status).toBe("suspended");

    // Exactly what a swallowed `persistWrite` leaves behind: the cursor
    // says the step completed, the output never landed.
    await db.execute(sql`
      UPDATE workflow_step_runs SET output = NULL
       WHERE workflow_run_id = ${first.id} AND step_name = 'prep'
    `);

    const row = await getWorkflowRunRow(first.id);
    const resumed = await wf.resumeWorkflow(def, {
      id: row!.id,
      workflowName: row!.workflowName,
      status: row!.status,
      input: row!.input,
      cursor: row!.cursor,
      definitionHash: row!.definitionHash,
      projectId: row!.projectId,
      userId: row!.userId,
      startedAt: row!.startedAt,
    });

    // Resuming would run the rest of the graph against a different
    // `$steps` than the first half saw — a silent wrong answer.
    expect(resumed.status).toBe("error");
    expect(resumed.result?.error).toMatchObject({ code: "step-output-unavailable" });

    // THE assertion that matters: the refusal reached the ROW, not just
    // the return value. A fail-closed decision recorded by a write that
    // does not land is not fail-closed — the row would stay `suspended`
    // and a daemon would retry this same refusal forever while every
    // visible signal said the guard was working.
    const after = await getWorkflowRunRow(first.id);
    expect(after?.status).toBe("error");
    expect(after?.status).not.toBe("suspended");
  });

  test("a step recorded complete with no persisted output refuses resume, never rehydrates empty", async () => {
    // THE CROSS-FILE PAIRING, named for the property rather than the
    // scenario so a future lenient loader fails loudly here.
    //
    // The executor appends to `cursor.completedSteps` the instant a step
    // succeeds — before it issues the `output` write, which is
    // fire-and-forget and never-throwing. So this state is reachable in
    // production, and it is constructed here by forcing exactly it
    // rather than by mocking the refusal.
    //
    // Two halves, both asserted: the cursor SAYS the step completed, and
    // the loader REFUSES rather than returning a map without it. If the
    // loader were ever relaxed to skip the step instead, resume would
    // run the rest of the graph against a `$steps` missing a value the
    // first half of the run had — silently.
    const { wf } = suspendingExecutor("gate__ask", { parkOnce: true });
    const def: WorkflowDefinition = {
      name: "pairing-property",
      description: "",
      steps: [
        { name: "prep", kind: "transform", output: { v: "1" } },
        { name: "ask", kind: "tool", tool: "gate__ask" },
      ],
    };
    const first = await wf.runWorkflow(def, {}, undefined, undefined);
    expect(first.status).toBe("suspended");

    const parked = await getWorkflowRunRow(first.id);
    // Half one: the cursor claims `prep` is done.
    expect(parked?.cursor?.completedSteps).toContain("prep");

    // Now lose its output, exactly as a swallowed write would.
    await db.execute(sql`
      UPDATE workflow_step_runs SET output = NULL
       WHERE workflow_run_id = ${first.id} AND step_name = 'prep'
    `);

    // Half two: the loader refuses outright. NOT an empty map, NOT a map
    // missing `prep` — a named refusal.
    const loaded = await loadStepResults(first.id);
    expect(loaded.ok).toBe(false);
    if (loaded.ok) throw new Error("loader went lenient — the pairing is broken");
    expect(loaded.reason).toContain('step "prep"');
  });

  test("a refusal never clobbers a run that already reached a terminal state", async () => {
    // The other half of the widened CAS: `suspended` was added to the
    // finalize predicate, and that must not weaken the guarantee that an
    // already-terminal run is never rewritten.
    const { wf } = suspendingExecutor("none");
    const def: WorkflowDefinition = {
      name: "terminal-stays-terminal",
      description: "",
      steps: [{ name: "a", kind: "transform", output: { v: "1" } }],
    };
    const done = await wf.runWorkflow(def, {}, undefined, undefined);
    expect(done.status).toBe("success");

    const row = await getWorkflowRunRow(done.id);
    await wf.resumeWorkflow(def, {
      id: row!.id,
      workflowName: row!.workflowName,
      status: row!.status,
      input: row!.input,
      cursor: row!.cursor,
      definitionHash: row!.definitionHash,
      projectId: row!.projectId,
      userId: row!.userId,
      startedAt: row!.startedAt,
    });

    // Zero-row no-op: the successful run keeps its result.
    const after = await getWorkflowRunRow(done.id);
    expect(after?.status).toBe("success");
    expect(after?.result).toEqual({ success: true, output: { v: "1" } });
  });
});

// ── The `approval` step kind (C4 build-order step 7a) ─────────────
//
// Parking only. The answer surfaces and the chokepoint land in 7b/7c —
// here an answer is written straight to the row, which is exactly what
// `answerApproval()` will do once it exists.
describe("approval step kind", () => {
  function approvalExecutor() {
    const bus = new EventBus<AgentEvents>();
    const agentExec = new AgentExecutor(loadAgentsStatic([]), bus);
    return new WorkflowExecutor(agentExec, bus, { persist: true });
  }

  const gateDef = (extra: Partial<WorkflowStep> = {}): WorkflowDefinition => ({
    name: `approval-${crypto.randomUUID().slice(0, 8)}`,
    description: "",
    steps: [
      { name: "prep", kind: "transform", output: { asks: "$input.asks" } },
      {
        name: "gate",
        kind: "approval",
        prompt: "Ship it?",
        choices: ["approve", "reject"],
        ...extra,
      } as WorkflowStep,
    ],
  });

  test("parks the run and records the question", async () => {
    const wf = approvalExecutor();
    const def = gateDef();
    const run = await wf.runWorkflow(def, {}, undefined, undefined);

    expect(run.status).toBe("suspended");
    const row = await getWorkflowRunRow(run.id);
    expect(row?.suspendedReason).toBe("approval");

    const approval = await getWorkflowApproval(run.id, "gate");
    expect(approval?.status).toBe("pending");
    expect(approval?.prompt).toBe("Ship it?");
    expect(approval?.choices).toEqual(["approve", "reject"]);
    // Nothing decided yet — a half-populated answer would be read as one.
    expect(approval?.answerChoice).toBeNull();
    expect(approval?.answeredBy).toBeNull();
  });

  test("the answer becomes the step result under a FIXED shape", async () => {
    const wf = approvalExecutor();
    const def = gateDef();
    const first = await wf.runWorkflow(def, {}, undefined, undefined);
    expect(first.status).toBe("suspended");

    const approval = await getWorkflowApproval(first.id, "gate");
    await recordWorkflowApprovalAnswer(approval!.id, {
      choice: "approve",
      answeredBy: "user-1",
    });

    const row = await getWorkflowRunRow(first.id);
    const resumed = await wf.resumeWorkflow(def, {
      id: row!.id,
      workflowName: row!.workflowName,
      status: row!.status,
      input: row!.input,
      cursor: row!.cursor,
      definitionHash: row!.definitionHash,
      projectId: row!.projectId,
      userId: row!.userId,
      startedAt: row!.startedAt,
    });

    expect(resumed.status).toBe("success");
    const loaded = await loadStepResults(first.id);
    if (!loaded.ok) throw new Error(loaded.reason);
    const output = loaded.stepResults.get("gate")?.output as Record<string, unknown>;
    expect(output.choice).toBe("approve");
    expect(output.answeredBy).toBe("user-1");
    // FIXED shape: `form` and `itemIds` are present-and-empty, never
    // absent. `workflow-refs` resolves strictly, so a downstream
    // `$steps.gate.output.form` must not throw just because this answer
    // carried no form.
    expect(output.form).toEqual({});
    expect(output.itemIds).toEqual([]);
    expect(typeof output.answeredAt).toBe("string");
  });

  test("resolves itemIds at SUSPEND time from what the run produced", async () => {
    // Not at definition time from what its author hoped for — that is
    // what makes the consent guard check answers against reality.
    const wf = approvalExecutor();
    const def = gateDef({ requireItemConsent: true, itemsRef: "$steps.prep.output.asks" });
    const run = await wf.runWorkflow(def, { asks: ["a1", "a2"] }, undefined, undefined);

    expect(run.status).toBe("suspended");
    const approval = await getWorkflowApproval(run.id, "gate");
    expect(approval?.requireItemConsent).toBe(true);
    expect(approval?.itemIds).toEqual(["a1", "a2"]);
  });

  test("an unresolvable itemsRef yields an EMPTY set, never a permanent park", async () => {
    // The tolerant direction is deliberate: treating an unresolvable ref
    // as "everything" would manufacture consent requirements the run
    // cannot satisfy and park the workflow forever.
    const wf = approvalExecutor();
    const def = gateDef({ requireItemConsent: true, itemsRef: "$steps.nope.output.x" });
    const run = await wf.runWorkflow(def, {}, undefined, undefined);

    expect(run.status).toBe("suspended");
    const approval = await getWorkflowApproval(run.id, "gate");
    expect(approval?.itemIds).toEqual([]);
  });

  test("re-parking clears the previous answer rather than reusing it", async () => {
    // A step that was answered, resumed and parked again is asking a
    // FRESH question; leaving the old answer would let the next resume
    // read a decision nobody made this time.
    const wf = approvalExecutor();
    const def = gateDef();
    const run = await wf.runWorkflow(def, {}, undefined, undefined);
    const approval = await getWorkflowApproval(run.id, "gate");
    await recordWorkflowApprovalAnswer(approval!.id, { choice: "approve", answeredBy: "user-1" });

    await parkWorkflowApproval({
      workflowRunId: run.id,
      stepName: "gate",
      prompt: "Ship it?",
      choices: ["approve", "reject"],
      requireItemConsent: false,
      itemIds: [],
    });

    const reparked = await getWorkflowApproval(run.id, "gate");
    expect(reparked?.status).toBe("pending");
    expect(reparked?.answerChoice).toBeNull();
    expect(reparked?.answeredBy).toBeNull();
    expect(reparked?.consentAllUsed).toBe(false);
    // Same row, updated in place — not a second row the inbox would
    // render twice.
    expect(reparked?.id).toBe(approval!.id);
  });

  test("two answers race to exactly one winner", async () => {
    const wf = approvalExecutor();
    const run = await wf.runWorkflow(gateDef(), {}, undefined, undefined);
    const approval = await getWorkflowApproval(run.id, "gate");

    const [a, b] = await Promise.all([
      recordWorkflowApprovalAnswer(approval!.id, { choice: "approve", answeredBy: "user-1" }),
      recordWorkflowApprovalAnswer(approval!.id, { choice: "reject", answeredBy: "user-1" }),
    ]);
    // The loser is a clean zero-row no-op, not an overwrite and not an
    // error.
    expect(a + b).toBe(1);
    expect((await getWorkflowApproval(run.id, "gate"))?.status).toBe("answered");
  });

  test("an approval step fails loudly without persistence rather than hanging", async () => {
    // With no row to park in, nothing could ever answer it — so a
    // DB-less harness must not silently wait forever.
    const bus = new EventBus<AgentEvents>();
    const wf = new WorkflowExecutor(new AgentExecutor(loadAgentsStatic([]), bus), bus, {
      persist: false,
    });
    const run = await wf.runWorkflow(gateDef(), {}, undefined, undefined);
    expect(run.status).toBe("error");
    expect(String(run.result?.error)).toContain("requires run persistence");
  });
});

describe("workflow-approvals query layer", () => {
  async function seedApproval(overrides: Partial<ParkApprovalInput> = {}) {
    const runId = crypto.randomUUID();
    await insertWorkflowRun({
      id: runId,
      workflowName: "approval-queries",
      input: {},
      startedAt: new Date(),
    });
    const id = await parkWorkflowApproval({
      workflowRunId: runId,
      stepName: "gate",
      prompt: "?",
      choices: ["yes"],
      requireItemConsent: false,
      itemIds: [],
      ...overrides,
    });
    return { runId, id };
  }

  test("getWorkflowApprovalById reads the row the answer surfaces will act on", async () => {
    const { id } = await seedApproval();
    expect((await getWorkflowApprovalById(id))?.id).toBe(id);
    expect(await getWorkflowApprovalById(crypto.randomUUID())).toBeUndefined();
  });

  test("getWorkflowApproval returns undefined for a step that never parked", async () => {
    const { runId } = await seedApproval();
    expect(await getWorkflowApproval(runId, "never-parked")).toBeUndefined();
  });

  test("the expiry sweep selects on the INJECTED clock, not the wall clock", async () => {
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 3_600_000);
    const expired = await seedApproval({ expiresAt: past });
    const live = await seedApproval({ expiresAt: future });
    await seedApproval(); // no expiry at all — never swept

    const due = await listExpiredWorkflowApprovals(new Date());
    const dueIds = due.map((r) => r.id);
    expect(dueIds).toContain(expired.id);
    expect(dueIds).not.toContain(live.id);

    // Wind the injected clock forward and the live one becomes due —
    // proving the predicate reads the parameter, not `Date.now()`.
    const later = await listExpiredWorkflowApprovals(new Date(Date.now() + 7_200_000));
    expect(later.map((r) => r.id)).toContain(live.id);
  });

  test("expiring is a CAS — a human who answers first wins", async () => {
    const { id } = await seedApproval({ expiresAt: new Date(Date.now() - 1000) });
    expect(await recordWorkflowApprovalAnswer(id, { choice: "yes" })).toBe(1);
    // The sweep now finds nothing to expire: the clock must not overwrite
    // a decision a human already made.
    expect(await expireWorkflowApproval(id)).toBe(0);
    expect((await getWorkflowApprovalById(id))?.status).toBe("answered");
  });

  test("expiring a still-pending approval transitions it once", async () => {
    const { id } = await seedApproval({ expiresAt: new Date(Date.now() - 1000) });
    expect(await expireWorkflowApproval(id)).toBe(1);
    expect((await getWorkflowApprovalById(id))?.status).toBe("expired");
    // Idempotent: a second sweep is a zero-row no-op.
    expect(await expireWorkflowApproval(id)).toBe(0);
  });

  test("the inbox lists only pending approvals", async () => {
    const pending = await seedApproval();
    const answered = await seedApproval();
    await recordWorkflowApprovalAnswer(answered.id, { choice: "yes" });

    const inbox = await listPendingWorkflowApprovals();
    const ids = inbox.map((r) => r.id);
    expect(ids).toContain(pending.id);
    expect(ids).not.toContain(answered.id);
    expect(inbox.every((r) => r.status === "pending")).toBe(true);
  });

  test("an answer records the consent-all audit marker", async () => {
    const { id } = await seedApproval({ requireItemConsent: true, itemIds: ["i1"] });
    await recordWorkflowApprovalAnswer(id, {
      choice: "yes",
      itemIds: ["i1"],
      form: { note: "ok" },
      answeredBy: "user-1",
      consentAllUsed: true,
    });
    const row = await getWorkflowApprovalById(id);
    // A blanket clear is permitted but never silent.
    expect(row?.consentAllUsed).toBe(true);
    expect(row?.answeredItemIds).toEqual(["i1"]);
    expect(row?.answerForm).toEqual({ note: "ok" });
  });
});
