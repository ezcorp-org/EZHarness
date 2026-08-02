/**
 * Operator control over a durable workflow run: resume it, or cancel it.
 *
 * Both live here, together, because they are the two halves of one
 * decision — "this parked run should continue" / "this parked run should
 * not" — and they share every precondition that makes either safe: the run
 * must exist, the caller must own it, and it must still be in a state
 * where the answer means anything.
 *
 * ## These are NOT an approval-answering path
 *
 * `answerApproval` is the ONE way a parked `approval` step is answered
 * (ported invariant 7). {@link resumeParkedRun} deliberately does not take
 * a choice, does not touch `workflow_approvals`, and cannot clear a
 * pending consent gate: `WorkflowExecutor.resumeWorkflow` refuses a run
 * with an unanswered approval (`approval-pending`) and that refusal is
 * TRANSIENT, so the run stays parked and answerable.
 *
 * This module relies on that guard rather than re-deriving it. Re-checking
 * here would create a second opinion about when consent is satisfied,
 * which is exactly the drift invariant 7 exists to prevent — and a second
 * opinion that silently agreed today would be free to disagree tomorrow.
 * The accompanying test asserts the refusal by driving a real pending
 * approval through this function, not by reading the code.
 *
 * What resume IS for: a run parked for any other reason, and a run whose
 * approval was answered while the process that would have continued it was
 * gone. The daemon covers the common case automatically; this is the
 * manual lever for an operator who does not want to wait for a tick.
 */
import { logger } from "../logger";
import {
  finalizeWorkflowRunRow,
  getWorkflowRunRow,
} from "../db/queries/workflow-runs";
import { resumeArgsFromRow } from "./workflow-executor";
import {
  getWorkflowRuntime,
  type WorkflowRuntime,
} from "./workflow/runtime-registry";
import type { WorkflowRun } from "../types";

const log = logger.child("workflow.run-control");

/** Typed refusals, mirroring `answerApproval`'s contract: every surface
 *  maps these to its own conventions without re-deciding what they mean. */
export type RunControlCode =
  | "not-found"
  | "forbidden"
  | "not-resumable"
  | "already-terminal"
  | "run-unavailable"
  | "resume-failed";

export type RunControlResult =
  | { ok: true; run: WorkflowRun }
  | { ok: true; cancelled: true }
  | { ok: false; code: RunControlCode; message: string };

export interface RunActor {
  userId: string;
  /** Admins may act on any run; everyone else only on their own. */
  isAdmin?: boolean;
}

export interface RunControlDeps {
  /** Override the runtime lookup. Tests stub the executor + cache. */
  runtime?: WorkflowRuntime | null;
}

/**
 * Owner check — the ONE opinion about who a workflow run belongs to.
 *
 * A run with a NULL `user_id` (a CLI run, an extension trigger) has no
 * owner to compare against, so only an admin may act on it. Treating
 * "unowned" as "anyone's" would make every CLI-started run controllable by
 * every logged-in member.
 *
 * ## Also governs READING a run, and is deliberately narrower than C6
 *
 * The trace read (`workflow-run-trace.ts`) routes through this rather than
 * through `resolveWorkflowForCaller`. That looks backwards — C6 landed the
 * richer ladder — but the C6 ladder answers a question about the
 * WORKFLOW, and for `visibility: 'system'` its answer for `read` is
 * "anyone". Every row that existed at C6's migration is `system`, so
 * routing a run trace through it would let any authenticated caller read
 * any other user's `resolved_input` and `output` for a shared workflow.
 *
 * A run's payload belongs to whoever fired it, not to whoever may see the
 * graph. So workflow visibility can only ever NARROW this, never widen it,
 * and today this predicate alone is the whole rule.
 *
 * The two surfaces differ only in how a refusal RENDERS: control returns
 * 403 (the caller already knows the run exists — they named it and got a
 * real answer from a sibling surface), while the read returns 404, so the
 * endpoint is not an existence oracle for runs the caller may not see.
 */
export function mayControlRun(rowUserId: string | null, actor: RunActor): boolean {
  if (actor.isAdmin === true) return true;
  return rowUserId !== null && rowUserId === actor.userId;
}

/** Local alias — the module's own call sites read better unqualified. */
const mayControl = mayControlRun;

/**
 * Continue a parked run.
 *
 * Refuses anything not `suspended`: a `running` run is already being
 * driven (by the synchronous path or by a daemon holding its lease), and
 * resuming it a second time would execute the same batch twice.
 */
export async function resumeParkedRun(
  runId: string,
  actor: RunActor,
  deps: RunControlDeps = {},
): Promise<RunControlResult> {
  const row = await getWorkflowRunRow(runId);
  if (!row) return { ok: false, code: "not-found", message: `Workflow run ${runId} not found` };
  if (!mayControl(row.userId, actor)) {
    // Deliberately the same shape a stranger gets for a run that exists —
    // 403 either way, message names no detail of the run.
    return { ok: false, code: "forbidden", message: "Not permitted to control this workflow run" };
  }
  if (row.status !== "suspended") {
    return {
      ok: false,
      code: "not-resumable",
      message: `Workflow run ${runId} is ${row.status}, not suspended, so it cannot be resumed`,
    };
  }

  const runtime = deps.runtime !== undefined ? deps.runtime : getWorkflowRuntime();
  if (!runtime) {
    return {
      ok: false,
      code: "run-unavailable",
      message: "Workflow runtime is not available to resume this run",
    };
  }
  const workflow = runtime.getWorkflows().find((w) => w.name === row.workflowName);
  if (!workflow) {
    return {
      ok: false,
      code: "run-unavailable",
      message: `Workflow "${row.workflowName}" is no longer defined, so run ${runId} cannot be resumed`,
    };
  }

  const run = await runtime.workflowExecutor.resumeWorkflow(workflow, resumeArgsFromRow(row));
  // Branch on the ERROR, not on the status.
  //
  // `resumeWorkflow` has two refusal shapes and only one of them is
  // terminal. A drift refusal comes back `status: "error"`; a TRANSIENT
  // refusal — the pending-approval guard is the one that matters — comes
  // back `status: "suspended"` with the reason in `result.error`, because
  // the run is deliberately left alive and answerable.
  //
  // Checking `status === "error"` therefore reports the single most
  // important refusal in this module as a SUCCESS: a caller trying to step
  // over a consent gate would get 200 and a run object, while the run sat
  // exactly where it was. The presence of an error is the property; the
  // status is merely adjacent to it.
  if (run.result?.error !== undefined) {
    const detail =
      typeof run.result.error === "object" ? run.result.error.message : String(run.result.error);
    return { ok: false, code: "resume-failed", message: `Run ${runId} could not continue: ${detail}` };
  }
  log.info("run resumed by operator", { runId, status: run.status, by: actor.userId });
  return { ok: true, run };
}

/**
 * Cancel a run.
 *
 * `finalizeWorkflowRunRow` CASes on `status IN ('running','suspended')`,
 * so this is race-safe against a run that finished a moment ago: zero rows
 * means someone else decided its fate first, reported as
 * `already-terminal` rather than as a success that changed nothing.
 *
 * Cancelling a `running` run marks the ROW cancelled; it does not reach
 * into an in-flight batch to stop it. That is honest rather than
 * convenient: the executor owns its own abort signal, and a row that says
 * `cancelled` while a step keeps running would be the more misleading of
 * the two states. A daemon-held run stops at its next boundary because
 * the row is no longer `running` for it to advance.
 */
export async function cancelParkedRun(
  runId: string,
  actor: RunActor,
): Promise<RunControlResult> {
  const row = await getWorkflowRunRow(runId);
  if (!row) return { ok: false, code: "not-found", message: `Workflow run ${runId} not found` };
  if (!mayControl(row.userId, actor)) {
    return { ok: false, code: "forbidden", message: "Not permitted to control this workflow run" };
  }

  const moved = await finalizeWorkflowRunRow(runId, "cancelled", {
    success: false,
    output: null,
    error: `Workflow run cancelled by ${actor.userId}`,
  });
  if (moved === 0) {
    return {
      ok: false,
      code: "already-terminal",
      message: `Workflow run ${runId} is ${row.status} and can no longer be cancelled`,
    };
  }
  log.info("run cancelled by operator", { runId, by: actor.userId });
  return { ok: true, cancelled: true };
}
