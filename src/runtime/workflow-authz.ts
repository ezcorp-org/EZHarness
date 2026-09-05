/**
 * Run / manage authorization for workflows.
 *
 * ONE rule set, shared by every caller that can trigger or mutate a
 * workflow — `POST /api/workflows/[name]/run`, `PUT`/`DELETE
 * /api/workflows/[name]`, the list route's `canEdit` flag, and the
 * `run_workflow` built-in tool. A second copy of these rules anywhere is
 * how the REST path and the chat path end up disagreeing about who may run
 * what.
 *
 * ── This module owns the ENTRY POINTS, not the rules ───────────────────
 *
 * The rules themselves live in `workflow-scope.ts`. Everything here is a
 * thin adapter over `authorizeWorkflow`, because for a while there were
 * genuinely TWO authorization models over `workflow_definitions` and they
 * disagreed about the same rows:
 *
 * - This module used to read a `created_by` column, treating NULL as
 *   "unowned, anyone with the scope may act" — which is what made the
 *   original migration non-breaking.
 * - The ladder uses `user_id` + `visibility`, and treats an orphaned
 *   `private` row (`user_id` NULL after the owner is deleted, via
 *   `ON DELETE SET NULL`) as ADMIN-ONLY.
 *
 * The two readings of NULL are exact opposites, and keeping both was a
 * privilege hole rather than defence in depth: the create path sets
 * `user_id` and left `created_by` NULL, so every workflow this platform
 * wrote was "unowned" to the old rule — `private` workflows were
 * world-editable through any path that asked this module instead of the
 * ladder. Mapping one column onto the other would have inverted the
 * deliberate `SET NULL` design in the other direction. So there is now one
 * model, and it is the ladder.
 *
 * ── What survived from the old rule set ────────────────────────────────
 *
 * The extension-liveness check in {@link canRunWorkflow}, which the ladder
 * did not have and which closes a real staleness hole — see rule 1 below.
 *
 * ── Where this is enforced ─────────────────────────────────────────────
 *
 * At the CALL SITES, never inside `WorkflowExecutor.runWorkflow`. The CLI
 * (`src/cli.ts`) runs workflows with no principal at all and is documented
 * as auth-free; an authz check in the executor breaks it instantly. The
 * executor's contract is "run this definition", not "decide who may".
 *
 * Extension liveness is read from `getExtensionByName` (the DB), NOT from
 * `ExtensionRegistry.getAllManifests()` — the registry is an in-memory
 * snapshot with exactly the staleness problem this check exists to close.
 */
import { getExtensionByName } from "../db/queries/extensions";
import { workflowReleaseCanAccess, workflowReleaseIsCurrent } from "./workflow-release-assets";
import { listProjectIdsForUser } from "../db/queries/project-members";
import {
  authorizeWorkflow,
  NO_PROJECT_MEMBERSHIPS,
  readRunAudience,
  type CachedWorkflow,
  type WorkflowCaller,
} from "./workflow-scope";
import { EXTENSION_WORKFLOW_SEPARATOR } from "./workflow-name";

/**
 * The principal a workflow action is attributed to. Structurally a subset
 * of `AuthUser`, declared locally so this module stays importable from the
 * runtime without pulling the auth tree in.
 *
 * Kept as `{ id, role }` rather than replaced by `WorkflowCaller` because
 * the tool call site reads exactly this shape off the DB user row;
 * {@link callerOf} does the one conversion.
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
 * Adapt a principal to the ladder's caller struct.
 *
 * `role` is compared to the literal `"admin"` rather than run through
 * `checkRole` — that helper also demands the `admin` API-key SCOPE, so it
 * would reject a cookie-authed admin on these `chat`-scoped routes, and it
 * returns an HTTP `Response`, which is meaningless to the tool call site.
 */
function callerOf(
  user: WorkflowPrincipal,
  projectId: string | null | undefined,
  projectMemberships: readonly string[],
): WorkflowCaller {
  return {
    userId: user.id,
    role: user.role === "admin" ? "admin" : "member",
    projectId: projectId ?? null,
    projectMemberships,
  };
}

/**
 * May `user` EDIT or DELETE this workflow?
 *
 * The predicate `GET /api/workflows` serves as `canEdit`, so the UI can
 * hide an Edit/Delete affordance that would only 403 or 404. It is the
 * ladder's own `edit` rung, asked directly — the same question the write
 * routes ask, so the button and the endpoint cannot disagree.
 *
 * The `source !== "db"` refusal that used to live here is not repeated:
 * the ladder already denies `edit` on a YAML or extension asset with
 * `not-editable-source`, because those are files on disk with nothing to
 * write.
 *
 * Synchronous and entry-taking: the list route maps over the cache it
 * already holds, so this costs no query at all — where the previous
 * implementation needed one owner lookup for the whole page.
 *
 * It stays synchronous after the project-membership split because `edit`
 * provably never reaches the read/run audience switch: `authorizeWorkflow`
 * returns from the `action === "edit"` block before it. `NO_PROJECT_MEMBERSHIPS`
 * is therefore not a weakened check here, it is a set whose contents cannot
 * be read on this path — and passing it explicitly is what keeps that fact
 * visible instead of hiding behind a defaulted parameter.
 */
export function canManageWorkflow(entry: CachedWorkflow, user: WorkflowPrincipal): boolean {
  return authorizeWorkflow(entry, callerOf(user, null, NO_PROJECT_MEMBERSHIPS), "edit").ok;
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
 * May `user` run this workflow?
 *
 * `entry` must be the cache entry the executor will ACTUALLY run (the one
 * resolved out of the merged cache), not a re-lookup by name — otherwise a
 * YAML/DB name collision has authz deciding about a different object than
 * the one that executes.
 *
 * Two rules, in the order `buildWorkflowCache`'s `[...extension, ...yaml,
 * ...db]` precedence implies:
 *
 * 1. **Extension-namespaced** — the owning extension must still be
 *    installed AND enabled. This is load-bearing, not a formality:
 *    `reloadWorkflows()` fires only on workflow CRUD, never on extension
 *    install/uninstall/disable, so disabling an extension leaves its
 *    workflows runnable off the stale cache until a workflow is written or
 *    the process restarts. This live re-check is the actual fix, and it is
 *    the one rule the ladder does not express — the ladder authorizes a
 *    PRINCIPAL against a row, and this asks whether the owning code is
 *    still installed at all.
 *
 *    The namespace is derived from the NAME, not from `source`, and that is
 *    strictly the stronger test: `source === "extension"` implies a
 *    separator (`namespacedWorkflowName` always inserts one), so the name
 *    test subsumes it — and it additionally catches a `workflow_definitions`
 *    row squatting on `some-extension:deploy`, which would otherwise slide
 *    through as an ordinary DB workflow the moment that extension is
 *    uninstalled.
 *
 *    It runs FIRST, and deliberately: a dead extension's workflow is
 *    unrunnable by anyone, including the admin the ladder would wave
 *    through.
 * 2. **The ladder's `run` rung** — `system` is open, a project-scoped
 *    `project` row needs a MEMBER of that project, a project-less one needs
 *    only a login, and `private` needs the owner or an admin.
 *
 * ## Where the membership set comes from
 *
 * Resolved HERE rather than passed in, and that is the reason this function
 * is async in the first place — it already awaits `getExtensionByName`, so
 * the membership read costs a round trip on a path that was never
 * synchronous. Passing it in would push the same query onto all four call
 * sites (`POST /api/workflows/:name/run`, the `run_workflow` built-in, the
 * extension reverse-RPC handler, the tests) and let any one of them forget.
 *
 * The read is CONDITIONAL on the entry's own audience: `system` and
 * `private` rows, which are the overwhelming majority, never touch the DB
 * for it. That is not an optimization dressed as a rule — asking
 * `readRunAudience` first is what makes the dependency legible, since the
 * only branch that reads the set is the only branch that pays for it.
 */
export async function canRunWorkflow(
  entry: CachedWorkflow,
  user: WorkflowPrincipal,
  projectId?: string | null,
): Promise<WorkflowAuthzDecision> {
  const live = await workflowExtensionLiveness(entry.definition.name);
  if (!live.allowed) return live;
  if (entry.source === "extension" && !await workflowReleaseCanAccess(entry, user.id, projectId)) return deny("Workflow release is not available to this user.");

  const memberships =
    readRunAudience(entry.visibility, entry.projectId) === "project-members-and-admins"
      ? await listProjectIdsForUser(user.id)
      : NO_PROJECT_MEMBERSHIPS;

  const decision = authorizeWorkflow(entry, callerOf(user, projectId, memberships), "run");
  if (!decision.ok) {
    return deny(`Workflow "${entry.definition.name}" is not available to this user`);
  }
  return ALLOW;
}

/**
 * Rule 1 of {@link canRunWorkflow}, ALONE: is the extension that owns this
 * workflow name still installed and enabled?
 *
 * Exported because C3's delegated fire path needs exactly this half and
 * cannot use the whole of `canRunWorkflow` — that function's
 * {@link WorkflowPrincipal} carries a NON-NULL `id`, and a
 * `owner_kind='service'` delegation runs as `{userId: null}`, which the
 * type cannot express. The delegated ladder asks the ladder's own `run`
 * rung through the shared consent policy
 * (`workflow-delegation-consent.ts`, so the consent-time and fire-time
 * answers cannot drift) and adds THIS on top.
 *
 * Split out rather than reimplemented: an extension-liveness rule that
 * existed twice would eventually let a dead extension's workflow stay
 * runnable down one path and not the other, and the whole reason this
 * check exists is that `reloadWorkflows()` never fires on
 * install/uninstall/disable, so the merged cache is stale by design.
 */
export async function workflowExtensionLiveness(
  name: string,
  entry?: CachedWorkflow,
): Promise<WorkflowAuthzDecision> {
  if (entry?.source === "extension" && !await workflowReleaseIsCurrent(entry)) return deny("Workflow release is no longer active.");
  const prefix = extensionPrefix(name);
  if (!prefix) return ALLOW;
  const extension = await getExtensionByName(prefix);
  if (!extension) {
    return deny(`Workflow "${name}" belongs to extension "${prefix}", which is not installed`);
  }
  if (extension.enabled !== true) {
    return deny(`Workflow "${name}" belongs to extension "${prefix}", which is disabled`);
  }
  return ALLOW;
}
