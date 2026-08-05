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
import type { NestedWorkflowResolver } from "./workflow-executor";

/**
 * Build the resolver, given a LIVE reader of the merged workflow cache.
 *
 * A thunk, not an array: `reloadWorkflows()` REASSIGNS the cache binding on
 * every workflow CRUD write, so a resolver handed the array by value would
 * freeze a stale list for the lifetime of the process.
 *
 * The return type is the NAMED {@link NestedWorkflowResolver} — the exact type
 * `WorkflowExecutorOptions.workflowResolver` accepts — rather than an inlined
 * function type re-spelled here.
 *
 * It was first written that way to dodge a coverage-filter hole, and that
 * reason is GONE. The inlined form wraps across four lines, and its bare `): (`
 * continuation used to fall through every rule in `scripts/lcov-noise-filter.ts`
 * (`RETURN_TYPE_OPEN` demanded a NAMED type head; `BRACE_PUNCT_ONLY`'s character
 * class has no space), which cost this file a point — 95% on a line no test can
 * execute (c5df10b7). #103 made that head optional and put `(` in the bracket
 * set, so `): (` is now recognised as the non-executable type syntax it always
 * was; `src/__tests__/lcov-noise-filter.test.ts` pins the shape by name. Nothing
 * here is load-bearing for coverage any more.
 *
 * The artefact behind it is still real, and still the thing to recognise if a
 * signature ever costs a file points again: bun span-fills an UNCALLED
 * function's whole declaration range with phantom `DA:<line>,0` records that V8
 * never emits, so a shard that merely IMPORTS this module reports a zero on a
 * signature line the shard that EXERCISES it never mentions at all, and
 * `merge-lcov.ts` sums per `(SF, line)` — the zero survives the merge. The
 * filter is what absorbs that now. (Same class of artefact as the one-line
 * `VALUES` list in `src/db/migrate.ts`.)
 *
 * The name stays on its own merits: it is the ONE declaration of this contract.
 * Inlining would re-spell `ctx`'s shape in a second place where it can drift
 * from the executor's silently — a field ADDED to the executor's `ctx` keeps the
 * narrower literal assignable, so the drift is invisible to tsc rather than a
 * compile error. The named type is also deliberately WIDER than what this
 * factory returns: the executor's union admits a synchronous
 * `WorkflowDefinition | undefined` so sync test resolvers stay assignable, while
 * the resolver built here always returns a promise. That width costs nothing —
 * the sole production caller (`context.ts`) wants exactly this type, and every
 * other caller awaits, which collapses the union.
 */
export function makeNestedWorkflowResolver(
  getEntries: () => readonly CachedWorkflow[],
): NestedWorkflowResolver {
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
