/**
 * Persistence for workflow run history (`workflow_runs` +
 * `workflow_step_runs`).
 *
 * The agent-side twin of this module is `queries/runs.ts`. Its docblock
 * for `finalizeRunRow` records a scar worth not repeating: for a long
 * time the `runs` mirror had no idempotent finalizer and no boot
 * reconciliation, so every abnormal termination (watchdog kill, OOM,
 * container restart) left a row stuck at `status='running',
 * finished_at=NULL` forever, and the backlog could only be drained by
 * hand. Workflows ship with both from day one:
 *   • {@link finalizeWorkflowRunRow} — idempotent CAS on `status='running'`
 *   • {@link terminalizeOrphanedWorkflowRuns} — boot sweep
 */
import { and, eq, lt, sql } from "drizzle-orm";
import { getDb } from "../connection";
import { workflowRuns, workflowStepRuns } from "../schema";
import type { AgentResult, WorkflowRunStatus } from "../../types";

/**
 * Terminal statuses a workflow run may be finalized into.
 *
 * `awaiting_approval` is terminal FOR THIS PROCESS — the run stopped and
 * will not resume on its own — but it deliberately reads as neither
 * success nor failure: the graph ran everything it could and then hit a
 * step that needs a human. It must never be reported as `success`.
 */
export type TerminalWorkflowRunStatus =
  | "success"
  | "error"
  | "cancelled"
  | "awaiting_approval";

export interface NewWorkflowRunInput {
  /** The executor's already-minted run id. Never generated here. */
  id: string;
  workflowName: string;
  /** `workflow_definitions.id`, or null for a YAML-defined workflow. */
  workflowDefinitionId?: string | null;
  projectId?: string | null;
  userId?: string | null;
  input: Record<string, unknown>;
  startedAt: Date;
}

/**
 * Insert the `running` row for a freshly-started workflow run.
 *
 * `id` is supplied by the caller (the executor mints it before emitting
 * `workflow:start`); this function never invents one — see the schema
 * comment on `workflowRuns.id` for why a `$defaultFn` would be a bug.
 */
export async function insertWorkflowRun(row: NewWorkflowRunInput): Promise<void> {
  await getDb().insert(workflowRuns).values({
    id: row.id,
    workflowName: row.workflowName,
    workflowDefinitionId: row.workflowDefinitionId ?? null,
    projectId: row.projectId ?? null,
    userId: row.userId ?? null,
    status: "running",
    input: row.input,
    startedAt: row.startedAt,
  });
}

export interface WorkflowStepRunUpsert {
  workflowRunId: string;
  stepName: string;
  /** In-memory `WorkflowStepRun.runId`. `""` (transform/gate/tool) maps
   *  to SQL NULL — an empty string would violate the runs FK. */
  runId: string;
  status: WorkflowRunStatus;
  iterations?: number;
}

/**
 * Write (or update) one step's row.
 *
 * Called once when the step starts and again on every status /
 * iteration change, so it upserts on the `(workflow_run_id, step_name)`
 * unique index. Step names are unique within a definition (the validator
 * rejects duplicates), which is what makes that a sound arbiter.
 */
export async function upsertWorkflowStepRun(
  row: WorkflowStepRunUpsert,
): Promise<void> {
  const runId = row.runId === "" ? null : row.runId;
  const iterations = row.iterations ?? null;
  await getDb()
    .insert(workflowStepRuns)
    .values({
      workflowRunId: row.workflowRunId,
      stepName: row.stepName,
      runId,
      status: row.status,
      iterations,
    })
    .onConflictDoUpdate({
      target: [workflowStepRuns.workflowRunId, workflowStepRuns.stepName],
      set: { runId, status: row.status, iterations, updatedAt: sql`NOW()` },
    });
}

/**
 * Terminalize a workflow run row.
 *
 * Idempotent + race-safe: the WHERE clause only matches a row still at
 * `status='running'`. A second call (retry, boot sweep racing a
 * late-finishing run) is a zero-row no-op and can never clobber a richer
 * terminal state that was already recorded.
 *
 * Returns the number of rows transitioned (0 or 1).
 */
export async function finalizeWorkflowRunRow(
  workflowRunId: string,
  status: TerminalWorkflowRunStatus,
  result?: AgentResult,
): Promise<number> {
  const rows = await getDb()
    .update(workflowRuns)
    .set({
      status,
      finishedAt: sql`NOW()`,
      ...(result !== undefined ? { result } : {}),
    })
    .where(and(eq(workflowRuns.id, workflowRunId), eq(workflowRuns.status, "running")))
    .returning({ id: workflowRuns.id });
  return rows.length;
}

/**
 * Boot-time reconciliation: terminalize every `workflow_runs` row left at
 * `status='running'` by a previous process.
 *
 * A freshly-started process owns zero in-flight workflow runs — they are
 * awaited in-memory and never resumed — so by definition any row still
 * `running` when this process started is orphaned by a crash / OOM kill /
 * restart that skipped the finalizer.
 *
 * `startedBefore` is what makes that "when this process started" precise,
 * and it is load-bearing, not defensive. The caller fires this
 * fire-and-forget during boot, so its UPDATE can still be in flight when
 * the first request arrives. Without the cutoff the sweep matched on
 * `status='running'` alone and would terminalize a run that had just
 * STARTED — the live run's real outcome then lost its finalize CAS
 * (`WHERE status='running'` matches nothing) and the row was left
 * permanently claiming the run was orphaned. The default is evaluated
 * when the function is CALLED, which is inside boot and therefore before
 * any request can insert a row.
 *
 * Note the predicate is `status='running'` alone (plus the cutoff), NOT
 * `AND finished_at IS NULL`. A row with a stamped `finished_at` but a
 * status never moved off `running` is exactly the half-written state this
 * sweep exists to clean up; the extra conjunct silently skipped it and
 * left it stuck forever.
 *
 * Marked `error` (not `cancelled`) to match the discriminator the agent
 * side already uses for the same situation — no new status value.
 *
 * Returns the number of rows drained.
 */
export async function terminalizeOrphanedWorkflowRuns(
  startedBefore: Date = new Date(),
): Promise<number> {
  const rows = await getDb()
    .update(workflowRuns)
    .set({
      status: "error",
      finishedAt: sql`NOW()`,
      result: {
        success: false,
        output: null,
        error: "Workflow run orphaned: process restarted while the run was active",
      },
    })
    .where(and(eq(workflowRuns.status, "running"), lt(workflowRuns.startedAt, startedBefore)))
    .returning({ id: workflowRuns.id });
  return rows.length;
}

/** Read one workflow run row by id (undefined when absent). */
export async function getWorkflowRunRow(
  id: string,
): Promise<typeof workflowRuns.$inferSelect | undefined> {
  const rows = await getDb().select().from(workflowRuns).where(eq(workflowRuns.id, id));
  return rows[0];
}

/** Read a run's step rows. Order is unspecified — callers that care sort
 *  by the definition's step order, which is the only meaningful one. */
export async function listWorkflowStepRunRows(
  workflowRunId: string,
): Promise<Array<typeof workflowStepRuns.$inferSelect>> {
  return getDb()
    .select()
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, workflowRunId));
}
