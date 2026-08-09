import { json } from "@sveltejs/kit";
import { z } from "zod";
import { requireSessionAuth } from "$server/auth/middleware";
import { errorJson } from "$lib/server/http-errors";
import { mayManageDelegation } from "$server/runtime/workflow-delegation-consent";
import {
  getWorkflowDelegation,
  revokeWorkflowDelegation,
  setDelegationRunBounds,
  toWorkflowDelegationView,
} from "$server/db/queries/workflow-delegations";
import type { RequestHandler } from "./$types";

/**
 * Revoke a delegation — a TOMBSTONE, never a delete.
 *
 * The row stays as history and drops out of every live partial index
 * (`db/schema.ts:689-693`), so a revoked delegation is representable and
 * every live lookup filters on `revoked_at IS NULL`. That is what lets
 * the same `(extension, job)` be consented to again later; a hard delete
 * would erase the record of what was once authorized, which is exactly
 * the thing an audit of a delegated system needs.
 *
 * ## SESSION-ONLY, like the consent that created it
 *
 * Withdrawing authority is as much a human decision as granting it. It is
 * also the ONE action that must never be harder to reach than the grant
 * was: a revoke gated more strictly than its consent leaves authority
 * standing that its owner cannot take back.
 *
 * ## Who may revoke: the consenting human, or an admin
 *
 * `mayManageDelegation` is the single-homed authority — the
 * delegation-shaped twin of `mayControlRun` for a run — and it is keyed
 * on `consented_by_user_id` rather than on the owner columns. That is
 * Ruling 1's answer to "who is answerable for a service-account job": the
 * ACCOUNT owns the run, the HUMAN WHO CONSENTED answers for it. Keying on
 * the owner would leave a `service`-kind delegation with no session able
 * to revoke it.
 *
 * ## 404, not 403, for a delegation this caller may not manage
 *
 * Same rule the workflow read routes follow: the endpoint is not an
 * existence oracle. A `job_ref` names an extension's internal job and a
 * 403 would confirm that some other user has authorized one.
 */
export const DELETE: RequestHandler = async ({ params, locals }) => {
  const user = requireSessionAuth(locals);
  if (user instanceof Response) return user;

  const delegation = await getWorkflowDelegation(params.id);
  if (delegation === undefined || !mayManageDelegation(delegation, user)) {
    return errorJson(404, "Delegation not found");
  }

  // False when it was already revoked. Reported rather than swallowed:
  // "I revoked it" and "it was already gone" are the same security
  // outcome but not the same fact, and the UI should not claim to have
  // just ended an authority that ended last week.
  const revoked = await revokeWorkflowDelegation(delegation.id);
  return json({ revoked });
};

/**
 * The body, and it is `.strict()` for a security reason rather than a
 * tidiness one.
 *
 * The two SPEND BOUNDS are the only adjustable fields on a live
 * delegation: `maxTokensPerRun` (D9 / the step-boundary ceiling) and
 * `maxRunsPerDay` (D8's daily fire quota). Everything else a caller might
 * think to send — `workflowName`, `ownerKind`, `ownerServiceAccountId`,
 * `consentHash`, `projectId`, the trigger pair, `enabled`,
 * `disabledReason` — is part of what the human APPROVED, and Ruling 2 says
 * the consent hash is the version id of that approval: any edit to it
 * re-asks. `.strict()` turns each of those into a 400 that names the
 * field, instead of a 200 that silently ignored it. Ignoring is the
 * dangerous half: a caller who sends `{maxTokensPerRun,
 * ownerKind:"service"}` and gets a 200 back has every reason to believe
 * the owner changed.
 *
 * ## `maxRunsPerDay` was refused here, and that was the wrong line
 *
 * It shipped as a 400 on the argument that it is a DIFFERENT bound whose
 * exhaustion cannot park a run, so it was outside the deadlock this route
 * was built to close. True, and beside the point: the alternative for
 * somebody who simply wants their nightly job to run twice was a full
 * re-consent — a new row, the old one tombstoned, and a dialog asking them
 * to re-approve a capability set that had not changed. Ruling 2 governs
 * approved MATERIAL, and neither of these numbers is material; they bound
 * what the approved thing may SPEND, not what it may DO. Routing one
 * through consent and not the other taught people to click through consent
 * dialogs, which is the cost Ruling 2 exists to avoid paying.
 *
 * ## …but at least one of them, or it is a 400
 *
 * `{}` is refused rather than treated as a no-op 200. An empty PATCH that
 * answers 200 tells a caller its change landed; the only honest answers
 * are "here is what I changed" or "you asked for nothing".
 *
 * Both are positive integers with no "unlimited" sentinel, matching the
 * consent route's schema exactly — a cap of 0 is refused there and must be
 * refused here, or PATCH becomes a way to write a value POST forbids.
 * (Rungs D8/D9 would refuse the fire anyway; that is defence in depth, not
 * a licence to write the row.)
 */
const patchBodySchema = z
  .object({
    maxTokensPerRun: z.number().int().positive().optional(),
    maxRunsPerDay: z.number().int().positive().optional(),
  })
  .strict()
  .refine((body) => body.maxTokensPerRun !== undefined || body.maxRunsPerDay !== undefined, {
    message: "at least one of maxTokensPerRun or maxRunsPerDay is required",
  });

/**
 * Adjust a LIVE delegation's SPEND BOUNDS in place — the route that makes
 * a parked run resumable, and that lets a daily throttle be tuned without
 * re-asking for consent nobody's approval changed.
 *
 * ## The deadlock this closes
 *
 * `RESUME_RULES["budget-exceeded"]` (`runtime/workflow-resume-reasons.ts`)
 * says "only raising that cap lets it continue". Nothing could raise it.
 * The sole writer of `max_tokens_per_run` was the consent route, and
 * `createWorkflowDelegation` TOMBSTONES the row it supersedes — so
 * re-consenting revoked the delegation the parked run's own predicate
 * then re-read, and that predicate fails closed on a revoked row. Both C3
 * resume rules named a remedy that did not exist, and every parked
 * delegated run was stuck forever: the permanent-DoS shape.
 *
 * Phase 6 closed it on the re-consent path (a supersede carries
 * `suspended` runs forward inside the same transaction). This closes it
 * on the path a human actually wants when the capability set has NOT
 * changed and they simply need a bigger budget — no new row, no
 * re-approval of material they already approved.
 *
 * ## SESSION-ONLY, and the consenter rather than any admin-with-a-key
 *
 * Same gate as the consent that created the row and the revoke that ends
 * it. A cap is not decoration: it is the number that decides how much
 * unattended LLM spend somebody's job may make, so a leaked `chat` key
 * must not be able to raise it. `mayManageDelegation` is the same
 * single-homed authority the DELETE uses — the human who consented, or an
 * admin — so this route can never be reachable by someone who could not
 * already revoke it outright.
 *
 * ## 404 for a delegation this caller may not manage
 *
 * Byte-identical to the DELETE's answer, deliberately: a caller who
 * cannot tell "no such delegation" from "somebody else's delegation"
 * cannot use this endpoint to discover that a `job_ref` exists.
 *
 * ## It does NOT re-enable, and it does NOT clear `disabled_reason`
 *
 * A DECISION, not an omission. `enabled = false` + `disabled_reason` is
 * the PLATFORM stating that this authority is broken, and it has exactly
 * two writers: rung D7 (`lostAccess` — the workflow was re-tiered out of
 * the owner's reach) and the auto-disable at five consecutive failures.
 * Neither is repaired by a bigger token budget, so a PATCH that cleared
 * the flag would undo a refusal without answering the question that
 * caused it — and it would do so in the worst direction, because
 * `delegationHoldsAuthority()` (the ANSWER path, which decides whether
 * the consenting human may clear approval gates on the job's behalf)
 * includes `enabled`. Re-enabling here would restore that answering
 * authority BEFORE any fire re-asks D7.
 *
 * The re-enable path exists and is correct: re-consent. It re-asks D7's
 * question (`authorizeDelegationConsent`) before writing an enabled row,
 * and — since phase 6 — carries the parked runs forward. So a disabled
 * delegation with a parked run is still recoverable; it just costs the
 * human a fresh look at what they are approving, which is the entire
 * point of having disabled it.
 *
 * A revoked row is refused for a shorter reason: a tombstone holds no
 * authority, so there is no budget to adjust.
 */
export const PATCH: RequestHandler = async ({ params, request, locals }) => {
  const user = requireSessionAuth(locals);
  if (user instanceof Response) return user;

  const delegation = await getWorkflowDelegation(params.id);
  if (delegation === undefined || !mayManageDelegation(delegation, user)) {
    return errorJson(404, "Delegation not found");
  }

  const parsed = patchBodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorJson(
      400,
      "Only maxTokensPerRun and maxRunsPerDay (positive integers, at least one) can be " +
        "adjusted in place; changing the workflow, the owner or the approved capabilities " +
        "requires re-consent",
    );
  }

  // Refused with the REASON, not with a bare 409: "this job was switched
  // off and here is why" is the only thing the user ever reads about it,
  // and the remedy differs from the revoked case.
  if (delegation.revokedAt !== null) {
    return errorJson(409, "This delegation was revoked; consent again to restore it");
  }
  if (!delegation.enabled) {
    return errorJson(
      409,
      `This delegation is disabled and its budget cannot be adjusted: ` +
        `${delegation.disabledReason ?? "no reason was recorded"} ` +
        `Consent again to restore it.`,
    );
  }

  // The same two conditions again, this time as a CAS inside the UPDATE.
  // Not redundant: a revoke landing between the read above and this write
  // must not be overwritten by a cap raise that re-reads nothing.
  //
  // `parsed.data` is handed over whole. Rebuilding it field by field here
  // would be a second place that decides which fields are patchable, and
  // the schema above is already `.strict()` — nothing can reach this line
  // that the schema did not name.
  const updated = await setDelegationRunBounds(
    delegation.id,
    parsed.data as Parameters<typeof setDelegationRunBounds>[1],
  );
  if (updated === undefined) {
    return errorJson(409, "This delegation is no longer live; consent again to restore it");
  }

  return json({ delegation: toWorkflowDelegationView(updated) });
};
