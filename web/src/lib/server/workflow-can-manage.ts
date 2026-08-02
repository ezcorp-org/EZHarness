/**
 * Stamp the client-facing `canManage` flag onto workflow definitions.
 *
 * `GET /api/workflows` serves the merged cache (extension + YAML + DB), but
 * only a DB-sourced workflow the caller owns — or any workflow, for an
 * admin — can actually be written through `PUT`/`DELETE
 * /api/workflows/[name]`. Without this flag the UI has to paint Edit and
 * Delete on every workflow and let the user discover the 403/404 by
 * clicking, including on the four demo workflows shipped as YAML.
 *
 * The rule itself is NOT duplicated here: `canManageWorkflow` is the one
 * copy, next to the `canActOnWorkflow` the write routes call.
 *
 * Owners are resolved in a single query rather than per workflow, and the
 * user id is consumed here — only the boolean is serialized, which keeps
 * the owner-free cache projection in `loadDbWorkflows` intact.
 */
import { canManageWorkflow, type WorkflowPrincipal } from "$server/runtime/workflow-authz";
import { getWorkflowOwnersByName } from "$server/db/queries/workflows";
import type { WorkflowDefinition } from "$server/types";

/** A workflow definition as served to a client: provenance plus the flag. */
export type ClientWorkflow = WorkflowDefinition & { canManage: boolean };

/**
 * Resolve `canManage` for every definition in `workflows`.
 *
 * Takes an array (not a single definition) so the list route pays for one
 * owner lookup total; the detail route passes a one-element array, which
 * costs the same single query it would have paid for `getWorkflowByName`.
 */
export async function withCanManage(
  workflows: WorkflowDefinition[],
  user: WorkflowPrincipal,
): Promise<ClientWorkflow[]> {
  // Skip the query entirely when nothing in the list could be DB-sourced —
  // a fresh install serving only YAML demos should not hit the DB to be
  // told every answer is false.
  const hasDbWorkflow = workflows.some((workflow) => workflow.source === "db");
  const owners = hasDbWorkflow
    ? await getWorkflowOwnersByName()
    : new Map<string, { userId: string | null; visibility: string }>();

  return workflows.map((workflow) => ({
    ...workflow,
    // `userId` is OUR owner column. Upstream's rule read `created_by`,
    // which nothing writes as of this merge; passing the column that is
    // actually populated keeps this flag truthful rather than uniformly
    // `true`. It still ignores `visibility`, so an orphaned `private` row
    // reads manageable here while the write route's ladder refuses it —
    // a stale `true` that degrades to a 403, which is the documented
    // contract for this hint. The follow-up commit removes the second
    // rule set and sources this straight from the ladder.
    canManage: canManageWorkflow(workflow, owners.get(workflow.name)?.userId, user),
  }));
}
