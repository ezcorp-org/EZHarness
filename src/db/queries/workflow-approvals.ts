/**
 * Persistence for parked `approval` steps.
 *
 * One live row per `(workflow_run_id, step_name)` — the unique index is
 * the arbiter, so a step that parks, resumes and parks again UPDATES in
 * place rather than stacking rows the inbox would render twice.
 */
import { and, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import { getDb } from "../connection";
import { delegationHoldsAuthority } from "./workflow-delegations";
import {
  workflowApprovals,
  workflowDelegations,
  workflowRuns,
  type WorkflowApprovalRow,
} from "../schema";

export interface ParkApprovalInput {
  workflowRunId: string;
  stepName: string;
  prompt: string;
  choices: string[];
  rbacScope?: string | null;
  formSchema?: Record<string, unknown> | null;
  requireItemConsent: boolean;
  /** Items requiring consent, resolved at suspend time. */
  itemIds: string[];
  expiresAt?: Date | null;
}

/**
 * Record (or re-record) a step's parked approval and return its id.
 *
 * Re-parking resets the answer columns: a step that was answered, resumed
 * and then parked AGAIN is asking a fresh question, and leaving the
 * previous answer in place would let the next resume read a decision
 * nobody made this time round.
 */
export async function parkWorkflowApproval(row: ParkApprovalInput): Promise<string> {
  const values = {
    workflowRunId: row.workflowRunId,
    stepName: row.stepName,
    prompt: row.prompt,
    choices: row.choices,
    rbacScope: row.rbacScope ?? null,
    formSchema: row.formSchema ?? null,
    requireItemConsent: row.requireItemConsent,
    itemIds: row.itemIds,
    status: "pending" as const,
    expiresAt: row.expiresAt ?? null,
  };
  const [inserted] = await getDb()
    .insert(workflowApprovals)
    .values(values)
    .onConflictDoUpdate({
      target: [workflowApprovals.workflowRunId, workflowApprovals.stepName],
      set: {
        ...values,
        // Explicitly cleared — see the docblock.
        answeredBy: null,
        answerChoice: null,
        answerForm: null,
        answeredItemIds: null,
        consentAllUsed: false,
        updatedAt: sql`NOW()`,
      },
    })
    .returning({ id: workflowApprovals.id });
  return inserted!.id;
}

/** Read one step's approval row, or undefined when it never parked. */
export async function getWorkflowApproval(
  workflowRunId: string,
  stepName: string,
): Promise<WorkflowApprovalRow | undefined> {
  const rows = await getDb()
    .select()
    .from(workflowApprovals)
    .where(
      and(
        eq(workflowApprovals.workflowRunId, workflowRunId),
        eq(workflowApprovals.stepName, stepName),
      ),
    );
  return rows[0];
}

/** Read one approval by id — the answer surfaces' entry point. */
export async function getWorkflowApprovalById(
  id: string,
): Promise<WorkflowApprovalRow | undefined> {
  const rows = await getDb()
    .select()
    .from(workflowApprovals)
    .where(eq(workflowApprovals.id, id));
  return rows[0];
}

export interface RecordAnswerInput {
  choice: string;
  form?: Record<string, unknown> | null;
  itemIds?: string[] | null;
  answeredBy?: string | null;
  consentAllUsed?: boolean;
}

/**
 * Record an answer. CAS on `status='pending'`, so two humans answering
 * the same approval at once produce exactly one winner and the loser is
 * a clean zero-row no-op rather than an overwrite.
 *
 * Returns the number of rows transitioned (0 or 1).
 */
export async function recordWorkflowApprovalAnswer(
  id: string,
  answer: RecordAnswerInput,
): Promise<number> {
  const rows = await getDb()
    .update(workflowApprovals)
    .set({
      status: "answered",
      answerChoice: answer.choice,
      answerForm: answer.form ?? null,
      answeredItemIds: answer.itemIds ?? null,
      answeredBy: answer.answeredBy ?? null,
      consentAllUsed: answer.consentAllUsed ?? false,
      updatedAt: sql`NOW()`,
    })
    .where(and(eq(workflowApprovals.id, id), eq(workflowApprovals.status, "pending")))
    .returning({ id: workflowApprovals.id });
  return rows.length;
}

/**
 * Pending approvals whose `expires_at` has passed, for the timeout sweep.
 *
 * `now` is injected rather than read from the clock so the sweep is
 * testable without waiting — the daemon passes its own injected clock, so
 * a single seam covers both.
 */
export async function listExpiredWorkflowApprovals(
  now: Date,
): Promise<WorkflowApprovalRow[]> {
  return getDb()
    .select()
    .from(workflowApprovals)
    .where(
      and(eq(workflowApprovals.status, "pending"), lte(workflowApprovals.expiresAt, now)),
    );
}

/**
 * Mark a pending approval expired. CAS on `status='pending'` so a human
 * answering in the same instant as the sweep wins or loses cleanly rather
 * than having their answer overwritten by the clock.
 */
export async function expireWorkflowApproval(id: string): Promise<number> {
  const rows = await getDb()
    .update(workflowApprovals)
    .set({ status: "expired", updatedAt: sql`NOW()` })
    .where(and(eq(workflowApprovals.id, id), eq(workflowApprovals.status, "pending")))
    .returning({ id: workflowApprovals.id });
  return rows.length;
}

/**
 * Every pending approval, newest first. **Unscoped — host-side only.**
 *
 * Used by the expiry sweep and by admin surfaces, both of which legitimately
 * see the whole table. Do NOT hand this to a per-user surface: see
 * {@link listPendingWorkflowApprovalsForUser}.
 */
export async function listPendingWorkflowApprovals(): Promise<WorkflowApprovalRow[]> {
  return getDb()
    .select()
    .from(workflowApprovals)
    .where(eq(workflowApprovals.status, "pending"))
    .orderBy(sql`${workflowApprovals.createdAt} DESC`);
}

/** An approval plus the bit of its run a human needs to recognise it. */
export interface PendingApprovalForUser {
  approval: WorkflowApprovalRow;
  workflowName: string;
  workflowRunId: string;
}

/**
 * Pending approvals this user may act on, newest first.
 *
 * An approval carries no owner of its own — the RUN does — so the scoping
 * is a join, not a column filter. That is the whole reason this exists
 * separately from {@link listPendingWorkflowApprovals}: an inbox built on
 * the unscoped list would render every user's parked decisions, including
 * the prompt text, which routinely names what is about to be done and to
 * what.
 *
 * A run with a NULL `user_id` (CLI, extension trigger) is admin-only, for
 * the same reason it is in `workflow-run-control.ts`: "unowned" must not
 * read as "anyone's".
 *
 * ## …except the ONE unowned run that has a named human — C3 (R2-c)
 *
 * A run started by a `owner_kind='service'` delegation has no `user_id`
 * at all: a service account has no `users` row (`db/schema.ts:538`). Under
 * the owner-only rule above such a run was admin-only AND invisible, so
 * `answerApproval` gaining the `delegation` actor kind would have produced
 * an authority that could never be exercised — which amended spec §6.3
 * calls out as worse than admin-only, "because it looks fixed".
 *
 * So the scoping is a DISJUNCTION, and the second arm is not "unowned is
 * anyone's" after all: it is `workflow_delegations.consented_by_user_id`,
 * the ONE named human on a run the account owns. The account owns the run;
 * the human who consented answers for it. Same axis as
 * `mayManageDelegation`'s revoke rule, same column, and the same
 * reason it is that column rather than the owner arms — a service account
 * has no session to answer from.
 *
 * {@link delegationHoldsAuthority} is imported rather than restated: this
 * query decides what a human can SEE and `answerApproval` decides what they
 * can DO, and a row shown here that the chokepoint then refuses is exactly
 * the failure the disjunct exists to prevent.
 *
 * Admins see everything, which is what makes the sweep's view and the
 * admin view the same set.
 */
export async function listPendingWorkflowApprovalsForUser(
  userId: string,
  isAdmin = false,
): Promise<PendingApprovalForUser[]> {
  // The predicate is built first rather than inlined as a ternary in
  // `.where(...)`: drizzle cannot infer the row type through the branch,
  // and an inferred `any` here would silently drop the compile-time link
  // between this projection and the schema.
  const pending = eq(workflowApprovals.status, "pending");
  const scoped = isAdmin
    ? pending
    : and(pending, or(eq(workflowRuns.userId, userId), consentedByCaller(userId)));
  // Cast because drizzle does not infer a partial select through the join
  // in this version — the same shape `workflow-versions.ts` uses for its
  // joined reads. The alias is named so a schema change still has ONE place
  // to update rather than an inline literal per call site.
  const rows = (await getDb()
    .select({ approval: workflowApprovals, workflowName: workflowRuns.workflowName })
    .from(workflowApprovals)
    .innerJoin(workflowRuns, eq(workflowApprovals.workflowRunId, workflowRuns.id))
    // LEFT, not inner: the delegated arm is an ADDITIONAL way to reach a
    // row, never a filter on the ordinary one. Exactly one delegation can
    // match (`delegation_id` is a single FK to a primary key), so this
    // cannot fan a run's approvals out into duplicate inbox entries.
    .leftJoin(workflowDelegations, eq(workflowRuns.delegationId, workflowDelegations.id))
    .where(scoped)
    .orderBy(sql`${workflowApprovals.createdAt} DESC`)) as Array<{
    approval: WorkflowApprovalRow;
    workflowName: string;
  }>;
  return rows.map((r) => ({
    approval: r.approval,
    workflowName: r.workflowName,
    workflowRunId: r.approval.workflowRunId,
  }));
}

/** "This run's delegation names ME as the human who consented to it." */
function consentedByCaller(userId: string) {
  return and(
    eq(workflowDelegations.consentedByUserId, userId),
    delegationHoldsAuthority(),
  );
}

/**
 * The delegated ANSWERING CAPACITY this caller holds over one approval, if
 * any — the fact a surface needs to mint a `delegation`
 * `ApprovalActor` instead of a `user` one.
 *
 * ## It grants nothing
 *
 * Every leg of what it returns is re-proved inside `answerApproval`
 * against the same rows, following PR #58's `holdsClaim`
 * (`runtime/workflow-executor.ts:811-815`): *naming an identity that does
 * not hold the lease proves nothing.* A surface that skipped this call,
 * called it with the wrong id, or fabricated its result changes no
 * decision — it only picks which question the chokepoint is asked.
 *
 * ## Why the run's own owner is excluded
 *
 * The delegated capacity WIDENS reach; it must never narrow it. A caller
 * the run itself names is already answering as themselves, and the
 * `delegation` kind can satisfy no `rbacScope` (only a person can hold a
 * grant), so minting it for the run's owner would take away an answer they
 * could otherwise give. Admins are excluded by the caller for the same
 * reason and are never asked here at all.
 *
 * This is deliberately NARROWER than the inbox disjunct above, and the
 * gap is closed rather than open: every extra row the inbox shows a run's
 * OWNER is answerable by their own `user` actor.
 */
export async function findDelegatedAnswerAuthority(
  approvalId: string,
  userId: string,
): Promise<{ delegationId: string; runId: string } | undefined> {
  const rows = (await getDb()
    .select({ delegationId: workflowDelegations.id, runId: workflowRuns.id })
    .from(workflowApprovals)
    .innerJoin(workflowRuns, eq(workflowApprovals.workflowRunId, workflowRuns.id))
    .innerJoin(workflowDelegations, eq(workflowRuns.delegationId, workflowDelegations.id))
    .where(
      and(
        eq(workflowApprovals.id, approvalId),
        consentedByCaller(userId),
        // `IS DISTINCT FROM`, spelled in two terms: a NULL owner — the
        // service-account case this whole path exists for — is not `<>`
        // anybody in SQL, so `ne` alone would drop exactly the rows that
        // matter.
        or(isNull(workflowRuns.userId), ne(workflowRuns.userId, userId)),
      ),
    )) as Array<{ delegationId: string; runId: string }>;
  return rows[0];
}

/**
 * Is this run parked on an approval nobody has answered?
 *
 * Read by `resumeWorkflow` to refuse a resume that would step over a
 * pending consent gate. That check is what makes `answerApproval` a
 * structural boundary rather than a convention: `resumeWorkflow` is
 * exported, so without it any caller could resume a run parked at an
 * approval and skip the consent rules entirely — and spy-counting the
 * known answer surfaces would prove nothing about that caller.
 */
export async function hasPendingApproval(workflowRunId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: workflowApprovals.id })
    .from(workflowApprovals)
    .where(
      and(
        eq(workflowApprovals.workflowRunId, workflowRunId),
        eq(workflowApprovals.status, "pending"),
      ),
    );
  return rows.length > 0;
}
