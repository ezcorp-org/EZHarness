/**
 * Reading a workflow run's trace, authorized.
 *
 * The read counterpart of `workflow-run-control.ts`, and deliberately in
 * `src/` rather than in the route: a route physically cannot authorize
 * this — the ownership rule has to sit with the query so every surface
 * asks the same question. Same reasoning as `workflow-scope.ts`.
 *
 * ## Unauthorized is 404, never 403
 *
 * A 403 confirms the run exists, which turns the endpoint into an
 * existence oracle for run ids the caller may not see. Run ids are UUIDs
 * so that is a weak oracle, but a trace carries `resolved_input` and
 * `output` and the cost of being wrong here is a credential, so it fails
 * closed and indistinguishably.
 *
 * This is the OPPOSITE reading from `cancelParkedRun`, which returns 403,
 * and the difference is deliberate: by the time a caller cancels a run
 * they have already been told it exists. `denialStatus` in
 * `workflow-scope.ts` draws the same read/edit line for workflows.
 *
 * ## Redaction is a floor, not a guarantee
 *
 * `resolved_input` and `output` are scrubbed by `redactSecretsDeep` on the
 * way in, but that is a deliberately loose regex pass — it catches
 * credential SHAPES, not credentials. So the authorization here is the
 * real control and the redaction is defence in depth, not the other way
 * round. That is why this rule is the narrowest one the schema can
 * express rather than the most convenient.
 */
import {
  getWorkflowRunRow,
  listWorkflowStepRunRows,
  listWorkflowRunsPage,
  type WorkflowRunPage,
} from "../db/queries/workflow-runs";
import { listWorkflowStepIterations } from "../db/queries/workflow-step-iterations";
import { mayControlRun, type RunActor } from "./workflow-run-control";
import type { WorkflowRunStatus } from "../types";

/** Default page size for the run list, and the cap a caller may ask for. */
export const RUN_PAGE_DEFAULT = 50;
export const RUN_PAGE_MAX = 200;

/** One row of the run list. Deliberately NOT the whole run: the list must
 *  not carry `input`, which is the same untrusted payload surface the
 *  trace redacts. A caller who wants it opens the run. */
export interface WorkflowRunSummary {
  id: string;
  workflowName: string;
  status: WorkflowRunStatus;
  projectId: string | null;
  userId: string | null;
  startedAt: string;
  finishedAt: string | null;
  suspendedReason: string | null;
  resumable: boolean;
  jobRef: string | null;
}

/** One step of a trace, with its per-iteration detail attached. */
export interface WorkflowTraceStep {
  stepName: string;
  status: WorkflowRunStatus;
  runId: string | null;
  provider: string | null;
  model: string | null;
  attempt: number | null;
  iterations: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Always null in this phase — there is no host-side price table, so
   *  nothing can compute a cost honestly. The trace renders "—". */
  costUsd: string | null;
  durationMs: number | null;
  errorCode: string | null;
  skippedReason: string | null;
  resolvedInput: unknown;
  output: unknown;
  startedAt: string;
  updatedAt: string;
  iterationRows: WorkflowTraceIteration[];
}

export interface WorkflowTraceIteration {
  iteration: number;
  attempt: number;
  status: WorkflowRunStatus;
  runId: string | null;
  provider: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: string | null;
  durationMs: number | null;
  errorCode: string | null;
}

export interface WorkflowRunTrace {
  run: WorkflowRunSummary & {
    definitionHash: string | null;
    definitionVersionId: string | null;
    runPhase: string;
    idempotencyKey: string | null;
    result: unknown;
  };
  steps: WorkflowTraceStep[];
  /**
   * Per-run rollups, COMPUTED at read time and never stored.
   *
   * A stored rollup drifts the moment a step row is corrected, and the row
   * counts here are small enough that summing them costs nothing. `null`
   * rather than 0 when no step reported anything, so the trace can say
   * "not reported" instead of claiming the run was free.
   */
  totals: {
    inputTokens: number | null;
    outputTokens: number | null;
    durationMs: number | null;
    steps: number;
  };
}

/** Sum a column across steps, preserving "nothing reported" as null. */
function sumOrNull(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null);
  return present.length === 0 ? null : present.reduce((a, b) => a + b, 0);
}

/**
 * One run's full trace, or `undefined` when the caller may not see it —
 * which is the SAME answer they get for a run that does not exist.
 *
 * The two cases are merged on purpose. Returning a distinguishable
 * "forbidden" here would defeat the whole reason this returns 404.
 */
export async function getWorkflowRunTrace(
  runId: string,
  actor: RunActor,
): Promise<WorkflowRunTrace | undefined> {
  const row = await getWorkflowRunRow(runId);
  if (!row) return undefined;
  // A run with `user_id IS NULL` (CLI, extension-triggered) has no owner
  // to compare against, so it is admin-only. Reading "unowned" as
  // "anyone's" would expose every scheduled run's payload to every member.
  if (!mayControlRun(row.userId, actor)) return undefined;

  const [stepRows, iterationRows] = await Promise.all([
    listWorkflowStepRunRows(runId),
    listWorkflowStepIterations(runId),
  ]);

  const byStep = new Map<string, WorkflowTraceIteration[]>();
  for (const it of iterationRows) {
    const list = byStep.get(it.stepName) ?? [];
    list.push({
      iteration: it.iteration,
      attempt: it.attempt,
      status: it.status,
      runId: it.runId,
      provider: it.provider,
      model: it.model,
      inputTokens: it.inputTokens,
      outputTokens: it.outputTokens,
      costUsd: it.costUsd,
      durationMs: it.durationMs,
      errorCode: it.errorCode,
    });
    byStep.set(it.stepName, list);
  }

  const steps: WorkflowTraceStep[] = stepRows
    .map((s) => ({
      stepName: s.stepName,
      status: s.status,
      runId: s.runId,
      provider: s.provider,
      model: s.model,
      attempt: s.attempt,
      iterations: s.iterations,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      costUsd: s.costUsd,
      durationMs: s.durationMs,
      errorCode: s.errorCode,
      skippedReason: s.skippedReason,
      resolvedInput: s.resolvedInput ?? null,
      output: s.output ?? null,
      startedAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
      iterationRows: byStep.get(s.stepName) ?? [],
    }))
    // Creation order is execution order — the executor writes a step's
    // "running" row before dispatching it — and it is the only order the
    // trace can reconstruct without re-reading the definition, which may
    // since have been edited or deleted.
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.stepName.localeCompare(b.stepName));

  return {
    run: {
      ...summarize(row),
      definitionHash: row.definitionHash,
      definitionVersionId: row.definitionVersionId,
      runPhase: row.runPhase,
      idempotencyKey: row.idempotencyKey,
      result: row.result ?? null,
    },
    steps,
    totals: {
      inputTokens: sumOrNull(steps.map((s) => s.inputTokens)),
      outputTokens: sumOrNull(steps.map((s) => s.outputTokens)),
      durationMs: sumOrNull(steps.map((s) => s.durationMs)),
      steps: steps.length,
    },
  };
}

function summarize(row: Awaited<ReturnType<typeof getWorkflowRunRow>> & object): WorkflowRunSummary {
  return {
    id: row.id,
    workflowName: row.workflowName,
    status: row.status,
    projectId: row.projectId,
    userId: row.userId,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
    suspendedReason: row.suspendedReason,
    resumable: row.resumable,
    jobRef: row.jobRef,
  };
}

export interface ListRunsQuery {
  workflowName?: string;
  status?: WorkflowRunStatus;
  projectId?: string;
  since?: Date;
  until?: Date;
  cursor?: { startedAt: Date; id: string };
  limit?: number;
}

/**
 * The run list, scoped to what the caller may see.
 *
 * **Scoped in the QUERY, not by filtering afterwards.** Post-filtering a
 * page would return short pages (and eventually empty ones with a cursor
 * still pointing forward), which reads to the client as "no more runs"
 * while runs remain. Pushing `user_id` into the WHERE keeps the page size
 * meaningful.
 *
 * A non-admin sees only runs they initiated. That is narrower than "runs
 * of workflows they can see", and deliberately so — see `mayControlRun`.
 */
export async function listWorkflowRunsForCaller(
  q: ListRunsQuery,
  actor: RunActor,
): Promise<{ runs: WorkflowRunSummary[]; nextCursor?: WorkflowRunPage["nextCursor"] }> {
  const limit = Math.min(Math.max(q.limit ?? RUN_PAGE_DEFAULT, 1), RUN_PAGE_MAX);
  const page = await listWorkflowRunsPage({
    ...q,
    limit,
    ...(actor.isAdmin === true ? {} : { userId: actor.userId }),
  });
  return {
    runs: page.runs.map(summarize),
    ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
  };
}
