/**
 * How a `kind: "workflow"` STEP resolves the workflow it nests.
 *
 * Nesting IS a run of another workflow, so it goes through the same ladder
 * `POST /api/workflows/:name/run` does. A bare name lookup would let anyone
 * who can author a workflow nest someone else's `private` one and read its
 * behaviour back through `$steps`.
 *
 * ## Why this is a module rather than a closure in `context.ts`
 *
 * It used to be an inline arrow inside `ensureInitialized()`, which is boot
 * wiring — a function no test executes, so the rule lived somewhere it could
 * not be asserted. That was survivable while the rule was one object literal.
 * It stopped being survivable when project membership landed: the resolver
 * now has to READ the caller's memberships, decide when NOT to read them, and
 * get "no principal" right — three decisions, none of them testable inside a
 * boot function.
 *
 * ## The two decisions it makes
 *
 * 1. **`role: "member"`, always.** A run carries a principal ID, not a role
 *    (a CLI or scheduled run has neither), and the safe reading of "we do not
 *    know" is the lower privilege. Consequence: nesting reaches `system`
 *    workflows always, project-less `project` ones for any run with a user,
 *    project-SCOPED ones only for a member of that project, and `private`
 *    ones only for their owner.
 * 2. **Memberships are read only when there is a principal to read them
 *    for.** A run with no `userId` cannot be a member of anything —
 *    membership is keyed by user id — so the query is skipped and
 *    {@link NO_PROJECT_MEMBERSHIPS} used. That is not an optimization
 *    standing in for a check: `authorizeWorkflow` refuses a null-userId
 *    caller on the project tier for `not-authenticated` before the set is
 *    ever consulted.
 *
 * A run WITH a principal always pays for the lookup, even for a `system`
 * target. Unlike `canRunWorkflow`, this resolver does not have the entry in
 * hand — it is resolving BY NAME out of the cache — so it cannot ask
 * `readRunAudience` what the target needs before it needs it. Nesting is rare
 * and the read is a single indexed query.
 */
import { listProjectIdsForUser } from "../db/queries/project-members";
import {
  NO_PROJECT_MEMBERSHIPS,
  resolveWorkflowForCaller,
  type CachedWorkflow,
} from "./workflow-scope";
import type { WorkflowDefinition } from "../types";

/**
 * Build the resolver, given a LIVE reader of the merged workflow cache.
 *
 * A thunk, not an array: `reloadWorkflows()` REASSIGNS the cache binding on
 * every workflow CRUD write, so a resolver handed the array by value would
 * freeze a stale list for the lifetime of the process.
 */
export function makeNestedWorkflowResolver(
  getEntries: () => readonly CachedWorkflow[],
): (
  name: string,
  ctx: { userId?: string; projectId?: string },
) => Promise<WorkflowDefinition | undefined> {
  return async (name, ctx) => {
    const userId = ctx.userId ?? null;
    const resolved = resolveWorkflowForCaller(
      getEntries(),
      name,
      {
        userId,
        role: "member",
        projectId: ctx.projectId ?? null,
        projectMemberships: userId ? await listProjectIdsForUser(userId) : NO_PROJECT_MEMBERSHIPS,
      },
      "run",
    );
    // `undefined` for BOTH "no such workflow" and "not yours", deliberately:
    // the executor turns this into one message, and distinguishing them would
    // make a nested step an existence oracle for private workflow names.
    return resolved.ok ? resolved.entry.definition : undefined;
  };
}
