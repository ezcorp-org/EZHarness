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
 *   • {@link finalizeWorkflowRunRow} — idempotent CAS on the live statuses
 *     (`running`, `suspended`)
 *   • {@link terminalizeOrphanedWorkflowRuns} — boot sweep
 */
import { and, desc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
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
  /** Agent invocations the step consumed (retries + loop iterations). */
  attempt?: number;
  /**
   * Tokens the step reported, summed.
   *
   * **Absent must persist as SQL NULL, never 0.** "The provider reported
   * nothing" and "the call used no tokens" are different facts, and only
   * NULL says the first one — every SQL aggregate ignores NULL, while a 0
   * is counted and silently deflates the total.
   */
  inputTokens?: number;
  outputTokens?: number;
  /** Wall-clock for the step, including retries and loop iterations. */
  durationMs?: number;
  /** Typed failure reason (`cancelled`, `step-failed`, …), not a message. */
  errorCode?: string;
  /** The step's resolved input mapping, already redacted and size-checked
   *  by {@link prepareResolvedInput}. Never the raw value — that object
   *  carries whatever credentials the author threaded in. */
  resolvedInput?: Record<string, unknown> | TruncatedStepOutput;
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
  const attempt = row.attempt ?? null;
  // `?? null`, deliberately NOT `?? 0`. Absent means the provider
  // reported nothing; a zero would be a measurement that was never taken
  // and every SUM over this column would believe it.
  const inputTokens = row.inputTokens ?? null;
  const outputTokens = row.outputTokens ?? null;
  const durationMs = row.durationMs ?? null;
  const errorCode = row.errorCode ?? null;
  const resolvedInput = row.resolvedInput ?? null;
  // `cost_usd` is deliberately NOT written by any code path: there is no
  // host-side price table, so nothing here can compute a cost honestly.
  // The column exists so the trace, the dashboard and C3's spend cap have
  // one place to read from the day a price source lands.
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
      attempt,
      inputTokens,
      outputTokens,
      durationMs,
      errorCode,
      resolvedInput,
    })
    .onConflictDoUpdate({
      target: [workflowStepRuns.workflowRunId, workflowStepRuns.stepName],
      set: {
        runId, status: row.status, iterations, provider, model, output,
        attempt, inputTokens, outputTokens, durationMs, errorCode, resolvedInput,
        updatedAt: sql`NOW()`,
      },
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
 *
 * ## PAIRED WITH the executor — this strictness is load-bearing
 *
 * `WorkflowExecutor` appends a step to `cursor.completedSteps` the
 * instant it succeeds, which is BEFORE it issues the `output` write —
 * and that write is `void persistWrite(...)`, fire-and-forget and
 * never-throwing. So "recorded complete, output never landed" is a
 * genuinely reachable state, not a theoretical one.
 *
 * The executor's ordering is safe ONLY because this function refuses
 * that state. Relaxing it — returning an empty map, or skipping the
 * step — would silently reopen the window, and every executor-side test
 * would still pass because nothing on that side changed. Neither file
 * can be reasoned about alone.
 *
 * Pinned by "a step recorded complete with no persisted output refuses
 * resume, never rehydrates empty".
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
 * Park a run: `running` → `suspended`, recording where to resume.
 *
 * CAS on `status='running'` for the same reason
 * {@link finalizeWorkflowRunRow} has one — a run the recovery sweep
 * already claimed, or that was cancelled while this process was mid-step,
 * must not be dragged back to `suspended`. Zero rows means someone else
 * decided this run's fate first, and the caller treats that as a lost
 * race rather than an error.
 *
 * `resumable` is deliberately NOT set here. It is the SWEEP's flag,
 * describing whether a CRASHED run may continue; a deliberate park is
 * resumable by construction and does not need a column to say so.
 *
 * Returns the number of rows transitioned (0 or 1).
 */
export async function suspendWorkflowRun(
  workflowRunId: string,
  opts: { reason: string; cursor: WorkflowCursor },
): Promise<number> {
  const rows = await getDb()
    .update(workflowRuns)
    .set({
      status: "suspended",
      suspendedReason: opts.reason,
      cursor: opts.cursor,
      // Back to a boundary: nothing is in flight once this lands, which
      // is what makes the row safe for another process to pick up.
      runPhase: "boundary",
      // The parking process is releasing the run.
      claimedBy: null,
      leaseExpiresAt: null,
    })
    .where(and(eq(workflowRuns.id, workflowRunId), eq(workflowRuns.status, "running")))
    .returning({ id: workflowRuns.id });
  return rows.length;
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
  opts?: {
    /**
     * Overwrite `suspended_reason` as the row terminalizes.
     *
     * Only the approval-timeout sweep passes it, and it is what makes a
     * cancelled run say WHY on the row rather than only inside
     * `result.error`: the column reads `approval` from the park, so a
     * timed-out run would otherwise be indistinguishable from one an
     * operator cancelled while it waited. Omitted ⇒ the column is left
     * exactly as the park wrote it.
     */
    suspendedReason?: string;
  },
): Promise<number> {
  const rows = await getDb()
    .update(workflowRuns)
    .set({
      status,
      finishedAt: sql`NOW()`,
      ...(result !== undefined ? { result } : {}),
      ...(opts?.suspendedReason !== undefined
        ? { suspendedReason: opts.suspendedReason }
        : {}),
    })
    .where(
      and(
        eq(workflowRuns.id, workflowRunId),
        // Widened from `running` alone to cover the two ways a PARKED run
        // legitimately ends: a cancel while it waits, and a resume that
        // refuses (drift, lost step output). Without `suspended` here
        // those refusals matched zero rows and were silently dropped —
        // the run stayed parked and every later attempt refused again,
        // forever. The zero-row-no-op contract and the "never clobber a
        // richer terminal state" guarantee are unchanged: a run already
        // terminal still matches nothing.
        inArray(workflowRuns.status, ["running", "suspended"]),
      ),
    )
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
  //
  // Phase 2 and Phase 6 hit this INDEPENDENTLY and arrived at the same
  // single-line fix, which is the strongest evidence available that the
  // hazard is a real property of the coverage tooling rather than a
  // one-off. Do not "tidy" these back onto several lines.
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

/** Filters and cursor for {@link listWorkflowRunsPage}. */
export interface WorkflowRunPageQuery {
  workflowName?: string;
  status?: WorkflowRunStatus;
  projectId?: string;
  since?: Date;
  until?: Date;
  /**
   * Scope to one user's runs. `undefined` means "no ownership filter",
   * which the route only ever passes for an admin.
   *
   * A run with `user_id IS NULL` (CLI, extension-triggered) matches NO
   * user filter, so it is admin-only — the fail-closed reading, and the
   * same one `mayControlRun` takes.
   */
  userId?: string;
  /** Exclusive cursor: the last row of the previous page. */
  cursor?: { startedAt: Date; id: string };
  limit: number;
}

/** One page, plus the cursor that continues it. */
export interface WorkflowRunPage {
  runs: Array<typeof workflowRuns.$inferSelect>;
  /** Absent when this was the last page. */
  nextCursor?: { startedAt: string; id: string };
}

/**
 * List runs newest-first, with keyset pagination.
 *
 * **Keyset, not OFFSET, and that is the point.** This list is ordered by
 * `started_at DESC` on a table that gains rows at the head continuously.
 * With OFFSET, a run that starts between page 1 and page 2 shifts every
 * later row down by one, so page 2 re-serves the last row of page 1 and
 * skips nothing visibly — the reader silently loses a row per insert.
 * Comparing against the previous page's `(started_at, id)` is stable
 * under inserts because it names a POSITION rather than a count.
 *
 * `id` is in the key because `started_at` is not unique — two runs fired
 * in the same millisecond would otherwise make the boundary ambiguous and
 * either duplicate or drop one.
 *
 * Served by `idx_workflow_runs_name_started`; the user filter is served by
 * `idx_workflow_runs_user`.
 */
export async function listWorkflowRunsPage(
  q: WorkflowRunPageQuery,
): Promise<WorkflowRunPage> {
  const filters = [
    q.workflowName !== undefined ? eq(workflowRuns.workflowName, q.workflowName) : undefined,
    q.status !== undefined ? eq(workflowRuns.status, q.status) : undefined,
    q.projectId !== undefined ? eq(workflowRuns.projectId, q.projectId) : undefined,
    q.since !== undefined ? gte(workflowRuns.startedAt, q.since) : undefined,
    q.until !== undefined ? lte(workflowRuns.startedAt, q.until) : undefined,
    q.userId !== undefined ? eq(workflowRuns.userId, q.userId) : undefined,
    // The keyset predicate, as one expression so it cannot be split by a
    // later edit: strictly older, OR the same instant with a smaller id.
    q.cursor !== undefined
      ? or(
          lt(workflowRuns.startedAt, q.cursor.startedAt),
          and(eq(workflowRuns.startedAt, q.cursor.startedAt), lt(workflowRuns.id, q.cursor.id)),
        )
      : undefined,
  ].filter((f) => f !== undefined);

  // One extra row, discarded, purely to learn whether a next page exists
  // without a second COUNT over a growing table.
  const rows = await getDb()
    .select()
    .from(workflowRuns)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(workflowRuns.startedAt), desc(workflowRuns.id))
    .limit(q.limit + 1);

  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  const hasMore = rows.length > q.limit;
  return {
    runs: page,
    ...(hasMore && last !== undefined
      ? { nextCursor: { startedAt: last.startedAt.toISOString(), id: last.id } }
      : {}),
  };
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

// ── Claim / lease: the WorkflowRunner daemon's half of `workflow_runs` ──
//
// Grouped here rather than in the daemon because they are writes to this
// table and this module is its one home (see the header). The daemon owns
// the POLICY — how often, how many at once, what to do on a lost race —
// and none of the SQL.

/**
 * Lease duration. 60s, renewed every {@link WORKFLOW_LEASE_RENEW_MS} while
 * a claim is held.
 *
 * The lease detects a **dead process**, not a slow step: the heartbeat is
 * per *daemon*, so a 30-minute agent step keeps its claim for as long as
 * the daemon renewing it is alive. Sizing it to step duration instead
 * would make every long step look like a crash.
 */
export const WORKFLOW_LEASE_MS = 60_000;

/** Renew at a third of the lease, so two consecutive misses are survivable. */
export const WORKFLOW_LEASE_RENEW_MS = 20_000;

/**
 * Suspended runs this instance may attempt to claim: unheld, or held on a
 * lease that has expired (the holder died).
 *
 * Deliberately NOT filtered on `resumable`. That flag is the recovery
 * sweep's verdict on a **crashed** run; a deliberately parked run is
 * resumable by construction and never carries it — see
 * {@link suspendWorkflowRun}. Filtering on it here would make the daemon
 * ignore every approval-parked run, which is the entire population it
 * exists to serve.
 *
 * Served by `idx_workflow_runs_claimable` on
 * `(status, lease_expires_at) WHERE status IN ('running','suspended')`.
 */
export async function listClaimableWorkflowRuns(
  now: Date,
  limit: number,
): Promise<Array<{ id: string; workflowName: string; projectId: string | null }>> {
  return getDb()
    .select({
      id: workflowRuns.id,
      workflowName: workflowRuns.workflowName,
      projectId: workflowRuns.projectId,
    })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.status, "suspended"),
        or(isNull(workflowRuns.claimedBy), lt(workflowRuns.leaseExpiresAt, now)),
      ),
    )
    .limit(limit);
}

/**
 * Claim one suspended run. Returns true iff this caller won it.
 *
 * A compare-and-swap, never `FOR UPDATE SKIP LOCKED` — PGlite does not
 * honor that identically, and this has to behave the same on both drivers
 * (the multi-instance / external-Postgres topology is the whole reason the
 * lease exists). Of N instances racing one row exactly one UPDATE matches;
 * the losers match zero rows and skip.
 *
 * Winning the CAS **is** the `suspended → running` transition, so the
 * claim and the state change are one atomic act: there is no window in
 * which two workers both believe they own the run. `run_phase` is left
 * alone — the cursor decides where to resume, and rewriting the phase here
 * would discard the sweep's reading of how the previous attempt ended.
 */
export async function claimWorkflowRun(opts: {
  workflowRunId: string;
  claimedBy: string;
  now: Date;
  leaseMs?: number;
}): Promise<boolean> {
  const rows = await getDb()
    .update(workflowRuns)
    .set({
      status: "running",
      claimedBy: opts.claimedBy,
      leaseExpiresAt: new Date(opts.now.getTime() + (opts.leaseMs ?? WORKFLOW_LEASE_MS)),
    })
    .where(
      and(
        eq(workflowRuns.id, opts.workflowRunId),
        eq(workflowRuns.status, "suspended"),
        or(isNull(workflowRuns.claimedBy), lt(workflowRuns.leaseExpiresAt, opts.now)),
      ),
    )
    .returning({ id: workflowRuns.id });
  return rows.length === 1;
}

/**
 * Push every live claim this instance holds forward by one lease.
 *
 * Scoped to `claimed_by = $me` AND `status = 'running'`: a run this
 * instance parked or finished must not be dragged back under lease, and a
 * run another instance legitimately reclaimed after our lease lapsed is
 * no longer ours to renew.
 *
 * Returns the number of claims renewed.
 */
export async function renewWorkflowRunLeases(
  claimedBy: string,
  now: Date,
  leaseMs: number = WORKFLOW_LEASE_MS,
): Promise<number> {
  const rows = await getDb()
    .update(workflowRuns)
    .set({ leaseExpiresAt: new Date(now.getTime() + leaseMs) })
    .where(and(eq(workflowRuns.claimedBy, claimedBy), eq(workflowRuns.status, "running")))
    .returning({ id: workflowRuns.id });
  return rows.length;
}

/**
 * Hand back every claim this instance holds, returning those runs to
 * `suspended` so a sibling can pick them up immediately.
 *
 * Called on graceful shutdown. Waiting out the lease instead would stall
 * every parked run for a full lease period on every rolling restart —
 * this is the one place this daemon is deliberately better than the
 * schedule daemon it is modelled on.
 *
 * Only runs still at a **boundary** are released: `run_phase='in-batch'`
 * means a batch was dispatched and may have applied side effects, so the
 * recovery sweep — which is the component that owns that judgement — must
 * be the one to decide its fate. Releasing it here would invite a second
 * process to re-execute it.
 *
 * Returns the number of claims released.
 */
export async function releaseWorkflowRunClaims(claimedBy: string): Promise<number> {
  const rows = await getDb()
    .update(workflowRuns)
    .set({ status: "suspended", claimedBy: null, leaseExpiresAt: null })
    .where(
      and(
        eq(workflowRuns.claimedBy, claimedBy),
        eq(workflowRuns.status, "running"),
        eq(workflowRuns.runPhase, "boundary"),
      ),
    )
    .returning({ id: workflowRuns.id });
  return rows.length;
}
