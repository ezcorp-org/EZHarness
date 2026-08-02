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
 *
 * ## The read/run audience is a VALUE, not a predicate
 *
 * There used to be an `isProjectMember(caller, projectId)` here that
 * returned `caller.userId !== null` — it consulted neither project id,
 * and its name asserted a membership check the platform cannot perform.
 * A module comment said so and it still nearly shipped a delegated
 * -execution feature resting on it, so the name is gone: read/run now
 * routes through {@link readRunAudience}, which returns one of three
 * {@link WorkflowAudience} values that each say who they admit.
 * `project` resolves to `"any-authenticated-principal"` — a string you
 * cannot read as "a member".
 *
 * **What is reachable today** (pinned behaviourally, not asserted, in
 * `workflow-visibility-reach.test.ts`): all three tiers. `private` used
 * to have no writer, which made `"owner-and-admins"` — the only audience
 * narrower than "everyone with a login" — unreachable, and left the
 * ladder with no confidentiality boundary at all on the read/run axis.
 * `visibility` is now a key on the create/update body, so an author can
 * name it and that gap is closed.
 *
 * Two consequences worth stating together, because they pull opposite
 * ways. For C3 (delegated execution): a bound of "could the owner run
 * it?" now excludes something — a `private` row is refused to everyone
 * but its owner and the admins, so the bound is real rather than
 * decorative. But it is still weak for the other two tiers, which remain
 * runnable by every authenticated principal; `private` is opt-in, and
 * the default a create produces is `system`.
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
 * becomes a field here and a branch in {@link readRunAudience} /
 * {@link authorizeWorkflow}, not a new signature.
 */
export interface WorkflowCaller {
  /** `null` for a principal with no user identity (the CLI). */
  userId: string | null;
  role: "admin" | "member";
  /**
   * The project the caller is acting in, when they named one.
   *
   * **Read by nothing in this module.** It is carried for call sites and
   * for the day a membership model lands; {@link authorizeWorkflow}
   * never compares it to `entry.projectId`, and a test pins that both
   * ids are decision-irrelevant. It could not be otherwise today: this
   * value comes off the request (a query param or a body field), so a
   * caller names their own project and comparing the two would be a
   * boundary the caller controls — theatre that reads like a check.
   */
  projectId?: string | null;
}

/** Why a workflow was refused. Callers branch on this, not on a message. */
export type WorkflowDenialReason =
  | "not-found"
  /**
   * The caller carries no user identity at all (the CLI).
   *
   * Named for what it actually tests. It was `not-project-member`, which
   * described a check that never ran — the only principal it ever
   * refused is one with `userId === null`, and never because of a
   * project. Status and message are unchanged.
   */
  | "not-authenticated"
  | "not-owner"
  | "not-editable-source"
  | "requires-admin";

export type WorkflowResolution =
  | { ok: true; entry: CachedWorkflow }
  | { ok: false; reason: WorkflowDenialReason };

/**
 * Who a visibility tier admits on the read/run axis, named for the set it
 * actually is.
 *
 * A value rather than a boolean predicate because the predicate is where
 * this went wrong: `isProjectMember(caller, projectId) => true` reads as
 * a membership check at every call site, and no call site is where you
 * find out it isn't one. `"any-authenticated-principal"` cannot be
 * misread the same way — it names the set, so the weakness is legible
 * wherever the value surfaces.
 */
export type WorkflowAudience =
  /** No identity required at all — includes the userless CLI principal. */
  | "anyone"
  /**
   * Anyone holding a login. **Not a membership check, and not a
   * confidentiality boundary** — the platform has no project-membership
   * model: `projects` (`src/db/schema.ts`) has no owner column, there is
   * no `project_members` table, and `GET /api/projects`
   * (`web/src/routes/api/projects/+server.ts`) returns every project to
   * every authenticated caller unfiltered. `teams` / `team_members`
   * exist but are the AGENT-SHARING model and are not attached to
   * projects. So this set is every user on the instance.
   */
  | "any-authenticated-principal"
  /**
   * The one audience narrower than "everyone with a login", and the
   * platform's only workflow confidentiality boundary. Reachable: an
   * author names `visibility: "private"` on create or update. See
   * `workflow-visibility-reach.test.ts`.
   */
  | "owner-and-admins";

/**
 * The read/run audience for a visibility tier. The single place that
 * decision is made.
 *
 * Takes the visibility ALONE, deliberately: no caller, no project id.
 * The old predicate took a `projectId` it never read, which is how the
 * ladder looked project-scoped while being nothing of the sort. A
 * signature that cannot accept a project id cannot imply it consults
 * one.
 *
 * The day a membership model lands, `"any-authenticated-principal"`
 * splits and this function grows the argument it needs — and every
 * exhaustive `switch` over {@link WorkflowAudience} fails to compile
 * until it is handled.
 */
export function readRunAudience(visibility: WorkflowVisibility): WorkflowAudience {
  if (visibility === "system") return "anyone";
  if (visibility === "private") return "owner-and-admins";
  return "any-authenticated-principal";
}

/**
 * The authorization ladder. Pure — no I/O, no DB, no clock — so the
 * matrix that covers it is cheap enough to be exhaustive.
 *
 * | visibility | read + run                  | edit                     | who may assign |
 * |---|---|---|---|
 * | `system`   | anyone (no login needed)    | **owner**, or admin      | **admin only** |
 * | `project`  | any authenticated principal | creator, or admin        | anyone         |
 * | `private`  | owner or admin              | owner or admin           | owner + admins |
 *
 * All three are reachable. Read the read/run column as the audience it
 * is: `system` and `project` both admit every user on the instance,
 * differing only on whether a login is required. `project` is not
 * narrower than `system` for any principal that has logged in — it is
 * narrower only for the userless CLI. `private` is the only row of the
 * three that narrows read/run.
 *
 * ## OWNERSHIP is asked before VISIBILITY, on the edit rung
 *
 * The `system` refusal used to come FIRST, before `isOwner` was ever
 * consulted, so a `system` row was admin-only to edit no matter who
 * owned it. That is not a tier rule, it is a bug with a tier's shape:
 * `POST /api/workflows` defaults a new row to `system` and stamps the
 * creator as its owner, so a non-admin could not edit or delete the
 * workflow they had just made. The row HAD an owner; the ladder never
 * looked.
 *
 * So the order is: source, then admin, then **owner**, then the tier.
 * The consequence stated plainly, because it is the whole of the
 * change: **the owner of a `system` row may edit it.** A non-owner
 * still gets `requires-admin`, and an OWNERLESS `system` row — every
 * row that predates the ownership columns carries `user_id` NULL, and
 * so does every YAML/extension entry — still has no owner to match, so
 * it stays admin-only exactly as before. Pinned by "a legacy ownerless
 * system row stays admin-only, whoever asks" in `workflow-scope.test.ts`.
 *
 * What this does NOT do is make `system` a tier a member can opt into,
 * or a lever for touching someone else's row. Both are the assign
 * column's business, and the assign column is a SEPARATE question this
 * ladder does not answer — see {@link denyVisibilityAssignment}. It is
 * in the table because leaving it out is what makes `system` look like
 * a tier anyone may promote into. Clearing `edit` on your own `system`
 * row buys you nothing there: assignment is asked again, per write,
 * about the tier being STAMPED.
 *
 * `system` → run-by-anyone is not a new grant: every row that exists at
 * migration time is `system`, and that is exactly who could run it
 * before this ladder existed. What survives of the EDIT tightening is
 * narrower than it was: `system` is admin-only for everyone EXCEPT the
 * row's own owner.
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
    // OWNERSHIP OUTRANKS THE TIER, and is asked before it on every tier
    // — see the header. `isOwner` demands `entry.userId !== null`, so an
    // ownerless row (pre-ownership-columns, or an orphan left by
    // `ON DELETE SET NULL`) matches nobody and falls through to the tier
    // rules below, which is what keeps a legacy `system` row admin-only.
    if (isOwner) return { ok: true, entry };
    // Everything from here down is a NON-owner, non-admin.
    if (entry.visibility === "system") return { ok: false, reason: "requires-admin" };
    if (entry.visibility === "private") return { ok: false, reason: "not-owner" };
    // `project`: the creator may edit, nobody else. Editing is the
    // narrower right — anyone can RUN a project workflow without being
    // able to rewrite what it does for everyone else. A userless
    // principal is refused for the reason that actually applies to it:
    // it could not have been the owner in the first place.
    if (caller.userId === null) return { ok: false, reason: "not-authenticated" };
    return { ok: false, reason: "not-owner" };
  }

  // read / run share a ladder today, but they are asked separately so C3
  // can diverge them without touching a single call site.
  //
  // Exhaustive on purpose: adding a `WorkflowAudience` without deciding
  // what it admits here is a type error, not a silent fallthrough to
  // whichever branch happened to be last.
  switch (readRunAudience(entry.visibility)) {
    case "anyone":
      return { ok: true, entry };
    case "owner-and-admins":
      if (isAdmin || isOwner) return { ok: true, entry };
      return { ok: false, reason: "not-owner" };
    case "any-authenticated-principal":
      // `isAdmin` is redundant with the userId test for every principal
      // that can reach a route — kept because the role is what a future
      // membership model would exempt, and losing it here is how an
      // admin later gets locked out of a project they do not belong to.
      if (isAdmin || caller.userId !== null) return { ok: true, entry };
      return { ok: false, reason: "not-authenticated" };
  }
}

/** The refusal when a non-admin tries to mint or promote to `system`. */
export const VISIBILITY_ASSIGNMENT_DENIAL =
  "Only an admin can make a workflow system-owned";

/**
 * May `caller` STAMP `visibility` on a workflow — on create, or as a
 * re-classification of one they already passed the `edit` ladder for?
 * Returns the refusal message, or `null` to allow.
 *
 * Assignment is a separate question from {@link authorizeWorkflow}, and
 * the ladder cannot answer it: `edit` asks about the visibility a row
 * ALREADY has, this asks about the one it is being given. Collapsing them
 * would let the owner of a `private` row promote it to `system` purely
 * because they cleared `edit` on it as it stands.
 *
 * The one rule: **`system` is admin-only, `project` and `private` are
 * not.** `system` means "ships with the install" — it is the tier the
 * ladder lets anyone read and run without a login, and the tier no
 * non-owner but an admin may edit. A non-admin promoting a row into it
 * dresses their workflow up as a first-party asset. Tightening down to
 * `project` or `private` does not, and needs no extra gate: the `edit`
 * ladder above already refuses a non-admin who is not the owner, so the
 * only caller who ever reaches this question for someone else's
 * workflow is an admin.
 *
 * This rule is what stops the ladder's owner-may-edit-`system` rung
 * from becoming a promotion path. The two questions compose in one
 * direction only: an owner clears `edit` on their own `system` row and
 * still cannot stamp `system` onto anything — not that row on a
 * re-write, and not anyone else's, which they cannot clear `edit` on to
 * begin with. Pinned by "assignment is asked SEPARATELY from edit" and
 * "editing your own `system` row is not a licence to assign `system`"
 * in `workflow-scope.test.ts`.
 */
export function denyVisibilityAssignment(
  caller: WorkflowCaller,
  visibility: WorkflowVisibility | undefined,
): string | null {
  if (visibility === undefined) return null;
  if (visibility !== "system") return null;
  return caller.role === "admin" ? null : VISIBILITY_ASSIGNMENT_DENIAL;
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
