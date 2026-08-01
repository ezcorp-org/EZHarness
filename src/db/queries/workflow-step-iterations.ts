/**
 * Per-iteration detail for a looped workflow step
 * (`workflow_step_iterations`).
 *
 * The parent `workflow_step_runs` row upserts on
 * `(workflow_run_id, step_name)`, so a looped step has exactly ONE row
 * there and per-iteration facts have nowhere to live on it. This table is
 * that detail; see the schema comment for why the arbiter was not widened
 * instead.
 *
 * ## The parent id is resolved in SQL, never carried
 *
 * The executor writes the parent row fire-and-forget (`void
 * persistWrite(...)`) and deliberately does not await it — awaiting there
 * would turn `$prev` into a per-step value and silently change the
 * semantics of every existing workflow. So the executor does not HOLD the
 * parent's id when a loop iteration finishes, and threading it back would
 * mean awaiting the very write that must not be awaited.
 *
 * {@link upsertWorkflowStepIteration} therefore looks it up by the same
 * unique pair before inserting. If the parent has genuinely not landed
 * yet the function writes no row and says so — reported to the caller
 * rather than swallowed, because a silent gap in a trace is worse than a
 * logged one.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "../connection";
import { workflowStepIterations, workflowStepRuns } from "../schema";
import type { WorkflowRunStatus } from "../../types";
import { stepCostUsd } from "../../runtime/workflow-step-cost";

export interface WorkflowStepIterationUpsert {
  workflowRunId: string;
  stepName: string;
  /** 1-based, matching what `$loop.iteration` saw inside the step. */
  iteration: number;
  /** Retry attempt within this iteration; 0 for the first try. */
  attempt: number;
  status: WorkflowRunStatus;
  /** In-memory `WorkflowStepRun.runId`. `""` (a transform loop, which
   *  mints no AgentRun) maps to SQL NULL — an empty string would violate
   *  the runs FK. */
  runId?: string;
  /** May differ per iteration: a `$loop.*` model binding is re-resolved
   *  each pass, so a workflow can escalate cheap → strong on the retry. */
  provider?: string;
  model?: string;
  /** Absent persists as SQL NULL, never 0 — see the parent table's
   *  columns for why the distinction is load-bearing. */
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  errorCode?: string;
}

/**
 * Write (or update) one iteration's row.
 *
 * Upserts on `(workflow_step_run_id, iteration, attempt)`: a re-write of
 * the same attempt updates in place, while a RETRY of the same iteration
 * is a distinct row, because a retried iteration is a distinct event and
 * collapsing the two would hide exactly the retry an operator is reading
 * the trace to find.
 *
 * `cost_usd` is DERIVED from this row's own `provider` / `model` / tokens
 * via {@link stepCostUsd}, not passed in — an iteration may resolve a
 * different model than its siblings (a `$loop.*` binding re-resolves each
 * pass), so pricing it from the parent's binding would misprice exactly
 * the escalate-on-retry case the per-iteration table exists to show. NULL
 * means "not measurable", never "free"; same reading as the parent table.
 *
 * Returns `true` iff a row landed. `false` means the parent step row was
 * not yet visible; the caller decides whether that is worth a log line.
 */
export async function upsertWorkflowStepIteration(
  row: WorkflowStepIterationUpsert,
): Promise<boolean> {
  const runId = row.runId === "" || row.runId === undefined ? null : row.runId;
  const provider = row.provider ?? null;
  const model = row.model ?? null;
  const inputTokens = row.inputTokens ?? null;
  const outputTokens = row.outputTokens ?? null;
  const durationMs = row.durationMs ?? null;
  const errorCode = row.errorCode ?? null;
  const costUsd = stepCostUsd(row);

  const parent = await getDb()
    .select({ id: workflowStepRuns.id })
    .from(workflowStepRuns)
    .where(
      and(
        eq(workflowStepRuns.workflowRunId, row.workflowRunId),
        eq(workflowStepRuns.stepName, row.stepName),
      ),
    );
  const workflowStepRunId = parent[0]?.id;
  // Reported, not thrown and not swallowed. The parent write is
  // fire-and-forget by design, so "not visible yet" is a reachable state
  // rather than a bug — but a trace with a hole in it should be a log
  // line somewhere, not a mystery.
  if (workflowStepRunId === undefined) return false;

  await getDb()
    .insert(workflowStepIterations)
    .values({
      workflowStepRunId,
      iteration: row.iteration,
      attempt: row.attempt,
      status: row.status,
      runId, provider, model, inputTokens, outputTokens, costUsd, durationMs, errorCode,
    })
    .onConflictDoUpdate({
      target: [
        workflowStepIterations.workflowStepRunId,
        workflowStepIterations.iteration,
        workflowStepIterations.attempt,
      ],
      set: {
        status: row.status, runId, provider, model, inputTokens, outputTokens,
        costUsd, durationMs, errorCode,
      },
    });
  return true;
}

/**
 * Every iteration recorded for one run, ordered by
 * `(step, iteration, attempt)` — execution order, and the only order a
 * trace reads them in.
 *
 * Joined through the parent rather than taking step ids, so a caller that
 * has authorized the RUN does not have to re-authorize each step.
 */
export async function listWorkflowStepIterations(
  workflowRunId: string,
): Promise<
  Array<typeof workflowStepIterations.$inferSelect & { stepName: string }>
> {
  const rows = await getDb()
    .select({ iteration: workflowStepIterations, stepName: workflowStepRuns.stepName })
    .from(workflowStepIterations)
    .innerJoin(workflowStepRuns, eq(workflowStepIterations.workflowStepRunId, workflowStepRuns.id))
    .where(eq(workflowStepRuns.workflowRunId, workflowRunId))
    .orderBy(workflowStepRuns.stepName, workflowStepIterations.iteration, workflowStepIterations.attempt);
  return rows.map((r: { iteration: typeof workflowStepIterations.$inferSelect; stepName: string }) => ({
    ...r.iteration,
    stepName: r.stepName,
  }));
}
