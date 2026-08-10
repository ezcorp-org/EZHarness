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
import { and, desc, eq, gte, inArray, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { getDb } from "../connection";
import {
  workflowDelegations,
  workflowRuns,
  workflowStepRuns,
  type DelegationOwnerKind,
  type TruncatedStepOutput,
} from "../schema";
import type { AgentResult, WorkflowCursor, WorkflowRunStatus } from "../../types";
import { isTruncatedStepOutput, MAX_STEP_OUTPUT_BYTES } from "../../runtime/workflow-step-output";
import { logger } from "../../logger";
import { stepCostUsd } from "../../runtime/workflow-step-cost";

const log = logger.child("workflow.runs");

/**
 * Terminal statuses a workflow run may be finalized into.
 *
 * `awaiting_approval` is terminal FOR THIS PROCESS — the run stopped and
 * will not resume on its own — but it deliberately reads as neither
 * success nor failure: the graph ran everything it could and then hit a
 * step that needs a human. It must never be reported as `success`.
 */
export type TerminalWorkflowRunStatus = "success" | "error" | "cancelled" | "awaiting_approval";

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
  /** The run whose `kind: "workflow"` step dispatched this one. Null for
   *  every top-level run. */
  parentRunId?: string | null;
  /**
   * Correlation handle. For a nested run this is the derived
   * `nested:<parent>:<step>#<iteration>` key, and the partial unique index
   * on `(workflow_name, idempotency_key)` is what stops a resumed parent
   * dispatching a second child for the same slot.
   */
  idempotencyKey?: string | null;
  /**
   * The SAVED JOB this run was fired from — the durable half of the
   * job→run correlation.
   *
   * Opaque to the host by construction: jobs live in an extension's
   * `Storage`, not in a table, so there is nothing to FK against and
   * nothing here resolves it. It is written, read back on the run
   * summary, and otherwise inert.
   *
   * It is a HANDLE, not a claim of authority. Nothing branches on it and
   * nothing may: a run's authorization was decided before it started, by
   * the ladder that started it, and a column an extension supplies must
   * never be able to reopen that question.
   */
  jobRef?: string | null;
  /**
   * The `workflow_delegations` row this run executes under — C3, and the
   * ONE scope gate for the step-boundary token check.
   *
   * NULL for every run that is not delegated, which is every run on the
   * tree today. That is not a placeholder: the executor's boundary hook
   * fires only when this is non-null, so a normal run takes ZERO extra
   * queries per boundary.
   *
   * Unlike {@link NewWorkflowRunInput.jobRef} this is NOT inert — it is
   * read back (by id) at every boundary of the run it starts, and at
   * resume time by the `budget-exceeded` / `consent-stale` rows of
   * `runtime/workflow-resume-reasons.ts`. It is still not a claim of
   * authority: the delegation was resolved host-side before the run
   * started, and pointing at one cannot grant what the ladder that
   * started the run did not.
   *
   * `run_as_kind` / `run_as` below are the audit SNAPSHOT of the same
   * decision, and nothing in the executor reads either of them.
   */
  delegationId?: string | null;
  /**
   * WHICH PRINCIPAL this run executed as — the audit snapshot C3's
   * delegated handler resolves before it dispatches.
   *
   * Written here rather than by a follow-up UPDATE because the alternative
   * leaves a window in which a `running` row names a delegation and no
   * principal, and a crash inside that window makes the window permanent.
   * Written but never READ, exactly like {@link NewWorkflowRunInput.jobRef}
   * — the executor forwards these two from its options bag and branches on
   * neither. Authority was decided by the ladder that started the run; a
   * column cannot reopen it.
   *
   * Plain text with NO foreign key, deliberately (`db/schema.ts:850-863`):
   * the pair must survive both revocation of the delegation and deletion
   * of the owner, which is exactly when someone asks who a run belonged
   * to. `delegation_id` carries the live FK and goes NULL; these do not.
   *
   * NULL on every non-delegated run, and NULL is the honest value rather
   * than a gap — such a run executed as its initiating `user_id`.
   */
  runAsKind?: DelegationOwnerKind | null;
  runAs?: string | null;
}

/**
 * Insert the `running` row for a freshly-started workflow run.
 *
 * `id` is supplied by the caller (the executor mints it before emitting
 * `workflow:start`); this function never invents one — see the schema
 * comment on `workflowRuns.id` for why a `$defaultFn` would be a bug.
 */
export async function insertWorkflowRun(row: NewWorkflowRunInput): Promise<void> {
  await getDb()
    .insert(workflowRuns)
    .values({
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
      parentRunId: row.parentRunId ?? null,
      idempotencyKey: row.idempotencyKey ?? null,
      jobRef: row.jobRef ?? null,
      delegationId: row.delegationId ?? null,
      runAsKind: row.runAsKind ?? null,
      runAs: row.runAs ?? null,
    });
}

/**
 * The run a `kind: "workflow"` step already dispatched for this slot, if
 * any.
 *
 * The whole point of the nested dispatch being idempotent. A parent that
 * parked while its child was mid-flight re-enters the same step on resume;
 * without this lookup it would start a SECOND child and duplicate every
 * side effect the first one had — which is the exact failure the durable
 * cursor exists to prevent, reintroduced one level down.
 *
 * Reads by `(workflow_name, idempotency_key)`, which is served by the
 * partial unique index, so the answer is unique by construction rather
 * than by convention.
 */
export async function findWorkflowRunByIdempotencyKey(
  workflowName: string,
  idempotencyKey: string,
): Promise<{ id: string; status: WorkflowRunStatus; result: AgentResult | null } | undefined> {
  const rows = await getDb()
    .select({
      id: workflowRuns.id,
      status: workflowRuns.status,
      result: workflowRuns.result,
    })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workflowName, workflowName),
        eq(workflowRuns.idempotencyKey, idempotencyKey),
      ),
    );
  return rows[0];
}

/**
 * How deep a run sits in the nesting chain, by walking `parent_run_id`
 * upward.
 *
 * A RESUMED run has to know this or the depth cap is evadable: park a
 * child, resume it, and its own nested step would compute depth from zero
 * again — so the cap would bound one process's recursion rather than the
 * chain. Nothing stores the depth (it is derivable, and a stored copy could
 * disagree with the pointers), so it is derived.
 *
 * Bounded by construction: the walk stops after `max + 1` hops and reports
 * that count, which the caller reads as "already at or past the cap". A
 * cycle in `parent_run_id` — impossible through the executor, but the
 * column is plain text — therefore terminates rather than spinning.
 */
export async function workflowRunNestingDepth(
  parentRunId: string | null | undefined,
  max: number,
): Promise<number> {
  let depth = 0;
  let cursor = parentRunId ?? null;
  while (cursor !== null && depth <= max) {
    depth += 1;
    const rows = await getDb()
      .select({ parentRunId: workflowRuns.parentRunId })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, cursor));
    cursor = rows[0]?.parentRunId ?? null;
  }
  return depth;
}

/**
 * The ONE token-sum expression, shared by every spend bound in this file.
 *
 * Written once because the alternative is two aggregates that disagree
 * about the same rows — the hazard {@link sumWorkflowRunTokens}'s docblock
 * names for the trace, and it applies just as hard between two ceilings.
 * `COALESCE` per column so a step that reported only input tokens still
 * contributes them, and `COALESCE` around the `SUM` so an empty set is 0
 * rather than NULL.
 *
 * `workflow_step_iterations` is deliberately absent — see the double-count
 * paragraph on {@link sumWorkflowRunTokens}; it applies identically to
 * every consumer of this expression.
 */
const STEP_TOKEN_SUM = sql<
  string | number | null
>`COALESCE(SUM(COALESCE(${workflowStepRuns.inputTokens}, 0) + COALESCE(${workflowStepRuns.outputTokens}, 0)), 0)`;

/**
 * `SUM()` over `integer` is `bigint` in Postgres, which both drivers hand
 * back as a STRING to avoid a lossy 53-bit cast. `Number(null)` is 0 and
 * `Number("")` is 0, so the `?? 0` is for a zero-row read (impossible for
 * an aggregate without GROUP BY, but these are CEILINGS and must not
 * return NaN if that ever changes).
 */
function tokenTotal(raw: string | number | null | undefined): number {
  const total = Number(raw ?? 0);
  return Number.isFinite(total) ? total : 0;
}

/**
 * Total LLM tokens (input + output) recorded against one run's step rows.
 *
 * ## Why this exists at all, when the trace already computes a total
 *
 * `runtime/workflow-run-trace.ts` already sums these columns per run
 * (`totals.inputTokens` / `totals.outputTokens`, via its `sumOrNull`), and
 * NOT storing that rollup is a deliberate decision recorded there: *"a
 * stored rollup drifts the moment a step row is corrected"*. Nothing here
 * revisits that — there is still no stored total and no generated column,
 * and this function computes the same thing from the same rows.
 *
 * It is a separate function on **performance grounds only**. The trace's
 * path is `listWorkflowStepRunRows`, a bare `SELECT *` that ships every
 * column of every step row — including `output` and `resolved_input`,
 * which are capped at 128 KiB apiece — and the C3 budget check fires at
 * EVERY step boundary of a delegated run rather than once per page view.
 * Reading a whole run's outputs back over the wire to add two integers,
 * once per batch, is the regression this avoids. If that argument ever
 * stops holding, delete this and call the trace's path: what must NOT
 * happen is a second aggregation that disagrees with the trace about the
 * same run's totals.
 *
 * ## `workflow_step_iterations` is deliberately NOT summed
 *
 * `runLoop` accumulates each iteration's usage ONTO the parent step row
 * (`runtime/workflow-executor.ts`, `stepRun.inputTokens = (stepRun.inputTokens ?? 0) + …`),
 * and then ALSO writes the per-iteration child row. The two tables are a
 * rollup and its detail, not two disjoint sets — so summing both
 * double-counts every looped agent step. Pinned by a looped-workflow test.
 *
 * ## Returns 0, where the trace returns null
 *
 * The trace preserves "nothing reported" as `null` so it can render "not
 * reported" instead of claiming a run was free. A CEILING has no use for
 * that distinction — "no tokens reported" and "zero tokens" are the same
 * answer to "is this run over its budget?" — and a nullable return would
 * push a `?? 0` onto every caller, which is where a fail-OPEN would
 * eventually be written by accident. The SQL `COALESCE`s per column so a
 * step that reported only input tokens still contributes them.
 *
 * Served by `uniq_workflow_step_run` on `(workflow_run_id, step_name)`,
 * whose leading column is this WHERE — no second index is needed.
 */
export async function sumWorkflowRunTokens(workflowRunId: string): Promise<number> {
  const rows = await getDb()
    .select({ total: STEP_TOKEN_SUM })
    .from(workflowStepRuns)
    .where(eq(workflowStepRuns.workflowRunId, workflowRunId));
  return tokenTotal(rows[0]?.total);
}

/**
 * Every token a SERVICE ACCOUNT's runs have reported since `since` —
 * `service_accounts.max_tokens_per_day`'s numerator.
 *
 * ## A THIRD bound, and the distinction is the whole reason it exists
 *
 * Three separate numbers gate a delegated fire and none is a substitute
 * for another:
 *
 *  - `workflow_delegations.max_tokens_per_run` — ONE run's LLM spend,
 *    enforced at every step boundary ({@link sumWorkflowRunTokens} →
 *    `enforceDelegatedTokenBudget`). Per run, per delegation.
 *  - `workflow_delegations.max_runs_per_day` — how many times ONE job may
 *    fire today (`countDelegationRunsSince`, in the delegation query
 *    layer). Counts RUNS, not tokens, and is scoped to a single
 *    delegation.
 *  - `service_accounts.max_tokens_per_day` — THIS. Every token every
 *    delegation owned by one account has spent today, summed across all
 *    of them. It is the only bound that sees an account whose ten jobs
 *    are each individually well-behaved.
 *
 * ## Keyed on the `run_as` SNAPSHOT, never on `delegation_id`
 *
 * `workflow_runs.run_as_kind` / `run_as` are plain text with no FK,
 * deliberately, precisely so they survive revocation of the delegation
 * and deletion of the owner (`db/schema.ts` — the C3 column block).
 * `delegation_id` is `ON DELETE SET NULL` and a supersede tombstones the
 * row, so joining through it would REFUND a day's spend the moment a
 * human re-consented or an admin deleted a delegation — a spend bound
 * that a revoke resets is not a spend bound. Both columns are filtered:
 * `run_as` alone is a bare text id that a `user`-kind run could in
 * principle collide with, and `run_as_kind` is the discriminator that
 * says which namespace it is in.
 *
 * Served by `idx_workflow_runs_run_as` on
 * `(run_as_kind, run_as, started_at)` (`db/schema.ts`), whose three
 * columns are exactly this WHERE.
 *
 * CALENDAR day, supplied by the caller as `since`, for the same two
 * reasons `countDelegationRunsSince` states: a query layer that reads the
 * clock cannot be tested at a boundary, and "per day" has to mean the
 * same thing in every subsystem that says it.
 */
export async function sumServiceAccountTokensSince(
  serviceAccountId: string,
  since: Date,
): Promise<number> {
  const rows = await getDb()
    .select({ total: STEP_TOKEN_SUM })
    .from(workflowStepRuns)
    // INNER join: a step row whose run has been deleted contributes
    // nothing, and there is no such row anyway (`ON DELETE CASCADE`).
    .innerJoin(workflowRuns, eq(workflowStepRuns.workflowRunId, workflowRuns.id))
    .where(
      and(
        eq(workflowRuns.runAsKind, "service"),
        eq(workflowRuns.runAs, serviceAccountId),
        gte(workflowRuns.startedAt, since),
      ),
    );
  return tokenTotal(rows[0]?.total);
}

/**
 * The delegation a run executes under, as the two facts a run-scoped
 * ceiling needs: what it may spend, and whether the authority still
 * stands.
 *
 * Returns `null` when the run has no delegation (every run today), when
 * the run does not exist, and when the delegation it pointed at has been
 * deleted — `workflow_runs.delegation_id` is `ON DELETE SET NULL`, so
 * "deleted" and "never had one" are the same read, and both mean "this
 * table can say nothing about that run's budget".
 *
 * ## Read at the decision point, never carried
 *
 * This is the nesting-depth precedent ({@link workflowRunNestingDepth}),
 * not the tool-call one. The tool-call ceiling
 * (`extensions/tool-executor/limits.ts`) counts in an in-memory Map, so a
 * suspend/resume refunds it — which is fine for "stop a runaway loop" and
 * useless as a SPEND bound: a cron job that parks and resumes every cycle
 * would get its budget back every cycle. Both values here come out of the
 * database every time they are consulted, so a resume cannot reset them
 * and raising the cap takes effect on the next boundary.
 */
export interface WorkflowRunDelegationBudget {
  delegationId: string;
  /**
   * `workflow_delegations.max_tokens_per_run` — TOKENS, never cents. Cost
   * is derived, displayed and advisory; an unpriced (OAuth-subscription)
   * model reports a null price and would spend without bound under a cost
   * cap. `NOT NULL` in the schema: there is deliberately no "unlimited".
   */
  maxTokensPerRun: number;
  /** `enabled AND revoked_at IS NULL` — the same liveness every other
   *  delegation lookup filters on, surfaced rather than filtered so a
   *  caller can tell "revoked" from "never had one". */
  live: boolean;
  /** When the human last consented. Compared against {@link runStartedAt}
   *  by the `consent-stale` resume rule. */
  consentedAt: Date;
  /** The run's own `started_at`, read in the same round trip because the
   *  `consent-stale` predicate needs both and its context carries only a
   *  run id. */
  runStartedAt: Date;
}

export async function readWorkflowRunDelegationBudget(
  workflowRunId: string,
): Promise<WorkflowRunDelegationBudget | null> {
  const rows = await getDb()
    .select({
      delegationId: workflowDelegations.id,
      maxTokensPerRun: workflowDelegations.maxTokensPerRun,
      enabled: workflowDelegations.enabled,
      revokedAt: workflowDelegations.revokedAt,
      consentedAt: workflowDelegations.consentedAt,
      runStartedAt: workflowRuns.startedAt,
    })
    .from(workflowRuns)
    // INNER join, deliberately: a run whose `delegation_id` is NULL must
    // produce no row at all rather than a row full of nulls that a caller
    // could mistake for "delegated, no cap".
    .innerJoin(workflowDelegations, eq(workflowRuns.delegationId, workflowDelegations.id))
    .where(eq(workflowRuns.id, workflowRunId));
  const row = rows[0];
  if (row === undefined) return null;
  return {
    delegationId: row.delegationId,
    maxTokensPerRun: row.maxTokensPerRun,
    live: row.enabled && row.revokedAt === null,
    consentedAt: row.consentedAt,
    runStartedAt: row.runStartedAt,
  };
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
  /** Why a `skipped` step did not run — its own `when`, or the name of the
   *  skipped dependency that suppressed it. Absent for every other status,
   *  and absent persists as SQL NULL: "this step was not skipped". Without
   *  it a reloaded trace shows `status = 'skipped'` and no reason, which is
   *  indistinguishable from a step that was never reached. */
  skippedReason?: string;
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
export async function upsertWorkflowStepRun(row: WorkflowStepRunUpsert): Promise<void> {
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
  const skippedReason = row.skippedReason ?? null;
  // Derived from `row`'s own `provider` / `model` / `inputTokens` /
  // `outputTokens` rather than passed in, so the cost is always a function
  // of the tokens actually recorded and cannot be set independently of
  // them. Advisory: it is for display and analysis, never a bound.
  //
  // NULL here means the cost could not be MEASURED — it never means
  // "free". A `tool` / `transform` / `gate` step reports no tokens, so it
  // prices as NULL while its real-world cost is simply unmeasured; an
  // unpriced (OAuth-subscription) model prices as NULL too. Tokens reach
  // this function only from an `agentRun`
  // (`runtime/workflow-executor.ts:2158-2165`), so `SUM(cost_usd)`
  // describes LLM spend and nothing else — least of all `tool` steps, the
  // one kind that reaches an external side effect with a real bill. See
  // {@link stepCostUsd}, which owns that distinction.
  const costUsd = stepCostUsd(row);
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
      costUsd,
      durationMs,
      errorCode,
      resolvedInput,
      skippedReason,
    })
    .onConflictDoUpdate({
      target: [workflowStepRuns.workflowRunId, workflowStepRuns.stepName],
      set: {
        runId,
        status: row.status,
        iterations,
        provider,
        model,
        output,
        attempt,
        inputTokens,
        outputTokens,
        costUsd,
        durationMs,
        errorCode,
        resolvedInput,
        skippedReason,
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
 *
 * ## Skipped steps come back too, and NOT as results
 *
 * A `skipped` step produced no value, so it must not appear in
 * `stepResults` — a downstream `$steps.<skipped>` has to keep throwing.
 * But the resumed half of the run still has to KNOW it was skipped: that is
 * what makes a transitively-skipped dependent skip again instead of running
 * against a missing dependency, and what makes the ref error say "was
 * SKIPPED" rather than the misleading "has not run yet". So they are
 * returned in a second, parallel map.
 *
 * The row's own `skipped_reason` is used when it has one, so a resumed run
 * reports the SAME reason the first process did. This constant is the
 * fallback for a row written before that column had a writer — the status
 * survived a restart, the reason did not, and inventing a specific one for
 * those rows would be worse than admitting the generic truth.
 */
export const REHYDRATED_SKIP_REASON = "it was skipped earlier in this run";

export async function loadStepResults(
  workflowRunId: string,
): Promise<
  | { ok: true; stepResults: Map<string, AgentResult>; skippedSteps: Map<string, string> }
  | { ok: false; reason: string }
> {
  const rows = await listWorkflowStepRunRows(workflowRunId);
  const stepResults = new Map<string, AgentResult>();
  const skippedSteps = new Map<string, string>();
  for (const row of rows) {
    if (row.status === "skipped") {
      skippedSteps.set(row.stepName, row.skippedReason ?? REHYDRATED_SKIP_REASON);
      continue;
    }
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
  return { ok: true, stepResults, skippedSteps };
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
      ...(opts?.suspendedReason !== undefined ? { suspendedReason: opts.suspendedReason } : {}),
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
  /**
   * Scope to a SET of workflow names — the extension read
   * (`ezcorp/workflows` `op: "runs"`) filtering to the names its grant
   * covers.
   *
   * In the WHERE rather than over the result for the same reason
   * `userId` is: post-filtering a keyset page returns short pages and
   * eventually an empty one with a cursor still pointing forward, which
   * a client reads as "no more runs" while runs remain.
   *
   * An EMPTY array matches nothing (drizzle's `inArray` emits `false`),
   * which is the fail-closed reading — "scoped to no names" must never
   * widen to "unscoped".
   */
  workflowNames?: string[];
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
 * The keyset boundary, as ONE expression shared by every pager over this
 * table.
 *
 * Extracted rather than repeated because the two halves are only correct
 * together: "strictly older, OR the same instant with a smaller id". A
 * copy that lost the `id` tiebreak would duplicate or drop a row whenever
 * two runs started in the same millisecond, and it would do so rarely
 * enough to reach production.
 */
function runKeysetBefore(cursor: { startedAt: Date; id: string }): SQL | undefined {
  return or(
    lt(workflowRuns.startedAt, cursor.startedAt),
    and(eq(workflowRuns.startedAt, cursor.startedAt), lt(workflowRuns.id, cursor.id)),
  );
}

/** Slice the over-fetched row off and turn it into a cursor. Shared so a
 *  second pager cannot disagree about what "has more" means. */
function toRunPage(rows: Array<typeof workflowRuns.$inferSelect>, limit: number): WorkflowRunPage {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const hasMore = rows.length > limit;
  return {
    runs: page,
    ...(hasMore && last !== undefined
      ? { nextCursor: { startedAt: last.startedAt.toISOString(), id: last.id } }
      : {}),
  };
}

/**
 * Runs fired by a delegation THIS HUMAN consented to — the "jobs running
 * as me" page.
 *
 * ## Keyed on `consented_by_user_id`, not on `run_as`
 *
 * `run_as` names the PRINCIPAL a run executed as, and for a `service`-kind
 * delegation that is a service account, not a person. Keying the page on
 * it would show a user their own user-kind jobs and hide every
 * service-account job they authorized — the ones with no session anywhere
 * that can account for them. Ruling 1's split is that the ACCOUNT owns the
 * run and the HUMAN WHO CONSENTED answers for it, so this is the same key
 * {@link mayManageDelegation} and `listWorkflowDelegationsConsentedBy` use.
 * One notion of "my jobs" across the list, the page, and the revoke.
 *
 * ## Revoked delegations are INCLUDED, deliberately
 *
 * There is no `revoked_at IS NULL` term. "What did that extension do as
 * me?" is the question you ask immediately AFTER revoking, and a history
 * that vanishes at revocation cannot answer it. The delegation row is a
 * tombstone rather than a delete for exactly this reason
 * (`workflow-delegations.ts`), and this read is the consumer that makes
 * that choice pay.
 *
 * Served by `idx_workflow_runs_delegation` for the join
 * (`db/schema.ts:901`) and `idx_workflow_delegations_consented_by` for the
 * filter.
 */
export async function listDelegatedRunsForConsenter(
  consentedByUserId: string,
  q: { cursor?: { startedAt: Date; id: string }; limit: number },
): Promise<WorkflowRunPage> {
  const filters = [
    eq(workflowDelegations.consentedByUserId, consentedByUserId),
    q.cursor !== undefined ? runKeysetBefore(q.cursor) : undefined,
  ].filter((f) => f !== undefined);

  const rows = await getDb()
    .select({ run: workflowRuns })
    .from(workflowRuns)
    // INNER join: a run with no `delegation_id` is not a delegated run, and
    // a run whose delegation row was hard-deleted has no consenter to
    // attribute it to. Both are correctly invisible here.
    .innerJoin(workflowDelegations, eq(workflowRuns.delegationId, workflowDelegations.id))
    .where(and(...filters))
    .orderBy(desc(workflowRuns.startedAt), desc(workflowRuns.id))
    .limit(q.limit + 1);

  return toRunPage(
    rows.map((r: { run: typeof workflowRuns.$inferSelect }) => r.run),
    q.limit,
  );
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
export async function listWorkflowRunsPage(q: WorkflowRunPageQuery): Promise<WorkflowRunPage> {
  const filters = [
    q.workflowName !== undefined ? eq(workflowRuns.workflowName, q.workflowName) : undefined,
    q.workflowNames !== undefined ? inArray(workflowRuns.workflowName, q.workflowNames) : undefined,
    q.status !== undefined ? eq(workflowRuns.status, q.status) : undefined,
    q.projectId !== undefined ? eq(workflowRuns.projectId, q.projectId) : undefined,
    q.since !== undefined ? gte(workflowRuns.startedAt, q.since) : undefined,
    q.until !== undefined ? lte(workflowRuns.startedAt, q.until) : undefined,
    q.userId !== undefined ? eq(workflowRuns.userId, q.userId) : undefined,
    q.cursor !== undefined ? runKeysetBefore(q.cursor) : undefined,
  ].filter((f) => f !== undefined);

  // One extra row, discarded, purely to learn whether a next page exists
  // without a second COUNT over a growing table.
  const rows = await getDb()
    .select()
    .from(workflowRuns)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(workflowRuns.startedAt), desc(workflowRuns.id))
    .limit(q.limit + 1);

  return toRunPage(rows, q.limit);
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
  return releaseBoundaryClaims(claimedBy);
}

/**
 * Hand back ONE claim, by run id.
 *
 * The single-run twin of {@link releaseWorkflowRunClaims}, for a daemon
 * that claimed a run and then could not take it anywhere — a resume
 * refused TRANSIENTLY, the pending-approval gate above all. Holding the
 * claim after that would leave the row at `running` for a full lease
 * period, and `answerApproval` refuses a run that is not `suspended`: the
 * daemon would have locked the human out of the very decision it was
 * waiting for.
 *
 * Scoped to one id rather than reusing the plural form, which would yank
 * the claims of every OTHER resume this instance has in flight — they
 * sit at `boundary` between batches, so they match its WHERE exactly.
 *
 * Every other guarantee is the plural one's, because it is the same
 * predicate: only this instance's claims, only a run still `running`,
 * only at a `boundary`.
 *
 * Returns 1 if the claim was released, 0 if there was nothing to release.
 */
export async function releaseWorkflowRunClaim(
  workflowRunId: string,
  claimedBy: string,
): Promise<number> {
  return releaseBoundaryClaims(claimedBy, workflowRunId);
}

/**
 * The one predicate both release forms use — see
 * {@link releaseWorkflowRunClaims} for what each conjunct is protecting.
 *
 * Shared rather than duplicated because the `run_phase='boundary'`
 * condition is the load-bearing one: a copy that lost it would hand a run
 * with side effects in flight to a second process.
 */
async function releaseBoundaryClaims(claimedBy: string, workflowRunId?: string): Promise<number> {
  const rows = await getDb()
    .update(workflowRuns)
    .set({ status: "suspended", claimedBy: null, leaseExpiresAt: null })
    .where(
      and(
        eq(workflowRuns.claimedBy, claimedBy),
        eq(workflowRuns.status, "running"),
        eq(workflowRuns.runPhase, "boundary"),
        ...(workflowRunId !== undefined ? [eq(workflowRuns.id, workflowRunId)] : []),
      ),
    )
    .returning({ id: workflowRuns.id });
  return rows.length;
}

/**
 * One-shot, idempotent repair for runs the daemon bricked.
 *
 * ## What went wrong, and why these rows are recoverable
 *
 * Winning {@link claimWorkflowRun}'s CAS is the `suspended → running`
 * transition, and `WorkflowRunner` re-reads the row after claiming it. So
 * every run the daemon claimed reached `resumeWorkflow` reading `running`,
 * and a bare `status !== "suspended"` guard terminalized it `error` with
 * `not-resumable` before the pending-approval check could protect it. The
 * daemon wakes every ~5s, so approval-parked runs died within one wake
 * interval and their prompts became unanswerable forever.
 *
 * Only three columns were overwritten — `finalizeWorkflowRunRow` writes
 * `status`, `finished_at` and `result` and nothing else. The `cursor`,
 * `run_phase`, `suspended_reason`, every `workflow_step_runs` row and the
 * still-`pending` `workflow_approvals` row all survived, which is what
 * makes this a repair rather than a resurrection: the run's position is
 * intact and it continues from exactly where the human left it.
 *
 * ## The selection, and why each conjunct is load-bearing
 *
 * A migration that revived a genuinely failed run would be a worse bug
 * than the one it fixes, so this matches the defect's signature and
 * nothing else:
 *
 *   - `status = 'error'` — what the guard wrote.
 *   - `result->'error'->>'code' = 'not-resumable'` — the PRIMARY
 *     discriminator. That code reaches a run row from exactly one place,
 *     `refuseTerminal("not-resumable", …)` in `workflow-executor.ts`.
 *     `workflow-run-control.ts` also names the string, but only as a
 *     `RunControlCode` RETURNED to its caller; it never writes it to a
 *     row. No real workflow failure carries it.
 *   - the message mentions `is running, not suspended` — narrows to the
 *     claim race specifically. The same guard also (correctly) refuses a
 *     run that was genuinely `success`/`cancelled`/`awaiting_approval`,
 *     and those must stay exactly as they are.
 *   - `run_phase = 'boundary'` — the SAFETY conjunct, and the same
 *     judgement {@link terminalizeOrphanedWorkflowRuns} makes. It means
 *     nothing was in flight, so returning the run to `suspended` cannot
 *     re-enter a half-executed step. An `in-batch` row is never touched.
 *   - `cursor IS NOT NULL` and `suspended_reason IS NOT NULL` — it really
 *     was parked, and there is a position to resume from. A run that
 *     failed before ever parking has neither.
 *
 * Safe to re-run: after the code fix nothing produces this signature
 * again, and a second pass matches zero rows.
 *
 * Returns the number of runs repaired.
 */
export async function repairDaemonBrickedWorkflowRuns(
  executor: { execute: (q: SQL) => Promise<unknown> } = getDb(),
): Promise<number> {
  const rows = (await executor.execute(sql`
    UPDATE workflow_runs
       SET status = 'suspended', finished_at = NULL, result = NULL,
           claimed_by = NULL, lease_expires_at = NULL
     WHERE status = 'error'
       AND result -> 'error' ->> 'code' = 'not-resumable'
       AND result -> 'error' ->> 'message' LIKE '%is running, not suspended%'
       AND run_phase = 'boundary'
       AND cursor IS NOT NULL
       AND suspended_reason IS NOT NULL
     RETURNING id
  `)) as { rows?: unknown[] } | unknown[];
  const repaired = Array.isArray(rows) ? rows.length : (rows.rows?.length ?? 0);
  if (repaired > 0) {
    log.warn("repaired workflow runs terminalized by the daemon claim race", { repaired });
  }
  return repaired;
}
