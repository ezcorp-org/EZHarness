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
 *
 * ## Why the chokepoint now reads `workflow_delegations` — flagged, not
 * ## discovered in review
 *
 * C3 (amended spec §6.3, R2-c) adds a table to this module's dependency
 * list, which for a file whose whole argument is "one export, nothing to
 * reimplement out of" is a structural change and deserves an answer up
 * front. Three properties make it the same shape as everything else here
 * rather than a widening of the boundary:
 *
 *  1. **It is a READ inside the read-only prefix**, taken at the same
 *     point as `getWorkflowRunRow`, before anything mutates. Order is
 *     unchanged and invariant 17 still holds in the strong sense.
 *  2. **It is reached by exactly one actor kind**, and only when that
 *     kind's run actually names a delegation. Every caller that existed
 *     before C3 issues precisely the queries it always did.
 *  3. **It could not have lived anywhere else.** The alternative is a
 *     surface that resolves a delegation and passes its verdict in — and a
 *     verdict passed in is a verdict a fourth surface can forge. Reading
 *     the row HERE is what makes `delegation` authority proved rather than
 *     asserted, so the dependency exists for the same reason the export
 *     count is one.
 *
 * The surfaces still hold the mirror-image half — `findDelegatedAnswerAuthority`
 * (`db/queries/workflow-approvals.ts`) tells them WHICH actor to mint —
 * and it grants nothing: every leg of what it returns is re-proved here.
 */
import type { WorkflowRun } from "../types";
import {
  getWorkflowApprovalById,
  recordWorkflowApprovalAnswer,
} from "../db/queries/workflow-approvals";
import { claimWorkflowRun, getWorkflowRunRow } from "../db/queries/workflow-runs";
import { findDelegationHoldingAuthority } from "../db/queries/workflow-delegations";
import { requireItemConsent } from "./workflow-approval-guard";
import { resumeClaimedRun } from "./workflow-executor";
import { getWorkflowRuntime, type WorkflowRuntime } from "./workflow/runtime-registry";
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

/**
 * Who is answering — a DISCRIMINATED union, and the discriminant is the
 * security property.
 *
 * ## What the undiscriminated struct made representable
 *
 * This was `{ userId: string | null; isAdmin?: boolean }`, and the timeout
 * sweep answered as `{ userId: null, isAdmin: true }`. At the no-scope
 * decision point that made **the clock and a real admin the same value**:
 * both arrived as `isAdmin === true`, and the only thing that told them
 * apart was `answeredBy` being NULL on the row *afterwards* — evidence
 * recovered after the decision, not an input to it.
 *
 * The sweep's own module doc was careful and correct about why it must
 * not be handed a `checkScope`, but the mechanism it relied on was
 * `isAdmin: true` plus the absence of a dep: documentation doing work the
 * type refused to do. Anyone who later passed the sweep a `checkScope` —
 * a reasonable-looking change — would have handed the clock every
 * permission in the system, and nothing would have failed.
 *
 * ## What the discriminant makes INEXPRESSIBLE
 *
 * `{ userId: null, isAdmin: true }` no longer type-checks. A `user` now
 * carries a non-null `userId` and a **stated** `isAdmin` — an omitted
 * flag can no longer read as "unknown, treat as not-admin by accident" —
 * and no other kind carries an `isAdmin` or a `userId` at all, so none of
 * them can reach {@link AnswerApprovalDeps.checkScope}, whose `userId`
 * parameter is now `string`. "A non-human satisfies a human's grant" is
 * therefore not denied, it is unsayable.
 *
 * `delegation.answeringUserId` does not reopen that: it is a *different
 * field* on a *different kind*, so it satisfies no `userId` parameter by
 * accident, and the scoped branch refuses the kind outright before
 * `checkScope` is consulted. What it names is who the answer is
 * ATTRIBUTED to once the delegation row has proved them, never a grant
 * they hold.
 *
 * ## Proof, not assertion
 *
 * `delegation` follows PR #58's `holdsClaim` (`workflow-executor.ts`):
 * *naming an identity that does not hold the lease proves nothing*.
 * Authority for this kind is PROVED against `workflow_delegations` at the
 * moment of the answer — see {@link mayAnswerUnscopedApproval}. Every
 * field the kind carries is a claim to be checked; none of them is the
 * authority, and a caller that fabricates all three still answers
 * nothing.
 */
export type ApprovalActor =
  /** A real, authenticated human. `isAdmin` is required: stated, never inferred. */
  | { kind: "user"; userId: string; isAdmin: boolean }
  /**
   * The approval timeout sweep, answering on the clock's behalf.
   *
   * Never satisfies an `rbacScope`: applying an author's `onTimeout:` is
   * housekeeping the author already asked for, while satisfying a
   * declared scope would be the clock awarding itself a permission a
   * human was required to hold. The first is a deadline; the second is a
   * privilege escalation.
   */
  | { kind: "system-timeout" }
  /**
   * A delegated (C3 `runFor`) run, answered on behalf of a delegation by
   * the human who consented to it.
   *
   * Carries the three facts its authority must be proved FROM — never the
   * authority itself. Every one of them is a CLAIM re-read against the
   * database at the moment of the answer; see
   * {@link mayAnswerUnscopedApproval}.
   *
   * `answeringUserId` is why this kind is not "a non-human answering". A
   * service account has no `users` row, so a run it owns writes
   * `workflow_runs.user_id = NULL` and no ownership test can ever name
   * anybody — but `workflow_delegations.consented_by_user_id` can, and it
   * is NOT NULL (`db/schema.ts:688`). The ACCOUNT owns the run; the HUMAN
   * who consented answers for it, and `workflow_approvals.answered_by`
   * therefore still records a real person.
   *
   * It is a separate kind rather than a widening of `user` because the
   * capacity is narrower than the person: answering *for a job* satisfies
   * no `rbacScope` and confers no admin. A caller who holds a grant of
   * their own answers as themselves, through `kind: "user"`.
   */
  | {
      kind: "delegation";
      delegationId: string;
      runId: string;
      answeringUserId: string;
    };

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
   *
   * `userId` is `string`, not `string | null`: this callback is now
   * reachable ONLY for a `kind: "user"` actor. A null identity can no
   * longer be *asked* whether it holds a grant, which is a stronger
   * statement than answering "no" — see {@link ApprovalActor}.
   */
  checkScope?: (scope: string, userId: string) => Promise<boolean>;
  /** Test seam. Defaults to the registered live runtime. */
  runtime?: WorkflowRuntime | null;
}

/**
 * The outcome of the unscoped-authorization decision: may this actor
 * answer, and — inseparably — WHO is the answer attributed to.
 *
 * The two are one question, so they are one return value. `answered_by` is
 * FK `users.id`, and deriving it anywhere other than the branch that
 * granted the answer is how a delegated answer ends up unattributed (or, in
 * the other direction, attributed to somebody the row never named).
 */
type UnscopedVerdict = { allowed: false } | { allowed: true; answeredBy: string | null };

/** What the decision is allowed to know about the run being answered. */
interface RunFacts {
  id: string;
  userId: string | null;
  delegationId: string | null;
}

/**
 * May this actor answer an approval that declares NO `rbacScope`?
 *
 * The one place the discriminant decides anything. Exhaustive on purpose,
 * matching `workflow-scope.ts`'s audience switch: adding an
 * {@link ApprovalActor} kind without deciding what it may answer is a
 * TYPE ERROR here, not a silent fall-through to whichever branch happened
 * to be last. That compile error is the mechanism — it is why a fourth
 * kind cannot inherit an authority nobody granted it.
 *
 * **PURE.** Every row it judges arrives as an argument, read by
 * {@link answerApproval} above it. The reads stay with the other reads and
 * this stays a decision, which is what makes the whole matrix testable by
 * value rather than by fixture.
 *
 * Non-exported, so no surface can reach this rule without going through
 * {@link answerApproval} (ported invariant 7).
 */
function mayAnswerUnscopedApproval(
  actor: ApprovalActor,
  run: RunFacts | undefined,
  /** The run's OWN delegation, re-read and only if it still holds
   *  authority — see {@link findDelegationHoldingAuthority}. */
  delegation: { consentedByUserId: string } | undefined,
): UnscopedVerdict {
  switch (actor.kind) {
    case "user":
      // Unchanged rule: the run's owner decides, and an admin may answer
      // any approval including one on an unowned run (CLI, extension
      // trigger). A NULL `user_id` must never read as "anyone's".
      return actor.isAdmin || (run?.userId != null && run.userId === actor.userId)
        ? { allowed: true, answeredBy: actor.userId }
        : { allowed: false };

    case "system-timeout":
      // The sweep's whole purpose, and now the ONLY thing this kind can
      // do. It deliberately bypasses "who owns this run" — applying
      // `onTimeout:` is a housekeeping decision the workflow author
      // already made — while the scoped branch above refuses it outright.
      // Previously this arrived as `isAdmin: true`, indistinguishable
      // from a real admin at exactly this line. `answeredBy: null` is the
      // same fact stated on the row: an answer no human made is
      // structurally unattributable.
      return { allowed: true, answeredBy: null };

    case "delegation": {
      // PROVED, never carried — PR #58's `holdsClaim`
      // (`workflow-executor.ts:811-815`) with a different lease:
      // *"naming an identity that does not hold the lease proves
      // nothing."* The actor supplies three CLAIMS and this expression is
      // the whole proof, with nothing granted by any one of them alone:
      //
      //   • `run.id === actor.runId` — the actor named the run this
      //     approval actually belongs to, not some other run it may
      //     legitimately hold.
      //   • `run.delegationId === actor.delegationId` — that run was
      //     started BY the named delegation. Read off the run, so a
      //     delegation the caller genuinely holds still proves nothing
      //     about a run it did not start. (Both `null` cannot collide
      //     here: `actor.delegationId` is a `string`.)
      //   • `delegation !== undefined` — the row came back from a read
      //     already filtered to `revoked_at IS NULL AND enabled`, so a
      //     tombstone is not found-then-judged, it is simply not found.
      //   • `consentedByUserId === actor.answeringUserId` — the human
      //     doing the answering is the human the ROW names. This is what
      //     keeps T8 true for `owner_kind='service'`: the account owns
      //     the run, and exactly one person may answer for it.
      //
      // A declared `rbacScope` never reaches here — the scoped branch
      // refuses this kind before `checkScope` is consulted at all.
      //
      // `answeredBy` below is equal to `delegation.consentedByUserId` by
      // the last term, so the answer is attributed to the person the ROW
      // named rather than to the one the caller claimed.
      const proved =
        run !== undefined &&
        run.id === actor.runId &&
        run.delegationId === actor.delegationId &&
        delegation !== undefined &&
        delegation.consentedByUserId === actor.answeringUserId;
      return proved ? { allowed: true, answeredBy: actor.answeringUserId } : { allowed: false };
    }
  }
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
  //
  // Both rules are now stated PER ACTOR KIND rather than over a nullable
  // userId — the ownership rule in {@link mayAnswerUnscopedApproval}, the
  // scope rule in the `actor.kind !== "user"` guard below. The two
  // paragraphs above describe the `user` kind, which is the only one
  // either rule was ever written for.
  let answeredBy: string | null = null;
  if (!approval.rbacScope) {
    const runRow = await getWorkflowRunRow(approval.workflowRunId);
    // The chokepoint's ONE dependency on `workflow_delegations`, and it is
    // reached only by the kind whose authority cannot be decided without
    // it. Every other actor — every caller that exists outside C3 — takes
    // exactly the queries it always did.
    //
    // Keyed off the RUN's `delegation_id`, never off the actor's claim:
    // reading the row the caller named would prove only that the caller
    // can name a row.
    const delegation =
      actor.kind === "delegation" && runRow?.delegationId
        ? await findDelegationHoldingAuthority(runRow.delegationId)
        : undefined;
    const verdict = mayAnswerUnscopedApproval(actor, runRow, delegation);
    if (!verdict.allowed) {
      return {
        ok: false,
        code: "forbidden",
        message: "Not permitted to answer this approval",
      };
    }
    answeredBy = verdict.answeredBy;
  }
  if (approval.rbacScope) {
    // Only a HUMAN can be asked whether they hold a grant. A
    // `system-timeout` or `delegation` actor is refused here without
    // `checkScope` ever being consulted — so a future caller that hands
    // the sweep a `checkScope` (the exact reasonable-looking change the
    // old shape left open) still cannot let the clock satisfy a scope.
    // The refusal is the same `forbidden` code every surface already
    // maps, so the sweep still falls through to its fail-closed `abort`.
    if (actor.kind !== "user") {
      return {
        ok: false,
        code: "forbidden",
        message:
          `Answering this approval requires the "${approval.rbacScope}" permission, ` +
          `which only a person can hold`,
      };
    }
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
    // Narrowed to `kind: "user"` by the guard above, so a scoped approval
    // is always attributable — the grant was held by a person.
    answeredBy = actor.userId;
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
  //
  // It is a fast, friendly refusal that names WHY, and nothing more. It is
  // NOT the authority to resume — this read is a snapshot, and the claim
  // CAS below is what actually decides. Keeping it means a run that is
  // plainly terminal gets a precise message instead of a bare "busy".
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
  //
  // `answered_by` is FK `users.id`, so it records a PERSON or nobody.
  // Derived by the AUTHORIZATION above rather than re-derived here: the
  // branch that granted the answer is the only one that knows who it
  // granted it to, and for a `delegation` actor that person is named by
  // the delegation row, not by the actor. Re-deriving it from the
  // discriminant alone (`kind === "user" ? userId : null`) would have made
  // every delegated answer anonymous while looking correct.
  const consentAllUsed = guard.consentAllUsed === true;
  const recorded = await recordWorkflowApprovalAnswer(approval.id, {
    choice: answer.choice,
    form: answer.form ?? null,
    itemIds: answer.itemIds ?? null,
    answeredBy,
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
      answeredBy,
      actorKind: actor.kind,
    });
  }

  // ── Take authority over the run (CAS) ──────────────────────────────
  //
  // Winning `claimWorkflowRun` is the ONE way to begin driving a run, and
  // it is atomic: of the daemon, this call, and anyone else, exactly one
  // proceeds. The status read above is a SNAPSHOT and cannot carry that
  // weight — between it and here the daemon can claim the run, and the
  // executor's status guard consults the row it is HANDED. Resuming off
  // that snapshot is exactly how two processes ended up driving one run
  // off one cursor.
  //
  // Deliberately AFTER the answer CAS, which is what makes losing here
  // harmless rather than a lost decision. The answer is already durable,
  // so `hasPendingApproval` is now false for whoever does hold the claim:
  // they will carry this run forward with this answer applied. Claiming
  // first would instead have turned every concurrent answer into a
  // "busy, try again" that hid a decision someone had already made.
  const claimedBy = `answer:${approval.id}`;
  const claimed = await claimWorkflowRun({
    workflowRunId: runRow.id,
    claimedBy,
    now: new Date(),
  });
  if (!claimed) {
    // Reported as `resume-failed`, not `run-unavailable`: the answer LANDED
    // and is not retryable, and every surface already renders that code as
    // "recorded, but the run could not continue here". The timeout sweep
    // maps it to `answered` for the same reason — re-offering a decision
    // that is already recorded would be the actual error.
    return {
      ok: false,
      code: "resume-failed",
      message:
        `Your answer was recorded. Run ${runRow.id} is being driven by another ` +
        `process right now, which will apply it.`,
    };
  }

  // ── Resume ─────────────────────────────────────────────────────────
  //
  // Through the shared sequence, which RE-READS the row under the claim
  // rather than resuming off the snapshot taken before it. See
  // {@link resumeClaimedRun}.
  const run = await resumeClaimedRun(runtime.workflowExecutor, workflow, runRow.id, claimedBy);
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
