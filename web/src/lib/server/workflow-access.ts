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
import {
  authorizeWorkflow,
  callerFromUser,
  denialMessage,
  denialStatus,
  resolveWorkflowForCaller,
  visibleWorkflows,
  type CachedWorkflow,
  type WorkflowAction,
  type WorkflowCaller,
} from "$server/runtime/workflow-scope";
import type { AuthUser } from "$server/auth/types";
import type { WorkflowDefinition } from "$server/types";

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

/** Build the caller struct from an authenticated route context. */
export function callerFor(user: AuthUser, projectId?: string | null): WorkflowCaller {
  return callerFromUser(user, projectId);
}

/**
 * Resolve a workflow by name and authorize `action`, or return the
 * Response the route should send.
 *
 * Returning (never throwing) the denial matches `requireScope`'s style —
 * SvelteKit surfaces a thrown `Response` from a handler as a 500, which
 * is how an intended 403 becomes an unintended 500.
 */
export function resolveWorkflowOr(
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
): { entry: CachedWorkflow; caller: WorkflowCaller } | Response {
  const caller = callerFor(user, projectId);
  const result = resolveWorkflowForCaller(getCachedWorkflows(), name, caller, action);
  if (!result.ok) {
    const status = denialStatus(result.reason, action);
    const message =
      status === 404 && notFoundMessage !== undefined
        ? notFoundMessage
        : denialMessage(result.reason, action);
    return errorJson(status, message);
  }
  return { entry: result.entry, caller };
}

/** Everything this caller may see, already serialized. */
export function listVisibleWorkflows(user: AuthUser, projectId?: string | null): WorkflowWire[] {
  const caller = callerFor(user, projectId);
  return visibleWorkflows(getCachedWorkflows(), caller).map((entry) => toWire(entry, caller));
}
