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
import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import { getDb } from "../connection";
import { workflowRuns, workflowStepRuns, type TruncatedStepOutput } from "../schema";
import type { AgentResult, WorkflowCursor, WorkflowRunStatus } from "../../types";
import {
  isTruncatedStepOutput,
  MAX_STEP_OUTPUT_BYTES,
} from "../../runtime/workflow-step-output";

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
  /** Fingerprint of the definition this run started against, so a resume
   *  can refuse to continue into an edited graph. Absent for a caller
   *  that does not persist one. This is the drift guard that actually
   *  fires — C4's resume compares it unconditionally, whatever
   *  `definitionVersionId` says. */
  definitionHash?: string | null;
  /**
   * The exact `workflow_definition_versions` row this run executed — set
   * only when the graph the run was handed matches that version's own
   * `steps_hash`, so it never names a snapshot the run did not execute.
   *
   * Null for a YAML/extension workflow (no definition row to version), a
   * run created before versioning existed, or a graph whose content did
   * not match the row's newest version. When it IS set, `definitionHash`
   * is the SAME version row's hash, so the two cannot disagree with each
   * other.
   *
   * Intended to be authoritative over `definitionHash`; that precedence is
   * a contract no code implements yet, stated once in
   * `workflow-versions.ts`.
   */
  definitionVersionId?: string | null;
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
    definitionHash: row.definitionHash ?? null,
    definitionVersionId: row.definitionVersionId ?? null,
  });
}

/**
 * Mark the run as having a batch IN FLIGHT, before that batch dispatches.
 *
 * This is half of the honest bookkeeping crash recovery reads. While this
 * value stands, an LLM call or a side-effecting `tool` dispatch may be
 * half-applied, so a crash here must never be resumed — recovery fails it
 * closed instead of re-entering a half-executed step.
 *
 * Throws on failure, unlike the telemetry writes. See
 * {@link advanceWorkflowRunCursor} for why.
 */
export async function markWorkflowRunInBatch(workflowRunId: string): Promise<void> {
  await getDb()
    .update(workflowRuns)
    .set({ runPhase: "in-batch" })
    .where(eq(workflowRuns.id, workflowRunId));
}

/**
 * Record that a batch completed: advance the cursor and return the run to
 * `boundary`, where it is safe to resume.
 *
 * **Throws on failure, deliberately.** Every other write in this module
 * is best-effort telemetry, where a DB glitch must not fail a run that
 * otherwise succeeded. A cursor is not telemetry: silently dropping this
 * write leaves the next resume pointing at a STALE `batchIndex`, so it
 * re-executes a batch that already ran — duplicate side effects, an
 * LLM call re-billed, a `write_file` applied twice. Failing the run loudly
 * is strictly better than resuming it wrongly.
 */
export async function advanceWorkflowRunCursor(
  workflowRunId: string,
  cursor: WorkflowCursor,
): Promise<void> {
  await getDb()
    .update(workflowRuns)
    .set({ cursor, runPhase: "boundary" })
    .where(eq(workflowRuns.id, workflowRunId));
}

export interface WorkflowStepRunUpsert {
  workflowRunId: string;
  stepName: string;
  /** In-memory `WorkflowStepRun.runId`. `""` (transform/gate/tool) maps
   *  to SQL NULL — an empty string would violate the runs FK. */
  runId: string;
  status: WorkflowRunStatus;
  iterations?: number;
  /** Provider / model the step's LLM call RESOLVED to. Absent for a step
   *  that ran no LLM, and for the "running" write that happens before the
   *  agent has resolved anything — both persist as SQL NULL. */
  provider?: string;
  model?: string;
  /** The step's result, already redacted and size-checked by
   *  {@link prepareStepOutput}. Absent for the "running" write and for a
   *  step that failed — both persist as SQL NULL, which a resume treats
   *  as "no value to rehydrate" and fails closed on. */
  output?: AgentResult | TruncatedStepOutput;
}

/**
 * Write (or update) one step's row.
 *
 * Called once when the step starts and again on every status /
 * iteration change, so it upserts on the `(workflow_run_id, step_name)`
 * unique index. Step names are unique within a definition (the validator
 * rejects duplicates), which is what makes that a sound arbiter.
 *
 * Every column is written on every call (absent ⇒ NULL) rather than
 * patched: the caller passes the step run's CURRENT state each time, so a
 * later write carrying a resolved model overwrites the earlier NULL, and
 * there is no half-updated row to reason about.
 */
export async function upsertWorkflowStepRun(
  row: WorkflowStepRunUpsert,
): Promise<void> {
  const runId = row.runId === "" ? null : row.runId;
  const iterations = row.iterations ?? null;
  const provider = row.provider ?? null;
  const model = row.model ?? null;
  const output = row.output ?? null;
  await getDb()
    .insert(workflowStepRuns)
    .values({
      workflowRunId: row.workflowRunId,
      stepName: row.stepName,
      runId,
      status: row.status,
      iterations,
      provider,
      model,
      output,
    })
    .onConflictDoUpdate({
      target: [workflowStepRuns.workflowRunId, workflowStepRuns.stepName],
      set: { runId, status: row.status, iterations, provider, model, output, updatedAt: sql`NOW()` },
    });
}

/**
 * Rebuild a run's `stepResults` map from its persisted step rows, so a
 * resumed run sees exactly the `$steps.<name>` values the original
 * process saw.
 *
 * **Fails closed, and that is the whole point.** Only `success` steps
 * contribute. A successful step whose `output` is NULL (the write was
 * swallowed by the never-throw persistence contract, or the row predates
 * the column) or is the truncation sentinel means the value is GONE — and
 * resuming without it would run the rest of the graph against a
 * different `$steps` than the first half saw. That is a silent
 * wrong-answer bug, strictly worse than refusing to resume, so the
 * refusal names the step and the reason instead.
 */
export async function loadStepResults(
  workflowRunId: string,
): Promise<
  | { ok: true; stepResults: Map<string, AgentResult> }
  | { ok: false; reason: string }
> {
  const rows = await listWorkflowStepRunRows(workflowRunId);
  const stepResults = new Map<string, AgentResult>();
  for (const row of rows) {
    if (row.status !== "success") continue;
    if (row.output === null || row.output === undefined) {
      return {
        ok: false,
        reason:
          `step "${row.stepName}" completed but its output was not persisted, ` +
          `so $steps."${row.stepName}" cannot be restored`,
      };
    }
    if (isTruncatedStepOutput(row.output)) {
      return {
        ok: false,
        reason:
          `step "${row.stepName}" produced ${row.output.bytes} bytes of output, ` +
          `over the ${MAX_STEP_OUTPUT_BYTES}-byte cap, so $steps."${row.stepName}" ` +
          `cannot be restored`,
      };
    }
    stepResults.set(row.stepName, row.output);
  }
  return { ok: true, stepResults };
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
 * ## The action branches on `run_phase`; the selection does not
 *
 * A crashed run is not uniformly unsafe, and treating it that way threw
 * away recoverable work. What decides it is which side of a step boundary
 * the executor was on, which it now records honestly:
 *
 *   • `boundary`  — nothing was in flight, the cursor is authoritative.
 *     → `suspended`, `resumable = true`, reason `orphaned-resumable`.
 *     The run keeps its result and gains no `finished_at`, because it is
 *     going to continue rather than end.
 *
 *   • `in-batch`  — an LLM call or a side-effecting `tool` dispatch may
 *     be half-applied. → `error`, `resumable = false`. A restart cannot
 *     safely re-enter a half-executed step, so this fails CLOSED; the
 *     message names the batch index and the steps that were in flight so
 *     an operator can retry from the right one.
 *
 * The single-predicate SELECT is preserved deliberately — the sweep stays
 * dumb, and only its action consults a column the executor maintained.
 *
 * `error` (not `cancelled`) on the failing branch matches the
 * discriminator the agent side already uses — no new status value there.
 *
 * Returns the number of rows swept, across both branches.
 */
export async function terminalizeOrphanedWorkflowRuns(
  startedBefore: Date = new Date(),
  now: Date = new Date(),
): Promise<number> {
  const atBoundary = sql`${workflowRuns.runPhase} = 'boundary'`;
  // Hoisted, and deliberately ONE LINE. A multi-line `sql` template leaves
  // its interpolation-free lines — here the closing `) END` — as orphan
  // COVERABLE lines that never receive an execution hit, because Bun
  // attributes a tagged template to the lines carrying its `${}`
  // substitutions. `migrate.ts` documents the same hazard on its own
  // single-line SELECT. Keeping this on one line is what makes every line
  // of the statement measurable; splitting it back up re-opens the gap.
  const steppedNames = sql`COALESCE((SELECT string_agg(s.step_name, ', ' ORDER BY s.step_name) FROM workflow_step_runs s WHERE s.workflow_run_id = ${workflowRuns.id} AND s.status = 'running'), 'unknown')`;
  const midBatchResult = sql`jsonb_build_object('success', FALSE, 'output', NULL, 'error', 'Workflow run orphaned mid-batch (batch ' || COALESCE(${workflowRuns.cursor} ->> 'batchIndex', '0') || ', steps in flight: ' || ${steppedNames} || '): a restart cannot safely re-enter a half-executed step')`;
  const rows = await getDb()
    .update(workflowRuns)
    .set({
      // The action branches; the SELECTION below stays one predicate.
      status: sql`CASE WHEN ${atBoundary} THEN 'suspended' ELSE 'error' END`,
      resumable: sql`CASE WHEN ${atBoundary} THEN TRUE ELSE FALSE END`,
      suspendedReason: sql`CASE WHEN ${atBoundary} THEN 'orphaned-resumable' ELSE NULL END`,
      // A suspended run is NOT finished — stamping a finish time would
      // make it read as terminal in every list that sorts on it.
      finishedAt: sql`CASE WHEN ${atBoundary} THEN NULL ELSE NOW() END`,
      // Mid-batch keeps today's `error`-as-plain-string result shape, and
      // names the batch index and the steps that were in flight so the
      // operator can retry from the right place. A boundary run keeps
      // whatever result it had — it is going to continue, not end.
      result: sql`CASE WHEN ${atBoundary} THEN ${workflowRuns.result} ELSE ${midBatchResult} END`,
      // The owner is gone either way; leaving a stale claim would stop
      // the daemon ever picking up the resumable ones.
      claimedBy: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(workflowRuns.status, "running"),
        // TWO ways a run is orphaned, and the sweep needs both.
        //
        // §1.4 of the C4 spec states this predicate as
        // `lease_expires_at < now()` alone. Taken literally that silently
        // BREAKS the pre-existing boot sweep: a synchronous run holds no
        // lease, so `lease_expires_at` is NULL, `NULL < now()` is NULL,
        // and every crashed sync run would stay `running` forever — the
        // exact scar this module's header documents. So the lease
        // predicate is added to the original, not substituted for it.
        or(
          and(isNull(workflowRuns.leaseExpiresAt), lt(workflowRuns.startedAt, startedBefore)),
          lt(workflowRuns.leaseExpiresAt, now),
        ),
      ),
    )
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
