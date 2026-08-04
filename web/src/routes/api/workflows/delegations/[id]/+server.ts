import { json } from "@sveltejs/kit";
import { z } from "zod";
import { requireSessionAuth } from "$server/auth/middleware";
import { errorJson } from "$lib/server/http-errors";
import { mayManageDelegation } from "$server/runtime/workflow-delegation-consent";
import {
  getWorkflowDelegation,
  revokeWorkflowDelegation,
  setDelegationTokenCeiling,
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
 * `maxTokensPerRun` is the ONLY adjustable field on a live delegation.
 * Everything else a caller might think to send — `workflowName`,
 * `ownerKind`, `ownerServiceAccountId`, `consentHash`, `projectId`, the
 * trigger pair, even `maxRunsPerDay` — is part of, or is bounded by, what
 * the human APPROVED, and Ruling 2 says the consent hash is the version
 * id of that approval: any edit to it re-asks. `.strict()` turns each of
 * those into a 400 that names the field, instead of a 200 that silently
 * ignored it. Ignoring is the dangerous half: a caller who sends
 * `{maxTokensPerRun, ownerKind:"service"}` and gets a 200 back has every
 * reason to believe the owner changed.
 *
 * `maxRunsPerDay` is refused for the narrower reason that it is a
 * DIFFERENT bound (D8 — how many times this job may fire today) and
 * changing it cannot unblock a parked run, which is what this route
 * exists for. Adding it later is additive and safe; shipping it now would
 * make the surface larger than the deadlock it closes.
 *
 * Positive integer, no "unlimited" sentinel, matching the consent route's
 * schema exactly — a cap of 0 is refused there and must be refused here,
 * or PATCH becomes a way to write a value POST forbids. (Rung D9 would
 * refuse the fire anyway; that is defence in depth, not a licence to
 * write the row.)
 */
const patchBodySchema = z
  .object({ maxTokensPerRun: z.number().int().positive() })
  .strict();

/**
 * Adjust a LIVE delegation's token ceiling IN PLACE — the route that
 * makes a parked run resumable.
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
      "Only maxTokensPerRun (a positive integer) can be adjusted in place; " +
        "changing the workflow, the owner or the approved capabilities requires re-consent",
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
  const updated = await setDelegationTokenCeiling(delegation.id, parsed.data.maxTokensPerRun);
  if (updated === undefined) {
    return errorJson(409, "This delegation is no longer live; consent again to restore it");
  }

  return json({ delegation: toWorkflowDelegationView(updated) });
};
