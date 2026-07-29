/**
 * Persistence for parked `approval` steps.
 *
 * One live row per `(workflow_run_id, step_name)` — the unique index is
 * the arbiter, so a step that parks, resumes and parks again UPDATES in
 * place rather than stacking rows the inbox would render twice.
 */
import { and, eq, lte, sql } from "drizzle-orm";
import { getDb } from "../connection";
import { workflowApprovals, type WorkflowApprovalRow } from "../schema";

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

/** Pending approvals for the inbox, newest first. */
export async function listPendingWorkflowApprovals(): Promise<WorkflowApprovalRow[]> {
  return getDb()
    .select()
    .from(workflowApprovals)
    .where(eq(workflowApprovals.status, "pending"))
    .orderBy(sql`${workflowApprovals.createdAt} DESC`);
}
