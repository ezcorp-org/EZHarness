/**
 * `answerApproval` — the ONE path by which a parked `approval` step is
 * answered.
 *
 * ## Why this module has exactly one export
 *
 * Ported invariant 7. The reference extension this replaces originally
 * had two answer paths, and the second could sidestep the consent rules
 * entirely — a bypass nobody noticed because each path looked correct on
 * its own. The fix is structural, not procedural: every surface (REST,
 * the Hub action, the chat card) calls this function, and everything it
 * does — authorization, the consent guard, the CAS, the resume — is
 * non-exported below it.
 *
 * A future fourth surface therefore cannot *plausibly* reimplement the
 * sequence, because there is nothing exported to reimplement it out of.
 * The accompanying test asserts that by CALL-COUNT on a spy rather than
 * by inspection, so a bypass shows up as a count mismatch rather than
 * relying on a reviewer noticing.
 *
 * ## Order is the contract
 *
 *   exists → still pending → authorized → consent guard → record → resume
 *
 * The first three and the guard are all **read-only**. Nothing mutates
 * until every check has passed, which is what makes ported invariant 17
 * true in the strong sense: *the run is never mutated on a denied
 * answer*, not merely rolled back afterwards.
 */
import type { WorkflowRun } from "../types";
import {
  getWorkflowApprovalById,
  recordWorkflowApprovalAnswer,
} from "../db/queries/workflow-approvals";
import { getWorkflowRunRow } from "../db/queries/workflow-runs";
import { requireItemConsent } from "./workflow-approval-guard";
import { resumeArgsFromRow } from "./workflow-executor";
import {
  getWorkflowRuntime,
  type WorkflowRuntime,
} from "./workflow/runtime-registry";
import { logger } from "../logger";

const log = logger.child("workflow.approval");

/** What a surface passes in. Shape-identical across all three. */
export interface ApprovalAnswerInput {
  choice: string;
  form?: Record<string, unknown>;
  itemIds?: string[];
  /** Explicit standing consent for an ids-free bulk clear. Always
   *  recorded when used. */
  consentAll?: boolean;
}

/** Who is answering. `userId` is null for a system/timeout answer. */
export interface ApprovalActor {
  userId: string | null;
  /** Admins may answer any approval, including one on an unowned run. */
  isAdmin?: boolean;
}

export type AnswerApprovalResult =
  | { ok: true; run: WorkflowRun; consentAllUsed: boolean }
  | { ok: false; code: AnswerApprovalRefusal; message: string };

/**
 * Why an answer was refused. Distinct codes so a surface can map them to
 * its own status conventions without re-deriving the reason — REST wants
 * 404/403/409/400, the chat card wants a sentence.
 */
export type AnswerApprovalRefusal =
  | "not-found"
  | "not-pending"
  | "forbidden"
  | "invalid-answer"
  | "run-unavailable"
  | "resume-failed"
  | "lost-race";

export interface AnswerApprovalDeps {
  /**
   * Resolve whether the actor holds a scope.
   *
   * **A throw is a DENY**, never a silent allow — ported invariant 17.
   * An identity the host cannot resolve must not satisfy a grant, and
   * the refusal is shaped like a 403 rather than surfacing as a 500.
   */
  checkScope?: (scope: string, userId: string | null) => Promise<boolean>;
  /** Test seam. Defaults to the registered live runtime. */
  runtime?: WorkflowRuntime | null;
}

/**
 * Answer a parked approval and resume its run.
 *
 * Returns a refusal rather than throwing for every *expected* rejection,
 * so the surfaces — and later the timeout sweep, which answers on the
 * clock's behalf — are not written around exceptions.
 */
export async function answerApproval(
  approvalId: string,
  answer: ApprovalAnswerInput,
  actor: ApprovalActor,
  deps: AnswerApprovalDeps = {},
): Promise<AnswerApprovalResult> {
  const approval = await getWorkflowApprovalById(approvalId);
  if (!approval) {
    return { ok: false, code: "not-found", message: `Approval ${approvalId} not found` };
  }
  if (approval.status !== "pending") {
    // Already answered, expired or cancelled. Reported distinctly from
    // "not found" so a surface can say "someone got there first" rather
    // than implying the approval never existed.
    return {
      ok: false,
      code: "not-pending",
      message: `Approval ${approvalId} is already ${approval.status}`,
    };
  }

  // ── Authorization (read-only) ──────────────────────────────────────
  //
  // Two rules, and the SECOND one used to be missing entirely.
  //
  //   • A declared `rbacScope` decides. That is the documented way to say
  //     "answering this needs a permission", and it deliberately does NOT
  //     also require ownership — an approval can be raised precisely so
  //     that someone other than the run's owner (a reviewer) answers it.
  //
  //   • With NO scope declared, the run's OWNER decides. Before this
  //     branch existed, an approval that declared no scope — which is the
  //     default, and what every `approval` step without an `rbacScope:`
  //     produces — was answerable by ANY authenticated caller on ANY run.
  //     The scope check simply did not run, and nothing else consulted the
  //     run at all, so a stranger could clear another user's consent gate
  //     through either answer surface.
  //
  // A NULL `user_id` (CLI, extension trigger) is admin-only, matching
  // `workflow-run-control.ts` and the inbox query: "unowned" must never
  // read as "anyone's".
  if (!approval.rbacScope) {
    const runRow = await getWorkflowRunRow(approval.workflowRunId);
    const owns =
      actor.isAdmin === true ||
      (runRow?.userId != null && actor.userId != null && runRow.userId === actor.userId);
    if (!owns) {
      return {
        ok: false,
        code: "forbidden",
        message: "Not permitted to answer this approval",
      };
    }
  }
  if (approval.rbacScope) {
    let granted: boolean;
    try {
      granted = (await deps.checkScope?.(approval.rbacScope, actor.userId)) ?? false;
    } catch (err) {
      // An unresolvable identity or a host error can never satisfy a
      // grant. Logged, because a scope check that throws is a real
      // signal even though the caller only sees a refusal.
      log.warn("approval scope check threw — denying", {
        approvalId,
        scope: approval.rbacScope,
        error: String(err),
      });
      granted = false;
    }
    if (!granted) {
      return {
        ok: false,
        code: "forbidden",
        message: `You need the "${approval.rbacScope}" permission to answer this approval`,
      };
    }
  }

  // ── Consent (read-only) ────────────────────────────────────────────
  const guard = requireItemConsent(
    {
      choices: approval.choices ?? [],
      requireItemConsent: approval.requireItemConsent,
      itemIds: approval.itemIds ?? [],
    },
    {
      choice: answer.choice,
      ...(answer.itemIds !== undefined ? { itemIds: answer.itemIds } : {}),
      ...(answer.consentAll !== undefined ? { consentAll: answer.consentAll } : {}),
    },
  );
  if (!guard.ok) {
    return { ok: false, code: "invalid-answer", message: guard.error ?? "Answer refused" };
  }

  // Everything above this line is read-only. Nothing has touched the
  // approval or its run, so a denied answer leaves both exactly as they
  // were.

  const runtime = deps.runtime !== undefined ? deps.runtime : getWorkflowRuntime();
  const runRow = await getWorkflowRunRow(approval.workflowRunId);
  // The run must actually be resumable. This check was PROMISED by the
  // comment below and not implemented, which left the guarantee stated
  // and false: a run terminalized while its approval was still pending
  // would have its answer recorded and spent, then fail to resume, and
  // the caller would be told it succeeded.
  if (runRow && runRow.status !== "suspended") {
    return {
      ok: false,
      code: "run-unavailable",
      message: `Workflow run ${runRow.id} is ${runRow.status}, not suspended, so it cannot be resumed`,
    };
  }
  if (!runtime || !runRow) {
    // Refuse BEFORE recording: an answer written against a run we cannot
    // then resume would leave the approval `answered` and the run parked
    // forever, with no surface able to try again.
    return {
      ok: false,
      code: "run-unavailable",
      message: !runRow
        ? `Workflow run ${approval.workflowRunId} not found`
        : "Workflow runtime is not available to resume this run",
    };
  }
  const workflow = runtime.getWorkflows().find((w) => w.name === runRow.workflowName);
  if (!workflow) {
    return {
      ok: false,
      code: "run-unavailable",
      message: `Workflow "${runRow.workflowName}" is no longer defined, so run ${runRow.id} cannot be resumed`,
    };
  }

  // ── Record (CAS) ───────────────────────────────────────────────────
  const consentAllUsed = guard.consentAllUsed === true;
  const recorded = await recordWorkflowApprovalAnswer(approval.id, {
    choice: answer.choice,
    form: answer.form ?? null,
    itemIds: answer.itemIds ?? null,
    answeredBy: actor.userId,
    consentAllUsed,
  });
  if (recorded === 0) {
    // Someone answered between our status read and this write. The CAS
    // is what makes that a clean loss rather than an overwrite of their
    // decision.
    return {
      ok: false,
      code: "lost-race",
      message: `Approval ${approvalId} was answered by someone else first`,
    };
  }
  if (consentAllUsed) {
    // A blanket clear is permitted but never silent — recorded on the
    // row AND surfaced in the log.
    log.info("approval cleared with standing consent (no named itemIds)", {
      approvalId,
      workflowRunId: approval.workflowRunId,
      stepName: approval.stepName,
      answeredBy: actor.userId,
    });
  }

  // ── Resume ─────────────────────────────────────────────────────────
  const run = await runtime.workflowExecutor.resumeWorkflow(
    workflow,
    resumeArgsFromRow(runRow),
  );
  // A resume that came back `error` is NOT a successful answer. Returning
  // `ok: true` here mapped to HTTP 200, telling the user their approval
  // landed while the workflow was dead and their answer already spent.
  // The answer IS recorded — the human really did decide — so the
  // message says both things rather than pretending nothing happened.
  if (run.status === "error") {
    const detail =
      run.result?.error && typeof run.result.error === "object"
        ? run.result.error.message
        : String(run.result?.error ?? "unknown error");
    return {
      ok: false,
      code: "resume-failed",
      message: `Your answer was recorded, but run ${run.id} could not continue: ${detail}`,
    };
  }
  return { ok: true, run, consentAllUsed };
}
