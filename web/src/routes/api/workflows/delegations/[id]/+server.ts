import { json } from "@sveltejs/kit";
import { requireSessionAuth } from "$server/auth/middleware";
import { errorJson } from "$lib/server/http-errors";
import { mayManageDelegation } from "$server/runtime/workflow-delegation-consent";
import {
  getWorkflowDelegation,
  revokeWorkflowDelegation,
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
