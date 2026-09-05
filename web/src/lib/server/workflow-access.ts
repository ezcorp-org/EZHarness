/**
 * The one adapter between a SvelteKit route and the shared workflow
 * ownership ladder.
 *
 * Every workflow route resolves through {@link resolveWorkflowOr} and
 * NONE of them compares a `visibility` itself. That is the invariant this
 * module exists to make cheap: a route that hand-rolled its own check
 * would drift from the other six the first time the ladder changed, and
 * an authorization rule that lives in seven places is a rule that is
 * wrong in at least one of them.
 *
 * Grep contract, asserted in `workflow-route-ladder.server.test.ts`: no
 * file under `routes/api/workflows/**` COMPARES a `visibility` or imports
 * the ladder module directly. (Stamping one on a row a route creates —
 * what fork does — is ownership assignment, not an authorization
 * decision, and stays allowed.)
 */
import { errorJson } from "$lib/server/http-errors";
import { getCachedWorkflows } from "$lib/server/context";
import { filterAccessibleWorkflowEntries, workflowReleaseCanAccess } from "$server/runtime/workflow-release-assets";
import {
  authorizeWorkflow,
  callerFromUser,
  denialMessage,
  denialStatus,
  denyVisibilityAssignment,
  NO_PROJECT_MEMBERSHIPS,
  resolveWorkflowForCaller,
  visibleWorkflows,
  type CachedWorkflow,
  type WorkflowAction,
  type WorkflowCaller,
} from "$server/runtime/workflow-scope";
import {
  authorizeDelegationConsent,
  DELEGATION_CONSENT_DENIALS,
} from "$server/runtime/workflow-delegation-consent";
import { listProjectIdsForUser } from "$server/db/queries/project-members";
import type { AuthUser } from "$server/auth/types";
import type { DelegationOwnerKind } from "$server/db/schema";
import type { WorkflowDefinition, WorkflowVisibility } from "$server/types";

/**
 * The JSON a workflow is serialized as.
 *
 * Additive over `WorkflowDefinition`: every pre-C6 consumer reads only
 * `name` / `description` / `steps` / `inputSchema` / `defaultModel` and is
 * unaffected. The extra fields are what the editor needs to decide
 * whether to offer Edit, Fork or neither — computing that client-side
 * from a rule the client cannot see would be a second copy of the ladder.
 */
export interface WorkflowWire extends WorkflowDefinition {
  source: CachedWorkflow["source"];
  visibility: CachedWorkflow["visibility"];
  projectId: string | null;
  userId: string | null;
  forkedFrom: string | null;
  /** Whether THIS caller may edit — never a client-side inference. */
  canEdit: boolean;
}

export function toWire(entry: CachedWorkflow, caller: WorkflowCaller): WorkflowWire {
  return {
    ...entry.definition,
    source: entry.source,
    visibility: entry.visibility,
    projectId: entry.projectId,
    userId: entry.userId,
    forkedFrom: entry.forkedFrom,
    // The ladder's own answer, asked directly — the entry is already in
    // hand, so re-resolving it by name would only add a lookup that
    // cannot fail.
    canEdit: authorizeWorkflow(entry, caller, "edit").ok,
  };
}

/**
 * Build the caller struct from an authenticated route context.
 *
 * ASYNC since the project-membership split: the ladder's
 * `project-members-and-admins` audience is checked against a set that has to
 * be READ, and reading it here — once per request, in the one adapter every
 * route already goes through — is what keeps the routes free of it. A route
 * that resolved its own memberships would be a second copy of the same rule
 * with its own chance to skip the lookup.
 *
 * The set is keyed by the AUTHENTICATED user id. `projectId`, which comes
 * off the request, is still carried and still decision-irrelevant — see
 * `WorkflowCaller.projectId`.
 */
export async function callerFor(
  user: AuthUser,
  projectId?: string | null,
): Promise<WorkflowCaller> {
  return callerFromUser(user, projectId, await listProjectIdsForUser(user.id));
}

/**
 * Resolve a workflow by name and authorize `action`, or return the
 * Response the route should send.
 *
 * Returning (never throwing) the denial matches `requireScope`'s style —
 * SvelteKit surfaces a thrown `Response` from a handler as a 500, which
 * is how an intended 403 becomes an unintended 500.
 */
export async function resolveWorkflowOr(
  user: AuthUser,
  name: string,
  action: WorkflowAction,
  projectId?: string | null,
  /**
   * Override the 404 body. The run route's "Workflow not found" is a
   * published string with callers asserting on it, and an unauthorized
   * read must be INDISTINGUISHABLE from a missing one — so the override
   * applies to every 404 this function produces, not just `not-found`.
   * Passing it for one reason and not the other would rebuild the
   * existence oracle the 404 exists to close.
   */
  notFoundMessage?: string,
): Promise<{ entry: CachedWorkflow; caller: WorkflowCaller } | Response> {
  const caller = await callerFor(user, projectId);
  const result = resolveWorkflowForCaller(getCachedWorkflows(), name, caller, action);
  if (!result.ok) {
    // `result.visibility` is the tier the ladder refused on (`null` for a
    // name that matched nothing). Read off the denial rather than
    // re-found here: a second lookup in this adapter would be a second
    // copy of the cache-order rule the module exists to keep singular.
    const status = denialStatus(result.reason, action, result.visibility);
    const message =
      status === 404 && notFoundMessage !== undefined
        ? notFoundMessage
        : denialMessage(result.reason, action, result.visibility);
    return errorJson(status, message);
  }
  if (result.entry.source === "extension" && !await workflowReleaseCanAccess(result.entry, user.id, projectId)) return errorJson(404, notFoundMessage ?? "Workflow not found");
  return { entry: result.entry, caller };
}

/**
 * Refuse a visibility the caller may not assign, or `null` to proceed.
 *
 * The create and update routes both hand a caller-supplied `visibility`
 * through this one adapter, for the same reason they resolve through
 * {@link resolveWorkflowOr}: the rule is
 * `denyVisibilityAssignment` in the ladder module, and a route that
 * compared a visibility itself would be a second copy of it. A 403 rather
 * than a 404 — by the time a body is being written the caller can already
 * see the workflow (update) or is naming a row that does not exist yet
 * (create), so there is nothing left to conceal.
 */
export function denyVisibilityOr(
  user: AuthUser,
  visibility: WorkflowVisibility | undefined,
): Response | null {
  // Stays SYNCHRONOUS across the project-membership split, and builds the
  // caller inline rather than through `callerFor`, because
  // `denyVisibilityAssignment` reads `caller.role` and nothing else — it
  // never reaches the read/run audience. Awaiting `callerFor` here would buy
  // a membership query whose result is provably unread, on the write path of
  // every create and update.
  const message = denyVisibilityAssignment(
    callerFromUser(user, null, NO_PROJECT_MEMBERSHIPS),
    visibility,
  );
  return message === null ? null : errorJson(403, message);
}

/**
 * C3: resolve a workflow **as the principal a delegation will carry**,
 * or return the Response the consent route should send.
 *
 * ## Why this is a third entry point and not a `resolveWorkflowOr` flag
 *
 * Every other adapter here authorizes the CALLER. This one deliberately
 * does not: a delegation with `owner_kind = 'service'` runs as a
 * principal with no user identity at all, so the question "may this be
 * delegated?" has an answer the consenting human's own session cannot
 * produce. `resolveWorkflowOr` takes an `AuthUser` and could not express
 * it — there is no `AuthUser` for a service account, which is the point
 * of service accounts (`db/schema.ts:505-520`).
 *
 * The rule itself lives in `runtime/workflow-delegation-consent.ts`, not
 * here, because C3's fire-time ladder asks the identical question from
 * `src/` on every fire and two implementations of it would either grant
 * authority the human never saw or stale every fire of a delegation
 * nobody can then fix. This function is the adapter half only: read the
 * cache, call the shared rule, turn a refusal into a Response.
 *
 * The refusal is a **403 carrying the rule's own message**, never a bare
 * status. The message names the reason and the remedy ("choose run as
 * me, or ask an admin to make the workflow system-visible") because the
 * failure this exists to prevent is a user picking the service-account
 * arm for a forked — therefore `project`-visible — workflow and getting
 * a delegation that can never fire. There is no existence oracle to
 * protect here the way `resolveWorkflowOr` protects one: the caller is a
 * session, and the workflow they are trying to delegate is one they
 * named themselves.
 */
export function resolveDelegationConsentOr(
  workflowName: string,
  ownerKind: DelegationOwnerKind,
  ownerUserId: string | null,
): { entry: CachedWorkflow } | Response {
  const result = authorizeDelegationConsent(
    getCachedWorkflows(),
    workflowName,
    ownerKind,
    ownerUserId,
  );
  if (!result.ok) {
    return errorJson(
      result.code === DELEGATION_CONSENT_DENIALS.NOT_FOUND ? 404 : 403,
      result.message,
    );
  }
  return { entry: result.entry };
}

/** Everything this caller may see, already serialized. */
export async function listVisibleWorkflows(
  user: AuthUser,
  projectId?: string | null,
): Promise<WorkflowWire[]> {
  const caller = await callerFor(user, projectId);
  const visible = visibleWorkflows(getCachedWorkflows(), caller);
  return (await filterAccessibleWorkflowEntries(visible, user.id, projectId)).map((entry) => toWire(entry, caller));
}
