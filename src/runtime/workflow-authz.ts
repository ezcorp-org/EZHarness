/**
 * Run / manage authorization for workflows.
 *
 * ONE rule set, shared by every caller that can trigger or mutate a
 * workflow — `POST /api/workflows/[name]/run`, `PUT`/`DELETE
 * /api/workflows/[name]`, and the `run_workflow` built-in tool. A second
 * copy of these rules anywhere is how the REST path and the chat path end
 * up disagreeing about who may run what.
 *
 * ── Where this is enforced ─────────────────────────────────────────────
 *
 * At the CALL SITES, never inside `WorkflowExecutor.runWorkflow`. The CLI
 * (`src/cli.ts`) runs workflows with no principal at all and is documented
 * as auth-free; an authz check in the executor breaks it instantly. The
 * executor's contract is "run this definition", not "decide who may".
 *
 * ── Deliberately registry-free ─────────────────────────────────────────
 *
 * This module talks to the DB directly and knows nothing about the live
 * executor or the in-memory workflow cache, so it is unit-testable and can
 * be imported from both a SvelteKit route (via the `$server` alias) and a
 * built-in tool (relatively) without dragging the runtime in.
 *
 * Extension liveness is read from `getExtensionByName` (the DB), NOT from
 * `ExtensionRegistry.getAllManifests()` — the registry is an in-memory
 * snapshot with exactly the staleness problem this check exists to close.
 */
import type { WorkflowDefinition } from "../types";
import { getExtensionByName } from "../db/queries/extensions";
import { getWorkflowByName } from "../db/queries/workflows";
import { EXTENSION_WORKFLOW_SEPARATOR } from "./workflow-name";

/**
 * The principal a workflow action is attributed to. Structurally a subset
 * of `AuthUser`, declared locally so this module stays importable from the
 * runtime without pulling the auth tree in.
 */
export interface WorkflowPrincipal {
  id: string;
  role: string;
}

/** Allow, or deny with a message safe to surface as a 403 body / tool error. */
export type WorkflowAuthzDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

const ALLOW: WorkflowAuthzDecision = { allowed: true };

function deny(reason: string): WorkflowAuthzDecision {
  return { allowed: false, reason };
}

/**
 * The owner-or-admin rule, in one place.
 *
 * `createdBy` NULL/undefined ⇒ an unowned legacy or global row: anyone with
 * the scope may act, which is what makes the migration non-breaking. A
 * non-NULL owner narrows the row to that user plus instance admins.
 *
 * Admin is `role === "admin"` compared directly, NOT `checkRole` — that
 * helper also demands the `admin` API-key SCOPE, so it would reject a
 * cookie-authed admin on these `chat`-scoped routes, and it returns an HTTP
 * `Response`, which is meaningless to the tool call site.
 */
export function canActOnWorkflow(
  createdBy: string | null | undefined,
  user: WorkflowPrincipal,
): boolean {
  if (!createdBy) return true;
  return createdBy === user.id || user.role === "admin";
}

/**
 * May `user` EDIT or DELETE the workflow this definition describes?
 *
 * The predicate `GET /api/workflows` serves as `canManage`, so the UI can
 * hide an Edit/Delete affordance that would only 403 or 404. It is the
 * exact conjunction the write routes enforce, expressed once:
 *
 * 1. **`source` must be `"db"`** — `PUT`/`DELETE /api/workflows/[name]`
 *    resolve the target through `getWorkflowByName`, so a YAML or
 *    extension-shipped definition 404s ("only DB workflows can be
 *    updated"). Those are files on disk; there is nothing to write.
 * 2. **owner-or-admin** — the same {@link canActOnWorkflow} call the write
 *    routes make, so the button and the endpoint can never disagree.
 *
 * Deliberately synchronous and owner-taking rather than name-taking: the
 * list route resolves every owner in ONE query and maps over the cache,
 * instead of issuing a `getWorkflowByName` per workflow. `canRunWorkflow`
 * re-reads the row because it guards an actual side effect and wants the
 * freshest answer; this one only decides whether to paint a button, and a
 * stale `true` degrades to the write route's own 403.
 */
export function canManageWorkflow(
  workflow: Pick<WorkflowDefinition, "source">,
  createdBy: string | null | undefined,
  user: WorkflowPrincipal,
): boolean {
  if (workflow.source !== "db") return false;
  return canActOnWorkflow(createdBy, user);
}

/**
 * The extension namespace a workflow name claims, or null if it claims
 * none. `at <= 0` covers both "no separator" and a leading separator (an
 * empty prefix names no extension — `namespacedWorkflowName` can never
 * produce one, since extension names are admit-time-validated non-empty).
 */
function extensionPrefix(name: string): string | null {
  const at = name.indexOf(EXTENSION_WORKFLOW_SEPARATOR);
  if (at <= 0) return null;
  return name.slice(0, at);
}

/**
 * May `user` run `workflow`?
 *
 * `workflow` must be the definition the executor will ACTUALLY run (the one
 * resolved out of the merged cache), not a re-lookup by name — otherwise a
 * YAML/DB name collision has authz deciding about a different object than
 * the one that executes.
 *
 * Check order mirrors `buildWorkflowCache`'s `[...extension, ...yaml,
 * ...db]` precedence:
 *
 * 1. **Extension-namespaced** — the owning extension must still be
 *    installed AND enabled. This is load-bearing, not a formality:
 *    `reloadWorkflows()` fires only on workflow CRUD, never on extension
 *    install/uninstall/disable, so disabling an extension leaves its
 *    workflows runnable off the stale cache until a workflow is written or
 *    the process restarts. This live re-check is the actual fix.
 *
 *    The namespace is derived from the NAME, not from `source`, and that is
 *    strictly the stronger test: `source === "extension"` implies a
 *    separator (`namespacedWorkflowName` always inserts one), so the name
 *    test subsumes it — and it additionally catches a `workflow_definitions`
 *    row squatting on `some-extension:deploy`, which would otherwise slide
 *    through as an ordinary DB workflow the moment that extension is
 *    uninstalled.
 * 2. **DB workflow** — owner-or-admin, read live from the row. Only
 *    consulted when the definition says `source: "db"`; the owner is read
 *    here rather than carried on the definition so a user id never leaks
 *    through `GET /api/workflows`.
 * 3. **YAML / host / hand-built / unowned** — unchanged: any caller that
 *    got past the route's scope gate.
 */
export async function canRunWorkflow(
  workflow: WorkflowDefinition,
  user: WorkflowPrincipal,
): Promise<WorkflowAuthzDecision> {
  const prefix = extensionPrefix(workflow.name);

  if (prefix) {
    const extension = await getExtensionByName(prefix);
    if (!extension) {
      return deny(
        `Workflow "${workflow.name}" belongs to extension "${prefix}", which is not installed`,
      );
    }
    if (extension.enabled !== true) {
      return deny(
        `Workflow "${workflow.name}" belongs to extension "${prefix}", which is disabled`,
      );
    }
    return ALLOW;
  }

  if (workflow.source === "db") {
    const row = await getWorkflowByName(workflow.name);
    // A row that vanished between cache build and this check has no owner
    // left to protect — fall through rather than invent a denial.
    if (row && !canActOnWorkflow(row.createdBy, user)) {
      return deny(`Workflow "${workflow.name}" is owned by another user`);
    }
  }

  return ALLOW;
}
