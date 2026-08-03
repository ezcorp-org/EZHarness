/**
 * `workflow_runs.suspended_reason` → who may resume the run, as a TABLE.
 *
 * ## Why a table and not a chain of `if`s
 *
 * C3 (delegated execution) adds `budget-exceeded` and `consent-stale` to
 * this column. If the rule lived in scattered branches inside
 * `resumeWorkflow`, adding a reason would mean finding every branch, and
 * the one that was missed would be a silent bypass — the exact defect
 * class this module exists to close. Here, a reason that nobody
 * classifies is a COMPILE error: {@link RESUME_RULES} is
 * `satisfies Record<WorkflowSuspendReason, ResumeRule>`, so widening
 * {@link WorkflowSuspendReason} without adding its row fails the build.
 *
 * `satisfies Record<K, …>` rather than an exhaustive `switch` (the
 * `readRunAudience` pattern in `workflow-scope.ts`) because the thing
 * being written down here is DATA — one row per reason, each with a
 * predicate and a human-readable description. A `switch` would express
 * the same exhaustiveness but scatter the descriptions into return
 * statements, and the point of the table is that the whole policy can be
 * read at once. PR #66 used the same `as const satisfies Record<K, …>`
 * shape for the same reason.
 *
 * ## The rule each row encodes
 *
 * `satisfied` is a predicate RE-READ FROM THE DATABASE at the decision
 * point. It never takes a caller's word for anything — the same
 * proof-not-assertion principle PR #58 applied to `claimed_by` via
 * `holdsClaim`. A caller cannot pass in "my budget is fine"; the row is
 * consulted.
 *
 * `null` means "no resume-time predicate", and it is a claim about the
 * tree, not a shrug. For today's four reasons the condition is already
 * re-verified by the STEP the run re-enters from its cursor, which is a
 * strictly stronger check than anything this table could do — it reads
 * the authoritative object rather than a free-text column:
 *
 *   - `approval` — `runApprovalStep` (`workflow-executor.ts:2311-2353`)
 *     re-reads the `workflow_approvals` row and re-parks unless it is
 *     `answered`. `expired` re-parks DELIBERATELY (`:2330-2333`), so an
 *     approval that merely timed out never admits the run.
 *   - `nested-suspended` — `runNestedWorkflow` re-finds the child by its
 *     idempotency key (`:1746-1749`) and `nestedOutcome` (`:2143-2157`)
 *     re-throws while that child reads `suspended` / `running`, so the
 *     parent cannot pass a child that is still waiting, and no duplicate
 *     child is dispatched.
 *
 * Both facts are pinned by mutation in
 * `src/__tests__/workflow-resume-reason-gate.test.ts`: remove either
 * re-check and the bypass becomes real, and the suite fails.
 *
 * C3's two rows are different in kind, which is why this table has to
 * exist before they land: **nothing re-checks a spend cap when a run
 * re-enters an approval step.** A run parks on a normal `approval`, a cap
 * trips and rewrites the reason to `budget-exceeded`, the human answers
 * the approval — and the approval step is satisfied, so the run proceeds
 * with the cap never consulted. That is the R-3 escalation, and it is
 * closed by giving `budget-exceeded` a `satisfied` predicate here rather
 * than by hoping a step asks.
 */

/**
 * Every value production writes to `workflow_runs.suspended_reason`.
 *
 * Enumerated from the writers, not from the plan documents — the column
 * is free-text `TEXT` (`db/schema.ts:560`) and carries no DB-level enum,
 * so this union is the only place the set is stated:
 *
 *   - `"approval"` — `workflow-executor.ts:2353`
 *   - `"nested-suspended"` — `workflow-executor.ts:2151`
 *   - `"orphaned-resumable"` — `db/queries/workflow-runs.ts:612`
 *   - `"approval-timeout"` — `workflow-approval-timeout-sweep.ts:217`
 *
 * The `quota` / `consent-stale` values in `docs/plans/*` are NOT on this
 * tree yet; they arrive with C3 and belong in this union and the table
 * below when they do.
 */
export type WorkflowSuspendReason =
  | "approval"
  | "nested-suspended"
  | "orphaned-resumable"
  | "approval-timeout";

/** The reasons, as a value, for tests and for exhaustiveness checks. */
export const WORKFLOW_SUSPEND_REASONS = [
  "approval",
  "nested-suspended",
  "orphaned-resumable",
  "approval-timeout",
] as const satisfies readonly WorkflowSuspendReason[];

/** Facts a resume-time predicate is allowed to consult. Deliberately just
 *  the run id: everything else must be RE-READ from the database, never
 *  handed in by the caller being authorized. */
export interface ResumeReasonContext {
  workflowRunId: string;
}

export interface ResumeRule {
  /**
   * Re-read the world and answer "is this reason satisfied?".
   *
   * `null` ⇒ no resume-time predicate; see the module doc for why that is
   * a claim about the tree rather than an omission.
   */
  satisfied: ((ctx: ResumeReasonContext) => Promise<boolean>) | null;
  /**
   * What has to happen for the run to move, in the words a refusal
   * message should use. Present for EVERY row, including the `null` ones,
   * so the policy reads as prose without opening the executor.
   */
  describe: string;
  /**
   * May this reason legitimately appear on a LIVE `suspended` row?
   *
   * `approval-timeout` is written only as a run terminalizes
   * (`workflow-approval-timeout-sweep.ts:206-217` passes it to
   * `finalizeWorkflowRunRow`, which moves the row to `cancelled`), so a
   * live suspended run carrying it means something wrote it out of band.
   * The status guard already refuses such a row; this flag records the
   * expectation so the distinction is not lost when C3 edits the table.
   */
  liveOnSuspendedRow: boolean;
}

/**
 * THE TABLE. One row per reason; adding a member to
 * {@link WorkflowSuspendReason} without a row here does not compile.
 */
export const RESUME_RULES = {
  approval: {
    satisfied: null,
    describe:
      "the parked approval must be answered; the approval step re-reads it on re-entry " +
      "and re-parks while it is pending, expired or cancelled",
    liveOnSuspendedRow: true,
  },
  "nested-suspended": {
    satisfied: null,
    describe:
      "the nested child run must have finished successfully; the workflow step re-finds " +
      "the child by idempotency key on re-entry and re-parks while it is still alive",
    liveOnSuspendedRow: true,
  },
  "orphaned-resumable": {
    satisfied: null,
    describe:
      "nothing — the recovery sweep sets this precisely to mean the run stopped at a " +
      "batch boundary and is safe to continue",
    liveOnSuspendedRow: true,
  },
  "approval-timeout": {
    satisfied: null,
    describe:
      "nothing may resume it — the clock ended this run and the sweep terminalizes it " +
      "as cancelled; the reason survives only as a trace",
    liveOnSuspendedRow: false,
  },
} as const satisfies Record<WorkflowSuspendReason, ResumeRule>;

/**
 * Narrow the free-text column to a known reason.
 *
 * Returns `null` for `NULL`, for the empty string, and for any value this
 * build does not know — a legacy row written before a reason was renamed,
 * or one written by a newer instance during a rolling deploy.
 *
 * **Unknown is deliberately NOT a refusal.** Refusing would leave such a
 * run parked forever with no way out, which is a permanent denial of
 * service on a healthy run — the same failure mode, in slow motion, that
 * routing a transient refusal to `refuseTerminal` produced. An unknown
 * reason falls through to every OTHER guard on the resume path (the
 * status/claim guard, the pending-approval chokepoint, the definition
 * hash, the step-output rehydration) and to the parked step's own
 * re-check, which is what actually enforces today's reasons anyway.
 */
export function parseSuspendReason(raw: string | null | undefined): WorkflowSuspendReason | null {
  if (raw === null || raw === undefined || raw === "") return null;
  return (WORKFLOW_SUSPEND_REASONS as readonly string[]).includes(raw)
    ? (raw as WorkflowSuspendReason)
    : null;
}

/** The rule for a reason, or `null` when the reason is unknown. */
export function resumeRuleFor(reason: WorkflowSuspendReason | null): ResumeRule | null {
  return reason === null ? null : RESUME_RULES[reason];
}

/**
 * May a run carrying `rawReason` resume right now?
 *
 * Reads the reason it is GIVEN — the caller's job is to have re-read it
 * from the row at the decision point, which `resumeWorkflow` does — and
 * then consults the table, awaiting the predicate when there is one.
 *
 * Returns `null` to allow, or a refusal message. The caller must render
 * that as a TRANSIENT refusal: a run whose reason is still outstanding is
 * healthy and waiting, and `refuseTerminal` writes `status="error"`.
 */
export async function resumeReasonRefusal(
  rawReason: string | null | undefined,
  ctx: ResumeReasonContext,
  /**
   * The table to consult. Defaults to {@link RESUME_RULES}; overridden
   * ONLY by tests, so the `satisfied`-predicate branches are exercised
   * through this function rather than through a copy of it. Every row on
   * this tree has `satisfied: null`, so without the seam the refusing
   * branch would be unreachable and untested until C3 landed the first
   * predicate — which is precisely when it must already work.
   */
  rules: Readonly<Record<string, ResumeRule>> = RESUME_RULES,
): Promise<string | null> {
  const reason = parseSuspendReason(rawReason);
  const rule = reason === null ? undefined : rules[reason];
  if (rule === undefined || rule.satisfied === null) return null;
  if (await rule.satisfied(ctx)) return null;
  return `Workflow run ${ctx.workflowRunId} is suspended (${reason}): ${rule.describe}`;
}
