/**
 * Workflow ownership, and the ONE place a workflow is looked up and
 * authorized.
 *
 * ## Why authorization lives in the lookup, not in the route
 *
 * `WorkflowDefinition` is the shape of the GRAPH — name, description,
 * inputSchema, defaultModel, steps — and carries no provenance at all. It
 * is shared by YAML- and extension-shipped workflows that have no owner,
 * by `runWorkflow`, by the CLI and by `validateWorkflow`. `loadDbWorkflows`
 * projects each row into it and **drops `id`**, so by the time a route
 * held a workflow it knew only the name and the steps: there was nothing
 * to authorize against, and no amount of adding owner COLUMNS would have
 * changed that.
 *
 * So provenance travels beside the definition on {@link CachedWorkflow},
 * and {@link resolveWorkflowForCaller} does the lookup *and* the check in
 * one call. Every consumer — the five REST handlers, the fork/dry-run
 * routes, the extension reverse-RPC handler — routes through it, so the
 * ladder exists in exactly one place and cannot drift between them. A
 * route physically cannot authorize; the lookup must.
 *
 * ## READ and RUN are different questions
 *
 * {@link WorkflowAction} is not decoration. A workflow a caller may SEE is
 * not necessarily one they may RUN, and C3 (delegated execution) builds
 * directly on that distinction — if the two collapsed into one check, C3
 * would inherit a hole where seeing a workflow implied being able to fire
 * it on someone else's behalf. Pinned by
 * "read and run are separate questions — a readable workflow is not
 * automatically runnable" in `workflow-scope.test.ts`.
 */
import type { WorkflowDefinition, WorkflowVisibility } from "../types";

/** Where a cached workflow came from. */
export type WorkflowSource = "extension" | "yaml" | "db";

/**
 * A workflow plus the provenance the cache used to throw away.
 *
 * A wrapper rather than a widened `WorkflowDefinition` on purpose: the
 * definition type is shared with sources that have no owner, and
 * DB-only provenance does not belong on the graph type.
 */
export interface CachedWorkflow {
  definition: WorkflowDefinition;
  source: WorkflowSource;
  /** DB rows only — `null` for yaml/extension, which have no row. */
  id: string | null;
  projectId: string | null;
  userId: string | null;
  visibility: WorkflowVisibility;
  /** Fully qualified name of the source this was forked from, if any. */
  forkedFrom: string | null;
}

/**
 * Wrap an ownerless workflow (YAML asset or extension-shipped) as a
 * `system` cache entry.
 *
 * The only correct reading: they ship with the INSTALL, not with a
 * project or a user. Treating them as anything else would either hide
 * them from everyone (no owner to match) or invent an owner.
 */
export function systemCachedWorkflow(
  definition: WorkflowDefinition,
  source: "extension" | "yaml",
): CachedWorkflow {
  return {
    definition,
    source,
    id: null,
    projectId: null,
    userId: null,
    visibility: "system",
    forkedFrom: null,
  };
}

/** What the caller is trying to do. */
export type WorkflowAction = "read" | "run" | "edit";

/**
 * The principal asking.
 *
 * Deliberately a `userId` + `role` + `projectId` STRUCT rather than three
 * positional arguments, because C3 needs to add a service-account
 * principal without re-threading every call site. A future principal kind
 * becomes a field here and a branch in {@link isProjectMember} /
 * {@link authorizeWorkflow}, not a new signature.
 */
export interface WorkflowCaller {
  /** `null` for a principal with no user identity (the CLI). */
  userId: string | null;
  role: "admin" | "member";
  /** The project the caller is acting in, when they named one. */
  projectId?: string | null;
}

/** Why a workflow was refused. Callers branch on this, not on a message. */
export type WorkflowDenialReason =
  | "not-found"
  | "not-project-member"
  | "not-owner"
  | "not-editable-source"
  | "requires-admin";

export type WorkflowResolution =
  | { ok: true; entry: CachedWorkflow }
  | { ok: false; reason: WorkflowDenialReason };

/**
 * Is `userId` a member of `projectId`?
 *
 * **This platform has no project-membership model.** `projects`
 * (`src/db/schema.ts`) has no owner column, there is no `project_members`
 * table, and `GET /api/projects` returns every project to every
 * authenticated caller without a filter. `teams` / `team_members` exist
 * but they are the AGENT-SHARING model and are not attached to projects.
 *
 * So today every authenticated principal is a member of every project,
 * and this returns true for any caller carrying a user identity. That
 * makes `visibility: "project"` an *edit boundary and a label*, not a
 * confidentiality boundary — `private` is the only real confidentiality
 * boundary in this phase, and the UI says so rather than implying
 * otherwise.
 *
 * It is a named function with a single call site precisely so that the
 * day project membership lands, this body is the only thing that changes
 * and the whole ladder tightens at once.
 */
export function isProjectMember(caller: WorkflowCaller, _projectId: string | null): boolean {
  return caller.userId !== null;
}

/**
 * The authorization ladder. Pure — no I/O, no DB, no clock — so the
 * matrix that covers it is cheap enough to be exhaustive.
 *
 * | visibility | read            | run             | edit                        |
 * |---|---|---|---|
 * | `system`   | anyone          | anyone          | admin only                  |
 * | `project`  | project members | project members | creator, or admin           |
 * | `private`  | owner or admin  | owner or admin  | owner or admin              |
 *
 * `system` → run-by-anyone is not a new grant: every row that exists at
 * migration time is `system`, and that is exactly who could run it
 * before this ladder existed. The tightening is on EDIT, where `system`
 * becomes admin-only.
 */
export function authorizeWorkflow(
  entry: CachedWorkflow,
  caller: WorkflowCaller,
  action: WorkflowAction,
): WorkflowResolution {
  const isAdmin = caller.role === "admin";
  const isOwner = entry.userId !== null && entry.userId === caller.userId;

  if (action === "edit") {
    // YAML and extension assets are files on disk, not rows. Refusing
    // here rather than at the route keeps "what is editable" a property
    // of the entry, so the fork flow can ask the same question.
    if (entry.source !== "db") return { ok: false, reason: "not-editable-source" };
    if (isAdmin) return { ok: true, entry };
    if (entry.visibility === "system") return { ok: false, reason: "requires-admin" };
    if (entry.visibility === "private") {
      return isOwner ? { ok: true, entry } : { ok: false, reason: "not-owner" };
    }
    // `project`: the creator may edit; any other member may not. Editing
    // is the narrower right — a member can run a project workflow without
    // being able to rewrite what it does for everyone else.
    if (!isProjectMember(caller, entry.projectId)) {
      return { ok: false, reason: "not-project-member" };
    }
    return isOwner ? { ok: true, entry } : { ok: false, reason: "not-owner" };
  }

  // read / run share a ladder today, but they are asked separately so C3
  // can diverge them without touching a single call site.
  if (entry.visibility === "system") return { ok: true, entry };
  if (entry.visibility === "private") {
    if (isAdmin || isOwner) return { ok: true, entry };
    return { ok: false, reason: "not-owner" };
  }
  if (isAdmin || isProjectMember(caller, entry.projectId)) return { ok: true, entry };
  return { ok: false, reason: "not-project-member" };
}

/**
 * Look up a workflow by name and authorize the caller for `action` in one
 * step.
 *
 * `entries` is the merged cache in its load order — extension, then YAML,
 * then DB — and the lookup is the FIRST name match, unchanged from
 * before. `workflow_definitions.name` is globally unique and stays that
 * way: ownership authorizes a workflow, it never namespaces one. Making
 * the key composite with `project_id` would let two rows share a name and
 * hand a caller in project B project A's graph.
 */
export function resolveWorkflowForCaller(
  entries: readonly CachedWorkflow[],
  name: string,
  caller: WorkflowCaller,
  action: WorkflowAction,
): WorkflowResolution {
  const entry = entries.find((e) => e.definition.name === name);
  if (!entry) return { ok: false, reason: "not-found" };
  return authorizeWorkflow(entry, caller, action);
}

/**
 * Everything the caller may SEE. Used by the list route.
 *
 * Deliberately expressed as a filter over the same {@link authorizeWorkflow}
 * the single-entry resolver uses, rather than as its own predicate. Two
 * independently-correct filters is how you get a workflow that a caller
 * can run but cannot find in the list — runnable-but-invisible is
 * undiagnosable for the user, and it is exactly what a second copy of
 * this rule would eventually produce.
 */
export function visibleWorkflows(
  entries: readonly CachedWorkflow[],
  caller: WorkflowCaller,
): CachedWorkflow[] {
  return entries.filter((entry) => authorizeWorkflow(entry, caller, "read").ok);
}

/**
 * HTTP status for a denial.
 *
 * An unauthorized READ is a **404, not a 403**: a 403 confirms the
 * workflow exists, which turns the endpoint into an existence oracle for
 * names the caller may not see. A denied EDIT is a 403 — the caller can
 * already see the workflow by then, so there is nothing left to conceal
 * and a 404 would just be confusing.
 */
export function denialStatus(reason: WorkflowDenialReason, action: WorkflowAction): 403 | 404 {
  if (reason === "not-found") return 404;
  return action === "edit" ? 403 : 404;
}

/** Human-readable denial message, keyed off the reason so the wording
 *  cannot drift between routes. */
export function denialMessage(reason: WorkflowDenialReason, action: WorkflowAction): string {
  if (denialStatus(reason, action) === 404) return "Not found";
  if (reason === "not-editable-source") {
    return "Not editable (only DB workflows can be edited)";
  }
  if (reason === "requires-admin") {
    return "This workflow is system-owned — only an admin can change it";
  }
  return "You do not have permission to change this workflow";
}

/**
 * Build a {@link WorkflowCaller} from a route's `locals`.
 *
 * One converter so no route hand-rolls the role read (and quietly gets it
 * wrong for an API-key principal, whose role is clamped to its owner's
 * current role on every request in `bearer-auth.ts`).
 */
export function callerFromUser(
  user: { id: string; role?: string },
  projectId?: string | null,
): WorkflowCaller {
  return {
    userId: user.id,
    role: user.role === "admin" ? "admin" : "member",
    projectId: projectId ?? null,
  };
}
