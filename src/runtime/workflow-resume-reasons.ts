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
 *   - `approval` — `runApprovalStep` (`workflow-executor.ts:2604-2662`)
 *     re-reads the `workflow_approvals` row and re-parks unless it is
 *     `answered`. `expired` re-parks DELIBERATELY (`:2637-2640`), so an
 *     approval that merely timed out never admits the run.
 *   - `nested-suspended` — `runNestedWorkflow` re-finds the child by its
 *     idempotency key (`:2051-2056`) and `nestedOutcome` (`:2452-2460`)
 *     re-throws while that child reads `suspended` / `running`, so the
 *     parent cannot pass a child that is still waiting, and no duplicate
 *     child is dispatched.
 *
 * Both facts are pinned by mutation in
 * `src/__tests__/workflow-resume-reason-gate.test.ts`: remove either
 * re-check and the bypass becomes real, and the suite fails.
 *
 * C3's two rows are different in kind, which is why this table had to
 * exist before they landed: **nothing re-checks a spend cap when a run
 * re-enters an approval step.** A run parks on a normal `approval`, a cap
 * trips and rewrites the reason to `budget-exceeded`, the human answers
 * the approval — and the approval step is satisfied, so the run proceeds
 * with the cap never consulted. That is the R-3 escalation, and it is
 * closed by giving `budget-exceeded` a `satisfied` predicate here rather
 * than by hoping a step asks. Both C3 rows are now in the table below,
 * and both re-read from the database at the decision point.
 */

import { readWorkflowRunDelegationBudget, sumWorkflowRunTokens } from "../db/queries/workflow-runs";

/**
 * Every value production writes to `workflow_runs.suspended_reason`.
 *
 * Enumerated from the writers, not from the plan documents — the column
 * is free-text `TEXT` (`db/schema.ts:786`) and carries no DB-level enum,
 * so this union is the only place the set is stated. Every writer below
 * was re-verified against the tree at the C3 integration:
 *
 *   - `"approval"` — `workflow-executor.ts:2662`
 *   - `"nested-suspended"` — `workflow-executor.ts:2460`
 *   - `"orphaned-resumable"` — `db/queries/workflow-runs.ts:880`
 *   - `"approval-timeout"` — `workflow-approval-timeout-sweep.ts:236`
 *     (the value itself is the `TIMEOUT_REASON` const at `:107`)
 *   - `"budget-exceeded"` — `workflow-executor.ts:664`, thrown by the
 *     step-boundary token check `enforceDelegatedTokenBudget` (C3 phase B)
 *   - `"consent-stale"` — `extensions/workflows-handler.ts:1765`, the
 *     `parkConsentStaleRun` write on rung D6 of the delegated ladder
 *     (C3 phase 6)
 *
 * `"consent-stale"` USED to be documented here as "the ONE member of this
 * union with no writer on the tree yet", held ahead of its writer so that
 * a `consent-stale` row could never parse to `null` and therefore
 * **allow** during the window before phase 6 landed. Phase 6 landed it:
 * the fire-time consent recompute detects the mismatch and parks the run,
 * so the union no longer claims a value the column never carries and the
 * rule above ("enumerated from the writers") now holds without exception.
 *
 * The `quota` value in `docs/plans/*` is NOT here: it has no writer and no
 * phase that needs it.
 */
export type WorkflowSuspendReason =
  | "approval"
  | "nested-suspended"
  | "orphaned-resumable"
  | "approval-timeout"
  | "budget-exceeded"
  | "consent-stale";

/** The reasons, as a value, for tests and for exhaustiveness checks. */
export const WORKFLOW_SUSPEND_REASONS = [
  "approval",
  "nested-suspended",
  "orphaned-resumable",
  "approval-timeout",
  "budget-exceeded",
  "consent-stale",
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
  // ── C3 ── The first two reasons NO step re-entry can defend ────────
  //
  // Everything above carries `satisfied: null` because the step the
  // cursor re-enters re-verifies the condition against the authoritative
  // object. These two have no such step: no step owns a run-scoped
  // budget, and no step re-checks consent. A run that parked for either
  // and then had its `approval` answered would re-enter `runApprovalStep`,
  // find the approval `answered`, and proceed — with the cap never
  // consulted. That is why these rows carry a real predicate, and it is
  // the whole justification for this table having existed before them.
  "budget-exceeded": {
    /**
     * Re-read BOTH halves — what the run has spent and what it is allowed
     * to spend — from the database, and allow only while it is strictly
     * under. Neither number is carried in from anywhere:
     * {@link ResumeReasonContext} deliberately hands a predicate nothing
     * but a run id, so a caller cannot assert its own budget is fine.
     *
     * Fails CLOSED when the delegation is gone or revoked. That is the
     * opposite of {@link parseSuspendReason}'s "unknown allows", and the
     * asymmetry is deliberate: an unknown reason is a rolling-deploy or
     * legacy artefact on a HEALTHY run, while a run parked here is over
     * budget by construction, so a missing cap is not evidence that it is
     * under one. There is no denial-of-service in refusing — raising the
     * cap or re-consenting is a live route out, and it is the only one.
     *
     * Answering an approval is deliberately NOT a route out: this
     * predicate never looks at `workflow_approvals`.
     */
    satisfied: async ({ workflowRunId }) => {
      const budget = await readWorkflowRunDelegationBudget(workflowRunId);
      if (budget === null || !budget.live) return false;
      return (await sumWorkflowRunTokens(workflowRunId)) < budget.maxTokensPerRun;
    },
    describe:
      "the run has spent its delegation's whole max_tokens_per_run; only raising that " +
      "cap lets it continue — answering an approval does not, and cannot",
    liveOnSuspendedRow: true,
  },
  "consent-stale": {
    /**
     * Allow only once the delegation has been RE-CONSENTED during this
     * run — `consented_at` strictly after the run's own `started_at`. A
     * run is dispatched under a consent that was already current, so any
     * later `consented_at` is a re-consent that happened while this run
     * was parked or alive.
     *
     * ## What this predicate deliberately does NOT do
     *
     * It does not recompute the consent hash. That recompute needs the
     * workflow definition and the OWNER'S-AND-KIND'S closure resolver
     * (a `service` delegation sees a smaller graph than a `user` one),
     * and {@link ResumeReasonContext} carries a run id and nothing else —
     * on purpose, so that no predicate here can be handed a fact instead
     * of reading one. Widening the context to smuggle a resolver in would
     * trade this module's whole guarantee for a check that already exists
     * somewhere better: the authoritative comparison is the fire-time /
     * boundary recompute, which is where a mismatch is DETECTED and this
     * reason is written.
     *
     * So this row is the resume-time FLOOR, and it is exact in the
     * direction that matters: a run whose consent went stale and for
     * which nobody re-consented can never be resumed, by anyone, through
     * any path. The residue is one bounded imprecision — if the graph
     * goes stale AGAIN after a re-consent, this allows the resume and the
     * next boundary recompute re-parks the run. That costs one batch, and
     * closing it would mean storing the park-time hash on the run row.
     */
    satisfied: async ({ workflowRunId }) => {
      const budget = await readWorkflowRunDelegationBudget(workflowRunId);
      if (budget === null || !budget.live) return false;
      return budget.consentedAt.getTime() > budget.runStartedAt.getTime();
    },
    describe:
      "what the human consented to has changed under the run; only a fresh consent on " +
      "the delegation lets it continue, and only from the user who holds it",
    liveOnSuspendedRow: true,
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
