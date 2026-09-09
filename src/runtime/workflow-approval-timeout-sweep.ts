/**
 * The clock's half of an `approval` step: apply `onTimeout` to a parked
 * decision whose deadline has passed.
 *
 * `expires_at` is written at suspend time (`workflow-executor.ts`), the
 * inbox renders it, and until this module existed nothing ever read it —
 * a deadline the system advertised and never enforced. This is the reader.
 *
 * ## The one rule that makes the rest of the file make sense
 *
 * **A row is never expired without its policy also being applied.**
 *
 * An `expired` approval deliberately RE-PARKS when the step is re-entered
 * (`workflow-executor.ts:1494-1499`: "the sweep decides what an expiry
 * MEANS via `onTimeout`"). So a sweep that only flipped the status would
 * hand the run straight back to the executor, which would re-park it with
 * a FRESH `expires_at`, which this sweep would expire again — a run
 * ping-ponging between `expired` and `pending` forever, doing nothing,
 * looking busy. Every path below therefore either applies a policy or
 * leaves the row exactly as it found it.
 *
 * ## Three refusals the clock must never talk its way past
 *
 * The sweep answers through `answerApproval` — the single chokepoint
 * (ported invariant 7) — and that function is FULL of checks written for
 * a human answerer. Three of them the clock cannot legitimately satisfy,
 * and in each case the right move is to fail closed to `abort` rather
 * than to widen the check:
 *
 *   1. **Ownership.** With no `rbacScope` declared, the run's owner
 *      answers, and an unowned run is admin-only. A sweep answering as
 *      nobody lands in exactly that branch. Resolved by an explicit
 *      system actor — see {@link SYSTEM_ACTOR}, which is a security
 *      statement and is commented as one.
 *   2. **`rbacScope`.** A scope says "answering this needs a permission".
 *      The clock holds none, and a `checkScope` that returned true would
 *      be the clock granting itself every permission in the system.
 *      `answerApproval` refuses a `system-timeout` actor on the scoped
 *      branch by KIND, before any `checkScope` is consulted — so this
 *      holds because of what the actor IS, not because this file
 *      remembers not to pass a resolver.
 *   3. **Item consent.** A gate with outstanding items requires the
 *      answer to NAME them. The sweep will not send `consentAll` and will
 *      not echo back the offered list — those are the two shapes of
 *      consent laundering `requireItemConsent` exists to prevent. A human
 *      did not decide, so the clock does not pretend one did.
 *
 * In all three the run is `cancelled`, loudly, with the reason on the row.
 * That is the conservative reading of "this decision timed out and nobody
 * with standing was able to make it".
 */
import type { WorkflowApprovalRow } from "../db/schema";
import type { ApprovalTimeoutPolicy } from "../types";
import {
  expireWorkflowApproval,
  listExpiredWorkflowApprovals,
} from "../db/queries/workflow-approvals";
import {
  finalizeWorkflowRunRow,
  getWorkflowRunRow,
} from "../db/queries/workflow-runs";
import { answerApproval } from "./workflow-answer-approval";
import { getWorkflowRuntime, workflowResumeEntry, type WorkflowRuntime } from "./workflow/runtime-registry";
import { workflowReleaseCanAccess } from "./workflow-release-assets";
import { workflowExecutionHash } from "./workflow-definition-hash";
import { logger } from "../logger";

const log = logger.child("workflow.approval-timeout");

/**
 * Who the sweep answers as.
 *
 * **The timeout sweep bypasses the owner check.** It has to:
 * `answerApproval` requires the run's owner when no `rbacScope` is
 * declared — the default — and a run with a NULL `user_id` is admin-only,
 * so a sweep answering as nobody would be refused on every approval it
 * will ever see, silently, with the row left pending and every test that
 * only asserted "the sweep ran" still green.
 *
 * ## Why this is now one word instead of a paragraph
 *
 * This used to be `{ userId: null, isAdmin: true }`, and the paragraph
 * that followed it explained at length that the clock must never satisfy
 * a declared `rbacScope` — a rule enforced *only* by this module
 * declining to pass a `checkScope`. At `answerApproval`'s decision point
 * the clock and a real admin were the same value, so the guarantee lived
 * in prose and in an omission, and anyone who later handed this call a
 * `checkScope` would have given the clock every permission in the system
 * without a single test failing.
 *
 * `kind: "system-timeout"` moves that guarantee into the type.
 * `answerApproval` refuses this kind on the scoped branch *before*
 * consulting `checkScope` at all, so the refusal no longer depends on
 * what this file remembers not to pass. `answered_by` is likewise derived
 * from the kind, so an answer nobody made cannot be attributed to
 * somebody.
 *
 * The distinction the prose was carrying: bypassing "who owns this run"
 * is a housekeeping decision the author already made by writing
 * `onTimeout:`; satisfying a declared `rbacScope` would be the clock
 * awarding itself a permission a human was required to hold. The first is
 * a deadline, the second is a privilege escalation — and now only the
 * first is expressible.
 */
const SYSTEM_ACTOR = { kind: "system-timeout" } as const;

/** `suspended_reason` left on an aborted run, per C4 §4.4 — the trace has
 *  to say the CLOCK ended this run, not a person. */
const TIMEOUT_REASON = "approval-timeout";

/** What one sweep pass did. Every expired row lands in exactly one bucket. */
export interface ApprovalTimeoutSweepResult {
  /** Pending rows whose deadline had passed when the sweep looked. */
  scanned: number;
  /** Policy applied by answering: the run was resumed. */
  answered: number;
  /** Policy applied by failing closed: the run is `cancelled`. */
  aborted: number;
  /** Left pending on purpose — the policy could not be READ, or the run
   *  was momentarily unavailable. Retried on the next tick. */
  deferred: number;
  /** A human (or another sweep) decided it first. Not an error. */
  raced: number;
}

export interface ApprovalTimeoutSweepOptions {
  /** Injected clock — the sweep is driven by the daemon's `now`, never by
   *  a wall clock of its own, so a test never has to wait. */
  now: Date;
  /** Test seam. Defaults to the registered live runtime. */
  runtime?: WorkflowRuntime | null;
}

const EMPTY: ApprovalTimeoutSweepResult = {
  scanned: 0,
  answered: 0,
  aborted: 0,
  deferred: 0,
  raced: 0,
};

/**
 * Apply `onTimeout` to every approval whose deadline has passed.
 *
 * Sequential rather than concurrent: the population is small (a parked
 * decision is rare and a deadline rarer), each iteration may resume a
 * workflow, and resuming N of them at once would put the daemon in
 * competition with `WorkflowRunner`'s concurrency caps while holding none
 * of its leases.
 */
export async function sweepExpiredWorkflowApprovals(
  opts: ApprovalTimeoutSweepOptions,
): Promise<ApprovalTimeoutSweepResult> {
  const runtime = opts.runtime !== undefined ? opts.runtime : getWorkflowRuntime();
  const expired = await listExpiredWorkflowApprovals(opts.now);
  const result: ApprovalTimeoutSweepResult = { ...EMPTY, scanned: expired.length };

  for (const approval of expired) {
    // The run is what names the workflow; the approval row does not carry
    // it. Read once — the policy lookup needs it, and a missing run means
    // there is no policy to read.
    const runRow = await getWorkflowRunRow(approval.workflowRunId);
    const policy = await resolvePolicy(approval, runRow, runtime);
    if (policy === undefined) {
      // The policy lives on the DEFINITION, not on the row. Without one
      // we do not know what the author asked for, and "abort" is not a
      // safe guess: on a backend-only boot nothing is registered, so
      // guessing would cancel every parked run on the host.
      log.warn("approval expired but its policy is unreadable — left pending", {
        approvalId: approval.id,
        workflowRunId: approval.workflowRunId,
        stepName: approval.stepName,
      });
      result.deferred++;
      continue;
    }
    if (policy === "abort") {
      applyOutcome(result, await abortRun(approval, "its approval timed out"));
      continue;
    }
    applyOutcome(result, await answerOnTimeout(approval, policy, runtime));
  }

  if (result.scanned > 0) {
    log.info("approval timeout sweep", { ...result });
  }
  return result;
}

/** One approval's fate, as the buckets in {@link ApprovalTimeoutSweepResult}. */
type Outcome = "answered" | "aborted" | "deferred" | "raced";

function applyOutcome(result: ApprovalTimeoutSweepResult, outcome: Outcome): void {
  result[outcome]++;
}

/**
 * Read the step's `onTimeout`, or `undefined` when it cannot be read.
 *
 * `undefined` and `"abort"` are genuinely different answers and the
 * distinction is the whole reason this returns a union rather than
 * defaulting inline: a step that declares no `onTimeout` means abort (the
 * documented default), while a definition we cannot resolve means we have
 * no idea, and those two must not share a code path that cancels runs.
 */
async function resolvePolicy(
  approval: WorkflowApprovalRow,
  row: Awaited<ReturnType<typeof getWorkflowRunRow>>,
  runtime: WorkflowRuntime | null,
): Promise<ApprovalTimeoutPolicy | undefined> {
  if (!runtime || !row) return undefined;
  const entry = workflowResumeEntry(runtime, row.workflowName);
  if (!entry || !await workflowReleaseCanAccess(entry, row.userId, row.projectId)) return undefined;
  if (entry.source === "extension" && row.definitionHash !== workflowExecutionHash(entry.definition, entry.extensionRelease)) return undefined;
  const step = entry.definition.steps.find((step) => step.name === approval.stepName);
  if (!step) return undefined;
  return step.onTimeout ?? "abort";
}

/**
 * Fail closed: expire the row, then cancel the run.
 *
 * The CAS on the row is the gate for BOTH writes. If it matches zero rows
 * a human answered in the same instant, and their decision — already
 * recorded, possibly already resumed — must not then have its run
 * cancelled out from under it.
 */
async function abortRun(approval: WorkflowApprovalRow, why: string): Promise<Outcome> {
  const expired = await expireWorkflowApproval(approval.id);
  if (expired === 0) return "raced";

  const moved = await finalizeWorkflowRunRow(
    approval.workflowRunId,
    "cancelled",
    {
      success: false,
      output: null,
      error: `Workflow run cancelled: ${why} (step "${approval.stepName}")`,
    },
    { suspendedReason: TIMEOUT_REASON },
  );
  if (moved === 0) {
    // The row is expired and the run was already terminal. Nothing is
    // inconsistent — a cancelled run's approval SHOULD read `expired` —
    // but it is worth saying out loud that the clock arrived second.
    log.info("approval expired on a run that was already terminal", {
      approvalId: approval.id,
      workflowRunId: approval.workflowRunId,
    });
  } else {
    log.warn("approval timed out — run cancelled", {
      approvalId: approval.id,
      workflowRunId: approval.workflowRunId,
      stepName: approval.stepName,
      reason: why,
    });
  }
  return "aborted";
}

/**
 * Apply `approve` / `skip` by answering through the chokepoint.
 *
 * The synthetic answer's `choice` IS the policy name (C4 §4.4), which is
 * why the validator requires `onTimeout: approve|skip` to declare that
 * string in the step's `choices`: an answer outside the declared set is
 * rejected, never coerced, and downstream `$steps.<gate>.output.choice`
 * refs read the same vocabulary the author wrote.
 *
 * A definition stored before that rule existed still reaches here, so the
 * refusal mapping below is load-bearing rather than defensive.
 */
async function answerOnTimeout(
  approval: WorkflowApprovalRow,
  policy: Exclude<ApprovalTimeoutPolicy, "abort">,
  runtime: WorkflowRuntime | null,
): Promise<Outcome> {
  const res = await answerApproval(
    approval.id,
    { choice: policy },
    SYSTEM_ACTOR,
    // No `checkScope`, and it no longer MATTERS that there is none: a
    // `system-timeout` actor is refused on the scoped branch by kind. A
    // scoped approval therefore refuses here and falls through to
    // `abort` below, which is the point — and it would still refuse if
    // someone added a resolver to this call.
    { runtime: runtime ?? null },
  );
  if (res.ok) {
    log.info("approval timed out — policy applied", {
      approvalId: approval.id,
      workflowRunId: approval.workflowRunId,
      stepName: approval.stepName,
      policy,
      runStatus: res.run.status,
    });
    return "answered";
  }

  switch (res.code) {
    case "forbidden":
    case "invalid-answer":
      // The clock cannot legitimately clear this gate — a declared
      // `rbacScope` it holds no permission for, outstanding items only a
      // human may consent to, or a policy name the author never declared
      // as a choice. Fail closed rather than widening the guard.
      log.warn("timeout policy could not be applied — failing closed", {
        approvalId: approval.id,
        policy,
        code: res.code,
        detail: res.message,
      });
      return abortRun(approval, `its approval timed out and ${res.message}`);

    case "resume-failed":
      // The answer LANDED — the row is `answered` and the policy really
      // was applied — and only the resume failed. Cancelling now would
      // contradict a decision already recorded; the run's fate belongs to
      // the recovery sweep.
      log.warn("timeout policy applied but the run could not continue", {
        approvalId: approval.id,
        policy,
        detail: res.message,
      });
      return "answered";

    case "not-found":
    case "not-pending":
    case "lost-race":
      // Somebody decided it between our SELECT and our write. The whole
      // reason the record is a CAS.
      return "raced";

    default:
      // `run-unavailable`: no registered runtime, a run momentarily
      // claimed by `WorkflowRunner`, or a definition that has since been
      // deleted. Nothing was written, so the next tick retries — and
      // retrying is why the row is left pending rather than expired.
      log.warn("timeout policy deferred — the run is not resumable right now", {
        approvalId: approval.id,
        policy,
        detail: res.message,
      });
      return "deferred";
  }
}
