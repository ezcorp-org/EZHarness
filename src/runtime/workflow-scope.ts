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
 * routes through {@link readRunAudience}, which returns one of four
 * {@link WorkflowAudience} values that each say who they admit.
 *
 * ## The membership model landed
 *
 * `project_members` (`src/db/schema.ts`) now exists, so the split this
 * header promised has happened: `project` no longer resolves to a single
 * audience. A `project` row WITH a `project_id` resolves to
 * `"project-members-and-admins"` and is checked against a membership set
 * the SERVER resolved; a `project` row with a NULL `project_id` still
 * resolves to `"any-authenticated-principal"`, because there is no
 * project to be a member of and pretending otherwise would refuse
 * everyone.
 *
 * The membership set travels on {@link WorkflowCaller} as
 * `projectMemberships`, and it is a REQUIRED field for the same reason
 * `isProjectMember` had to die: an optional one defaults, a default is
 * invisible, and an invisible default is how a call site that never
 * resolved memberships silently keeps working. Required means every
 * construction site had to decide, and the ones that legitimately cannot
 * resolve a set say so out loud with {@link NO_PROJECT_MEMBERSHIPS}.
 *
 * **What is reachable today** (pinned behaviourally, not asserted, in
 * `workflow-visibility-reach.test.ts`): all four audiences. `private`
 * used to have no writer, which made `"owner-and-admins"` — then the only
 * audience narrower than "everyone with a login" — unreachable, and left
 * the ladder with no confidentiality boundary at all on the read/run
 * axis. `visibility` is now a key on the create/update body, so an author
 * can name it and that gap is closed. `"project-members-and-admins"`
 * needs BOTH writers to exist and both do: the fork route stamps
 * `project` + a `projectId` (`POST /api/workflows/:name/fork`), and
 * `POST /api/projects/:id/members` writes the memberships that satisfy
 * it. A rung with no writer is a rung nobody can stand on.
 *
 * Two consequences worth stating together, because they pull opposite
 * ways. For C3 (delegated execution): a bound of "could the owner run
 * it?" now excludes two things rather than one — a `private` row is
 * refused to everyone but its owner and the admins, and a project-scoped
 * row is refused to everyone outside that project. `system`, which is
 * still the tier a create DEFAULTS to, remains open to anyone.
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
   * The project the caller SAYS they are acting in.
   *
   * **Still read by nothing in this module, and that has not changed now
   * that a membership model exists.** {@link authorizeWorkflow} never
   * compares it to `entry.projectId`, and a test pins that this id stays
   * decision-irrelevant. The reason is unchanged and is the whole point:
   * this value comes off the request (a query param or a body field), so
   * the caller names their own project, and comparing the two would be a
   * boundary the caller controls — theatre that reads like a check.
   *
   * {@link projectMemberships} is the field that IS trusted, and the
   * difference between the two is exactly "who wrote it".
   */
  projectId?: string | null;
  /**
   * The project ids this principal is a MEMBER of — resolved SERVER-SIDE
   * against the authenticated user id, never taken off the request.
   *
   * Required, not optional. An optional field with an empty default would
   * make "memberships were never resolved" and "this principal belongs to
   * nothing" the same value, and the first of those is a bug that must
   * not be able to hide inside the second. Every construction site is
   * forced to produce one; a site that genuinely cannot resolve
   * memberships uses {@link NO_PROJECT_MEMBERSHIPS} and says why.
   */
  projectMemberships: readonly string[];
}

/**
 * The empty membership set, for callers that have none to resolve.
 *
 * A NAMED value rather than a bare `[]`, because the two situations it
 * covers are worth being able to grep for:
 *
 *  - the principal has no user identity at all (the CLI, a service
 *    account), so there is nothing to look up; and
 *  - the question being asked never consults the audience — `edit` and
 *    {@link denyVisibilityAssignment} both decide before the read/run
 *    switch is reached, so resolving memberships for them would be a
 *    query whose result is provably unused.
 *
 * It is the FAIL-CLOSED value: a caller carrying it satisfies no
 * `"project-members-and-admins"` entry. Frozen so a consumer cannot push
 * a membership into the shared instance.
 */
export const NO_PROJECT_MEMBERSHIPS: readonly string[] = Object.freeze([]);

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
  /**
   * The caller has a login, and is not a member of the project the
   * workflow is scoped to.
   *
   * The name is BACK, and this time it describes a check that runs:
   * `authorizeWorkflow` compares `entry.projectId` against the caller's
   * server-resolved {@link WorkflowCaller.projectMemberships}. It was
   * deleted precisely because the old bearer of the name refused only
   * `userId === null` principals, and never because of a project.
   *
   * It deliberately does NOT reach {@link denialStatus} as a special
   * case: read/run denials are already 404 for every reason, which is
   * what keeps the endpoint from confirming that a workflow exists in a
   * project the caller cannot see.
   */
  | "not-project-member"
  | "not-owner"
  | "not-editable-source"
  | "requires-admin";

export type WorkflowResolution =
  | { ok: true; entry: CachedWorkflow }
  | {
      ok: false;
      reason: WorkflowDenialReason;
      /**
       * The tier of the row that was refused — `null` when there was no
       * row to refuse (`not-found`).
       *
       * Carried because {@link denialStatus} needs it and the denial is
       * the only thing that crosses back to a route. It used to be
       * dropped here, so the one caller that turns a denial into a
       * status STRUCTURALLY could not see the tier, and every edit
       * denial got the same 403 — including on a `private` row the
       * caller may not even read. Re-finding the entry at the call site
       * would be a second copy of the lookup rule; carrying it is not.
       */
      visibility: WorkflowVisibility | null;
    };

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
   * Anyone holding a login. **Still not a membership check** — it is
   * every user on the instance, and it is what a `project`-visibility
   * row resolves to when it names NO project (`projectId === null`).
   *
   * That is not a gap left over from before the membership model; it is
   * the honest answer for a row with nothing to be a member of. A row
   * with a `project_id` gets {@link WorkflowAudience} the narrower value
   * below. `teams` / `team_members` are still the AGENT-SHARING model
   * and are still not attached to projects — `project_members` is the
   * one that is.
   */
  | "any-authenticated-principal"
  /**
   * Members of the workflow's own project, plus instance admins.
   *
   * The audience the module header promised and could not previously
   * express. Satisfied by comparing `entry.projectId` against the
   * caller's {@link WorkflowCaller.projectMemberships} — a set resolved
   * server-side from `project_members`, never a project id the caller
   * named on the request.
   *
   * Reachable: `POST /api/workflows/:name/fork` stamps `project` with a
   * `projectId`, and `POST /api/projects/:id/members` writes the
   * memberships that satisfy it. Admins are in the set for the reason
   * they are in every other one — the override is what keeps a
   * project-scoped row reachable after its members are deleted.
   */
  | "project-members-and-admins"
  /**
   * The narrowest audience, and the platform's per-USER workflow
   * confidentiality boundary (project-scoping is the per-PROJECT one).
   * Reachable: an author names `visibility: "private"` on create or
   * update. See `workflow-visibility-reach.test.ts`.
   */
  | "owner-and-admins";

/**
 * The read/run audience for a visibility tier. The single place that
 * decision is made.
 *
 * Takes the visibility and the ROW's project id — never a caller, and
 * never a project id off the request. The old predicate took a
 * `projectId` it never read, which is how the ladder looked
 * project-scoped while being nothing of the sort; the argument is back
 * because it is now READ, and it is the entry's own column rather than
 * anything the caller supplies.
 *
 * This is the split the previous version of this comment promised for
 * "the day a membership model lands". It landed, so
 * `"any-authenticated-principal"` split in two on the one axis that
 * distinguishes the rows: a `project` row that names a project is
 * membership-gated, a `project` row that names none cannot be. Every
 * exhaustive `switch` over {@link WorkflowAudience} failed to compile
 * until the new value was handled, which is what the promise was for.
 */
export function readRunAudience(
  visibility: WorkflowVisibility,
  projectId: string | null,
): WorkflowAudience {
  if (visibility === "system") return "anyone";
  if (visibility === "private") return "owner-and-admins";
  return projectId === null ? "any-authenticated-principal" : "project-members-and-admins";
}

/**
 * The authorization ladder. Pure — no I/O, no DB, no clock — so the
 * matrix that covers it is cheap enough to be exhaustive.
 *
 * | visibility            | read + run                  | edit                     | who may assign |
 * |---|---|---|---|
 * | `system`              | anyone (no login needed)    | **owner**, or admin      | **admin only** |
 * | `project`, no project | any authenticated principal | creator, or admin        | anyone         |
 * | `project`, in project | project members, or admin   | creator, or admin        | anyone         |
 * | `private`             | owner or admin              | owner or admin           | anyone         |
 *
 * All four read/run audiences are reachable. Read that column as the
 * audience it is: `system` and a project-less `project` row both admit
 * every user on the instance, differing only on whether a login is
 * required — a project-less `project` row is narrower than `system` only
 * for the userless CLI. The two rows that genuinely narrow read/run are
 * a project-SCOPED `project` row (narrowed to that project's members)
 * and `private` (narrowed to one user).
 *
 * The `project` tier splitting on its own `project_id` rather than on
 * the tier name is deliberate: the column is what says whether there is
 * a membership question to ask at all. A row scoped to no project cannot
 * be membership-gated without refusing everyone, and refusing everyone
 * is not a tighter reading of "project", it is a broken one.
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
  /** Every denial names the tier it was refused on — see {@link WorkflowResolution}. */
  const deny = (reason: WorkflowDenialReason): WorkflowResolution => ({
    ok: false,
    reason,
    visibility: entry.visibility,
  });

  if (action === "edit") {
    // YAML and extension assets are files on disk, not rows. Refusing
    // here rather than at the route keeps "what is editable" a property
    // of the entry, so the fork flow can ask the same question.
    if (entry.source !== "db") return deny("not-editable-source");
    if (isAdmin) return { ok: true, entry };
    // OWNERSHIP OUTRANKS THE TIER, and is asked before it on every tier
    // — see the header. `isOwner` demands `entry.userId !== null`, so an
    // ownerless row (pre-ownership-columns, or an orphan left by
    // `ON DELETE SET NULL`) matches nobody and falls through to the tier
    // rules below, which is what keeps a legacy `system` row admin-only.
    if (isOwner) return { ok: true, entry };
    // Everything from here down is a NON-owner, non-admin.
    if (entry.visibility === "system") return deny("requires-admin");
    if (entry.visibility === "private") return deny("not-owner");
    // `project`: the creator may edit, nobody else. Editing is the
    // narrower right — anyone can RUN a project workflow without being
    // able to rewrite what it does for everyone else. A userless
    // principal is refused for the reason that actually applies to it:
    // it could not have been the owner in the first place.
    if (caller.userId === null) return deny("not-authenticated");
    return deny("not-owner");
  }

  // read / run share a ladder today, but they are asked separately so C3
  // can diverge them without touching a single call site.
  //
  // Exhaustive on purpose: adding a `WorkflowAudience` without deciding
  // what it admits here is a type error, not a silent fallthrough to
  // whichever branch happened to be last.
  switch (readRunAudience(entry.visibility, entry.projectId)) {
    case "anyone":
      return { ok: true, entry };
    case "owner-and-admins":
      if (isAdmin || isOwner) return { ok: true, entry };
      return deny("not-owner");
    case "project-members-and-admins":
      // The admin exemption is asked FIRST, and this is the branch the
      // old `any-authenticated-principal` comment was written for: it
      // said losing the redundant `isAdmin` there "is how an admin later
      // gets locked out of a project they do not belong to". This is
      // later. An admin is not in `projectMemberships` and never will be
      // — `checkProjectRole` exempts them rather than writing them a row
      // — so without this line the override would not exist.
      if (isAdmin) return { ok: true, entry };
      // A userless principal (the CLI, a service account) is refused for
      // the reason that actually applies to it: it could not be a member
      // of anything, because membership is keyed by user id.
      if (caller.userId === null) return deny("not-authenticated");
      // `entry.projectId` is non-null here by construction —
      // `readRunAudience` returns this audience only for a non-null one —
      // but the membership test is written against the value rather than
      // against that invariant, so a future audience change cannot turn
      // this into an `includes(null)` that matches nothing silently.
      if (entry.projectId !== null && caller.projectMemberships.includes(entry.projectId)) {
        return { ok: true, entry };
      }
      return deny("not-project-member");
    case "any-authenticated-principal":
      // `isAdmin` is redundant with the userId test for every principal
      // that can reach a route. Kept for symmetry with the branch above,
      // where it is load-bearing.
      if (isAdmin || caller.userId !== null) return { ok: true, entry };
      return deny("not-authenticated");
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
  // No row, so no tier — the one denial whose `visibility` is `null`, and
  // the one a `private` refusal has to be indistinguishable from.
  if (!entry) return { ok: false, reason: "not-found", visibility: null };
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
 * HTTP status for a denial. Pure, like the ladder it reports on, so the
 * matrix that covers it stays cheap enough to be exhaustive.
 *
 * An unauthorized READ is a **404, not a 403**: a 403 confirms the
 * workflow exists, which turns the endpoint into an existence oracle for
 * names the caller may not see.
 *
 * A denied EDIT is a 403 for `system` and `project`, and a **404 for
 * `private`**. The 403 rests on "the caller can already see the workflow
 * by then, so there is nothing left to conceal, and a 404 would just be
 * confusing" — which is true of exactly the two tiers whose read audience
 * is everyone ({@link readRunAudience} returns `anyone` /
 * `any-authenticated-principal`), and false of `private`, the one tier
 * that narrows read/run. Every `private` edit denial comes from a caller
 * who is neither the owner nor an admin, i.e. precisely the caller the
 * read ladder refuses, so a 403 there rebuilds on PUT/DELETE the oracle
 * the read 404 exists to close: "403 vs 404" separates "this private
 * workflow exists and is not yours" from "no such name".
 *
 * `visibility` is the tier of the row that was refused, or `null` when
 * there was no row. It rides on the denial itself
 * ({@link WorkflowResolution}) rather than being looked up again at the
 * call site, so no caller can reach this function without it.
 */
export function denialStatus(
  reason: WorkflowDenialReason,
  action: WorkflowAction,
  visibility: WorkflowVisibility | null,
): 403 | 404 {
  if (reason === "not-found") return 404;
  if (action !== "edit") return 404;
  // Keyed on the TIER, not on the reason, and deliberately: `private` +
  // `not-editable-source` is a shape production cannot build today
  // (`systemCachedWorkflow` hardcodes `system`), but if it ever could,
  // refusing it with a 403 would leak the same existence the `not-owner`
  // 404 below conceals. Concealment is a property of the row, so it is
  // asked about the row.
  return visibility === "private" ? 404 : 403;
}

/** Human-readable denial message, keyed off the reason so the wording
 *  cannot drift between routes. Every 404 says "Not found" and nothing
 *  else — a message that named the tier, the owner or the reason would
 *  hand back the existence the status just withheld. */
export function denialMessage(
  reason: WorkflowDenialReason,
  action: WorkflowAction,
  visibility: WorkflowVisibility | null,
): string {
  if (denialStatus(reason, action, visibility) === 404) return "Not found";
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
  projectId: string | null | undefined,
  /**
   * The caller's server-resolved memberships. POSITIONAL AND REQUIRED —
   * a defaulted parameter here would re-create exactly the hazard
   * {@link WorkflowCaller.projectMemberships} is required to avoid, since
   * every existing call site would keep compiling while quietly
   * authorizing against an empty set. Pass
   * {@link NO_PROJECT_MEMBERSHIPS} when the question being asked cannot
   * reach the read/run switch.
   */
  projectMemberships: readonly string[],
): WorkflowCaller {
  return {
    userId: user.id,
    role: user.role === "admin" ? "admin" : "member",
    projectId: projectId ?? null,
    projectMemberships,
  };
}
