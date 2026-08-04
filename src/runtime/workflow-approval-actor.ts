/**
 * Which {@link ApprovalActor} a human answer surface hands the chokepoint.
 *
 * ## This is a CAPACITY selector, not an authorization
 *
 * It decides which QUESTION `answerApproval` is asked. It never decides
 * the answer: every fact it puts in a `delegation` actor is re-read and
 * re-proved inside the chokepoint against the same rows
 * (`workflow-answer-approval.ts`, and PR #58's `holdsClaim` at
 * `workflow-executor.ts:811-815` for the pattern). A surface that skipped
 * this call, passed the wrong id, or fabricated a result outright changes
 * no decision — it can only get itself refused.
 *
 * That is what makes it safe to live outside the one-export chokepoint
 * (ported invariant 7): it is not a second opinion about who may answer,
 * because it holds no opinion at all.
 *
 * ## Why a shared module rather than four lines in each surface
 *
 * There are two session-authenticated human answer surfaces — the REST
 * route (`web/src/routes/api/workflows/approvals/[id]/+server.ts`) and the
 * Hub approvals tab (`workflow-approvals-hub-page.ts`) — and the approvals
 * inbox now shows a delegated run's parked decision on BOTH of them. A
 * surface that listed the row and then minted the wrong actor would render
 * a decision its own button could not make, which is the "looks fixed"
 * failure amended spec §6.3 warns about, one layer down. One rule, both
 * callers.
 *
 * The timeout sweep is deliberately not a caller: it is not a session, it
 * mints `system-timeout` directly, and asking "what capacity does this
 * human hold" of the clock is not a narrower question — it has no answer.
 */
import { findDelegatedAnswerAuthority } from "../db/queries/workflow-approvals";
import type { ApprovalActor } from "./workflow-answer-approval";

/** The session behind the answer. Both surfaces can supply this much. */
export interface ApprovalAnswerSession {
  userId: string;
  /** STATED, never inferred — the Hub genuinely cannot know a role and
   *  says `false`, which is a decision rather than an omission. */
  isAdmin: boolean;
}

/**
 * The actor this session should answer `approvalId` as.
 *
 * Defaults to `kind: "user"` — the caller answering as themselves, which
 * is every answer that existed before C3 — and returns `kind: "delegation"`
 * only when the run behind this approval was started by a live delegation
 * that names this session's user as its consenting human.
 *
 * ## Why an admin is never delegated
 *
 * The delegated capacity WIDENS reach and must never narrow it. It
 * satisfies no `rbacScope` (only a person can hold a grant) and confers no
 * admin, so minting it for a caller whose own identity already reaches the
 * run would take away an answer they could otherwise give. Admins reach
 * every run, so they are answered as themselves without a query; the same
 * exclusion for the run's OWN owner lives in the SQL, where the run row
 * already is.
 */
export async function resolveApprovalActor(
  approvalId: string,
  session: ApprovalAnswerSession,
): Promise<ApprovalActor> {
  const self: ApprovalActor = {
    kind: "user",
    userId: session.userId,
    isAdmin: session.isAdmin,
  };
  if (session.isAdmin) return self;
  const delegated = await findDelegatedAnswerAuthority(approvalId, session.userId);
  if (!delegated) return self;
  return {
    kind: "delegation",
    delegationId: delegated.delegationId,
    runId: delegated.runId,
    answeringUserId: session.userId,
  };
}
