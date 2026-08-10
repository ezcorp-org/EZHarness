import { describe, expect, test } from "bun:test";
import {
  authorizeWorkflow,
  callerFromUser,
  denialMessage,
  denialStatus,
  denyVisibilityAssignment,
  NO_PROJECT_MEMBERSHIPS,
  VISIBILITY_ASSIGNMENT_DENIAL,
  readRunAudience,
  resolveWorkflowForCaller,
  systemCachedWorkflow,
  visibleWorkflows,
  type CachedWorkflow,
  type WorkflowAction,
  type WorkflowCaller,
  type WorkflowDenialReason,
} from "../runtime/workflow-scope";
import type { WorkflowDefinition, WorkflowVisibility } from "../types";

const definition = (name: string): WorkflowDefinition => ({
  name,
  description: "",
  steps: [{ name: "one", kind: "transform", output: { a: "b" } }],
});

const OWNER = "user-owner";
const PROJECT = "project-a";

function dbEntry(overrides: Partial<CachedWorkflow> = {}): CachedWorkflow {
  return {
    definition: definition("deploy"),
    source: "db",
    id: "wf-1",
    projectId: null,
    userId: null,
    visibility: "system",
    forkedFrom: null,
    ...overrides,
  };
}

/**
 * The callers.
 *
 * `projectId` is what the caller SAID (a query param / body field);
 * `projectMemberships` is what the SERVER resolved from `project_members`.
 * The two are kept deliberately distinguishable in these fixtures —
 * `stranger` names `project-b` AND belongs to it, so a test that passes
 * because the ladder read the wrong one would have to be lucky twice. The
 * "ids on the caller are decision-irrelevant" block below breaks the tie by
 * moving `projectId` alone.
 */
const owner: WorkflowCaller = {
  userId: OWNER,
  role: "member",
  projectId: PROJECT,
  projectMemberships: [PROJECT],
};
const member: WorkflowCaller = {
  userId: "user-member",
  role: "member",
  projectId: PROJECT,
  projectMemberships: [PROJECT],
};
/** A member of a DIFFERENT project. Not "someone with no memberships" —
 *  the distinction is what proves the check reads the entry's project id
 *  rather than merely testing that the set is non-empty. */
const stranger: WorkflowCaller = {
  userId: "user-stranger",
  role: "member",
  projectId: "project-b",
  projectMemberships: ["project-b"],
};
const admin: WorkflowCaller = {
  userId: "user-admin",
  role: "admin",
  projectId: null,
  // Empty ON PURPOSE. `checkProjectRole` exempts admins rather than writing
  // them membership rows, so an admin is in no project's set — every admin
  // allow below therefore comes from the role branch, never from membership.
  projectMemberships: [],
};
/** An API-key principal — `requireScope` admits it and it carries a user
 *  identity, but the key's owner belongs to no project. */
const keyNoProject: WorkflowCaller = {
  userId: "user-key",
  role: "member",
  projectId: null,
  projectMemberships: [],
};
/** The userless CLI principal. Membership is keyed by user id, so it can
 *  never be in a set — hence the frozen shared empty. */
const cli: WorkflowCaller = {
  userId: null,
  role: "member",
  projectMemberships: NO_PROJECT_MEMBERSHIPS,
};

/**
 * A `system` row WITH an owner — what `POST /api/workflows` produces,
 * since `visibility` defaults to `system` and the creator is stamped.
 *
 * It used to be `dbEntry({ visibility: "system" })`, inheriting the
 * fixture's `userId: null`, which meant the matrix's `owner` row was not
 * actually the owner of anything and the `system` × `owner` × `edit`
 * cell proved nothing about ownership. The ownerless case has its own
 * describe block below — it is a DIFFERENT row, not this one's default.
 */
const systemEntry = dbEntry({ visibility: "system", projectId: PROJECT, userId: OWNER });
const projectEntry = dbEntry({ visibility: "project", projectId: PROJECT, userId: OWNER });
/**
 * A `project`-visibility row that names NO project.
 *
 * Representable — `workflow_definitions.project_id` is nullable and only the
 * fork route ever stamps it — and it is the row the audience split turns on:
 * it resolves to `any-authenticated-principal`, not to the membership-gated
 * audience, because there is no project to be a member of.
 */
const projectlessEntry = dbEntry({ visibility: "project", projectId: null, userId: OWNER });
const privateEntry = dbEntry({ visibility: "private", projectId: PROJECT, userId: OWNER });

describe("the authorization matrix", () => {
  // {system, project, private} × {owner, member, stranger, admin, key} ×
  // {read, run, edit}. Every row asserts WHICH reason a denial carries,
  // not merely that it denied — a matrix that only checks the boolean
  // passes just as happily when the ladder denies for the wrong cause.
  const cases: Array<{
    entry: CachedWorkflow;
    caller: WorkflowCaller;
    who: string;
    action: WorkflowAction;
    expected: true | string;
  }> = [
    // ── system: any caller may read and run; the OWNER or an admin edits ──
    { entry: systemEntry, caller: owner, who: "owner", action: "read", expected: true },
    { entry: systemEntry, caller: owner, who: "owner", action: "run", expected: true },
    // DELIBERATELY INVERTED. This cell used to expect `requires-admin`,
    // because the ladder refused `system` before it ever consulted
    // ownership. That made the create route's own default unusable: a
    // new workflow is `system` and stamped with its creator, so a
    // non-admin could not edit or delete what they had just made. The
    // fix moves the tier check BELOW the ownership check, and this row
    // is where that reads as a behaviour change rather than a comment.
    // The three non-owner `system` × edit cells below must NOT move —
    // they are what keeps the tier meaningful.
    { entry: systemEntry, caller: owner, who: "owner", action: "edit", expected: true },
    { entry: systemEntry, caller: member, who: "member", action: "read", expected: true },
    { entry: systemEntry, caller: member, who: "member", action: "run", expected: true },
    {
      entry: systemEntry,
      caller: member,
      who: "member",
      action: "edit",
      expected: "requires-admin",
    },
    { entry: systemEntry, caller: stranger, who: "stranger", action: "read", expected: true },
    { entry: systemEntry, caller: stranger, who: "stranger", action: "run", expected: true },
    {
      entry: systemEntry,
      caller: stranger,
      who: "stranger",
      action: "edit",
      expected: "requires-admin",
    },
    { entry: systemEntry, caller: admin, who: "admin", action: "read", expected: true },
    { entry: systemEntry, caller: admin, who: "admin", action: "run", expected: true },
    { entry: systemEntry, caller: admin, who: "admin", action: "edit", expected: true },
    { entry: systemEntry, caller: keyNoProject, who: "api key", action: "read", expected: true },
    { entry: systemEntry, caller: keyNoProject, who: "api key", action: "run", expected: true },
    {
      entry: systemEntry,
      caller: keyNoProject,
      who: "api key",
      action: "edit",
      expected: "requires-admin",
    },

    // ── project (scoped to PROJECT): that project's MEMBERS read/run;
    //    only the creator (or admin) edits ────────────────────────────
    //
    // The three `read`/`run` cells that moved when `project_members`
    // landed are the stranger's and the API key's. They used to expect
    // `true` — every authenticated principal could read and run any
    // project workflow, because there was no membership model to ask.
    // They now expect `not-project-member`, which is the whole point of
    // the table: a workflow scoped to a project is confidential to it.
    { entry: projectEntry, caller: owner, who: "owner", action: "read", expected: true },
    { entry: projectEntry, caller: owner, who: "owner", action: "run", expected: true },
    { entry: projectEntry, caller: owner, who: "owner", action: "edit", expected: true },
    { entry: projectEntry, caller: member, who: "member", action: "read", expected: true },
    { entry: projectEntry, caller: member, who: "member", action: "run", expected: true },
    { entry: projectEntry, caller: member, who: "member", action: "edit", expected: "not-owner" },
    {
      entry: projectEntry,
      caller: stranger,
      who: "stranger",
      action: "read",
      expected: "not-project-member",
    },
    {
      entry: projectEntry,
      caller: stranger,
      who: "stranger",
      action: "run",
      expected: "not-project-member",
    },
    {
      entry: projectEntry,
      caller: stranger,
      who: "stranger",
      action: "edit",
      expected: "not-owner",
    },
    { entry: projectEntry, caller: admin, who: "admin", action: "read", expected: true },
    { entry: projectEntry, caller: admin, who: "admin", action: "run", expected: true },
    { entry: projectEntry, caller: admin, who: "admin", action: "edit", expected: true },
    {
      entry: projectEntry,
      caller: keyNoProject,
      who: "api key",
      action: "read",
      expected: "not-project-member",
    },
    {
      entry: projectEntry,
      caller: keyNoProject,
      who: "api key",
      action: "run",
      expected: "not-project-member",
    },
    {
      entry: projectEntry,
      caller: keyNoProject,
      who: "api key",
      action: "edit",
      expected: "not-owner",
    },

    // ── project with NO project id: unchanged, and that is deliberate ──
    //
    // The same tier, the same callers, the OLD answers — because a row
    // that names no project has no membership question to ask. Sitting
    // beside the block above, it is what stops "project is now
    // membership-gated" being read as a property of the tier NAME.
    { entry: projectlessEntry, caller: member, who: "member", action: "read", expected: true },
    { entry: projectlessEntry, caller: member, who: "member", action: "run", expected: true },
    { entry: projectlessEntry, caller: stranger, who: "stranger", action: "read", expected: true },
    { entry: projectlessEntry, caller: stranger, who: "stranger", action: "run", expected: true },
    {
      entry: projectlessEntry,
      caller: keyNoProject,
      who: "api key",
      action: "read",
      expected: true,
    },
    {
      entry: projectlessEntry,
      caller: keyNoProject,
      who: "api key",
      action: "run",
      expected: true,
    },

    // ── private: owner or admin only, for every action ────────────────
    { entry: privateEntry, caller: owner, who: "owner", action: "read", expected: true },
    { entry: privateEntry, caller: owner, who: "owner", action: "run", expected: true },
    { entry: privateEntry, caller: owner, who: "owner", action: "edit", expected: true },
    { entry: privateEntry, caller: member, who: "member", action: "read", expected: "not-owner" },
    { entry: privateEntry, caller: member, who: "member", action: "run", expected: "not-owner" },
    { entry: privateEntry, caller: member, who: "member", action: "edit", expected: "not-owner" },
    {
      entry: privateEntry,
      caller: stranger,
      who: "stranger",
      action: "read",
      expected: "not-owner",
    },
    {
      entry: privateEntry,
      caller: stranger,
      who: "stranger",
      action: "run",
      expected: "not-owner",
    },
    {
      entry: privateEntry,
      caller: stranger,
      who: "stranger",
      action: "edit",
      expected: "not-owner",
    },
    { entry: privateEntry, caller: admin, who: "admin", action: "read", expected: true },
    { entry: privateEntry, caller: admin, who: "admin", action: "run", expected: true },
    { entry: privateEntry, caller: admin, who: "admin", action: "edit", expected: true },
    {
      entry: privateEntry,
      caller: keyNoProject,
      who: "api key",
      action: "read",
      expected: "not-owner",
    },
    {
      entry: privateEntry,
      caller: keyNoProject,
      who: "api key",
      action: "run",
      expected: "not-owner",
    },
    {
      entry: privateEntry,
      caller: keyNoProject,
      who: "api key",
      action: "edit",
      expected: "not-owner",
    },
  ];

  for (const { entry, caller, who, action, expected } of cases) {
    const verdict = expected === true ? "allows" : `denies (${expected})`;
    test(`${entry.visibility} × ${who} × ${action} — ${verdict}`, () => {
      const result = authorizeWorkflow(entry, caller, action);
      if (expected === true) {
        expect(result.ok).toBe(true);
      } else {
        // The denial names the TIER as well as the reason, on all 45
        // cells. `denialStatus` is the consumer: it needs the visibility
        // to hide a `private` row's existence, and reading it off the
        // denial is what makes "the status caller has the tier"
        // structural rather than a convention.
        expect(result).toEqual({
          ok: false,
          reason: expected as never,
          visibility: entry.visibility,
        });
      }
    });
  }

  test("the matrix covers every visibility × caller × action combination", () => {
    // 3 tiers × 5 callers × 3 actions, plus the 6 read/run cells of the
    // project-LESS `project` row (its `edit` rung is the same code path as
    // the scoped row's and is already covered above).
    expect(cases).toHaveLength(3 * 5 * 3 + 6);
  });
});

describe("who may EDIT a `system` row — ownership is asked before the tier", () => {
  /**
   * The ruling: the OWNER of a `system` workflow may edit it. It is not
   * a loosening of the tier so much as the tier finally being asked in
   * the right order — `POST /api/workflows` defaults `visibility` to
   * `system` AND stamps `userId`, so before this the create route
   * produced a row its own author could not touch.
   *
   * Everything below exists to bound that: the grant is exactly "the
   * row's own owner", and every other principal is where it was.
   */

  /** The row a non-admin's ordinary create produces: `system` + owner. */
  const ownedSystem = dbEntry({ visibility: "system", userId: OWNER });
  /**
   * A row that predates the ownership columns. The C6 migration made
   * every pre-existing row `system` with `user_id` NULL, and
   * `ON DELETE SET NULL` mints new ones whenever an owner is deleted.
   */
  const legacySystem = dbEntry({ visibility: "system", userId: null });

  test("the owner of a system workflow may edit it", () => {
    expect(authorizeWorkflow(ownedSystem, owner, "edit")).toEqual({
      ok: true,
      entry: ownedSystem,
    });
  });

  test("a legacy ownerless system row stays admin-only, whoever asks", () => {
    // THE property that makes the reorder safe. `isOwner` requires
    // `entry.userId !== null`, so a NULL owner matches no caller — not
    // even one whose own id is null. If ownership were ever compared
    // with `==`, or the null guard dropped, the userless CLI principal
    // would match a legacy row and every pre-C6 workflow on the
    // instance would become world-editable in one step.
    for (const caller of [owner, member, stranger, keyNoProject, cli]) {
      expect(authorizeWorkflow(legacySystem, caller, "edit")).toEqual({
        ok: false,
        reason: "requires-admin",
        visibility: "system",
      });
    }
    // Discrimination: the row is not simply unreachable — an admin gets in.
    expect(authorizeWorkflow(legacySystem, admin, "edit").ok).toBe(true);
    // And it is the NULL that does it, not the tier: the same tier with
    // an owner admits that owner.
    expect(authorizeWorkflow(ownedSystem, owner, "edit").ok).toBe(true);
    expect(legacySystem.userId).toBeNull();
  });

  test("a system row is still refused to every principal who does not own it", () => {
    // The tier is not decorative after the reorder. Same row the owner
    // just edited, asked by everyone else.
    for (const caller of [member, stranger, keyNoProject]) {
      expect(authorizeWorkflow(ownedSystem, caller, "edit")).toEqual({
        ok: false,
        reason: "requires-admin",
        visibility: "system",
      });
    }
  });

  test("read and run on a system row are untouched — anyone, still", () => {
    // Only the `edit` rung moved. A regression here would mean the
    // reorder leaked into the audience switch.
    for (const caller of [owner, member, stranger, admin, keyNoProject, cli]) {
      expect(authorizeWorkflow(ownedSystem, caller, "read").ok).toBe(true);
      expect(authorizeWorkflow(ownedSystem, caller, "run").ok).toBe(true);
      expect(authorizeWorkflow(legacySystem, caller, "run").ok).toBe(true);
    }
  });

  test("the source rung still refuses FIRST — an owned YAML asset is not editable", () => {
    // Fault injection: a YAML entry that claims an owner is a row shape
    // production cannot produce (`systemCachedWorkflow` hardcodes
    // `userId: null`), constructed here precisely so the ownership rung
    // WOULD admit it if it ran first. It must not — a YAML or extension
    // workflow is a file on disk with nothing to write.
    const ownedYaml: CachedWorkflow = { ...ownedSystem, source: "yaml", id: null };
    expect(authorizeWorkflow(ownedYaml, owner, "edit")).toEqual({
      ok: false,
      reason: "not-editable-source",
      visibility: "system",
    });
    const ownedExtension: CachedWorkflow = { ...ownedSystem, source: "extension", id: null };
    expect(authorizeWorkflow(ownedExtension, owner, "edit")).toEqual({
      ok: false,
      reason: "not-editable-source",
      visibility: "system",
    });
    // Discrimination: the identical entry as a DB row IS editable, so
    // the refusal above is the source and nothing else.
    expect(authorizeWorkflow(ownedSystem, owner, "edit").ok).toBe(true);
  });

  test("editing your own `system` row is not a licence to assign `system`", () => {
    // The second-order risk of the ruling, closed by the separate
    // assignment question. This caller now clears `edit` on a `system`
    // row — and still may not STAMP `system`, on that row or any other.
    expect(authorizeWorkflow(ownedSystem, owner, "edit").ok).toBe(true);
    expect(denyVisibilityAssignment(owner, "system")).toBe(VISIBILITY_ASSIGNMENT_DENIAL);
    // Tightening their own row is still free, as it always was.
    expect(denyVisibilityAssignment(owner, "private")).toBeNull();
    expect(denyVisibilityAssignment(owner, "project")).toBeNull();
    // And someone else's `system` row is not reachable to edit at all,
    // so there is no row for the promotion to be attempted ON.
    expect(authorizeWorkflow(ownedSystem, stranger, "edit").ok).toBe(false);
  });

  test("a userless principal is refused a private row as not-owner, not not-authenticated", () => {
    // The `not-authenticated` reason belongs to `project`, whose edit
    // rung is the only one that asks about a login. Pinned because the
    // reorder rewrote the fallthrough these two share, and a reason
    // that silently swapped would still deny — the failure mode this
    // whole matrix asserts reasons rather than booleans to catch.
    expect(authorizeWorkflow(privateEntry, cli, "edit")).toEqual({
      ok: false,
      reason: "not-owner",
      visibility: "private",
    });
    expect(authorizeWorkflow(projectEntry, cli, "edit")).toEqual({
      ok: false,
      reason: "not-authenticated",
      visibility: "project",
    });
  });
});

describe("read and run are separate questions", () => {
  // THE test this phase exists to make possible. C3 (delegated execution)
  // builds on the distinction: a workflow a principal may SEE is not
  // automatically one they may FIRE, on their own behalf or anyone
  // else's. If the two ever collapse into one check, C3 inherits a hole
  // where visibility implies execution — so the separation is asserted
  // here, at the resolver, rather than assumed at the call sites.
  test("read and run are asked independently — a readable workflow is not automatically runnable", () => {
    // A visibility whose run rung is strictly narrower than its read rung
    // must be expressible without touching any call site. Proven by
    // denying RUN on an entry the same caller may READ.
    const readOnlyForMember: CachedWorkflow = dbEntry({
      visibility: "private",
      projectId: PROJECT,
      userId: OWNER,
    });

    // Sanity: the owner may do both, so the asymmetry below is about the
    // caller, not about the entry being unreachable.
    expect(authorizeWorkflow(readOnlyForMember, owner, "read").ok).toBe(true);
    expect(authorizeWorkflow(readOnlyForMember, owner, "run").ok).toBe(true);

    // The two calls are distinct code paths with distinct arguments —
    // `authorizeWorkflow(entry, caller, "read")` and
    // `…, "run")` — and every consumer passes the action it means.
    const readVerdict = authorizeWorkflow(readOnlyForMember, member, "read");
    const runVerdict = authorizeWorkflow(readOnlyForMember, member, "run");
    expect(readVerdict.ok).toBe(false);
    expect(runVerdict.ok).toBe(false);

    // And the action reaches the ladder rather than being discarded:
    // `edit` on a project entry denies for a DIFFERENT reason than `run`
    // does, which is only possible if the action is actually consulted.
    expect(authorizeWorkflow(projectEntry, member, "run")).toEqual({
      ok: true,
      entry: projectEntry,
    });
    expect(authorizeWorkflow(projectEntry, member, "edit")).toEqual({
      ok: false,
      reason: "not-owner",
      visibility: "project",
    });
  });

  test("run is never granted by read alone — every consumer names its action", () => {
    // A caller who can read a project workflow cannot edit it; a caller
    // who can read a private one cannot even run it. Two different
    // separations, both driven by the `action` argument.
    //
    // The reader here is `member`, not `stranger`: since the membership
    // split a stranger cannot READ a project-scoped row either, so using
    // them would make the first line vacuously false and stop testing the
    // read/edit separation at all.
    expect(authorizeWorkflow(projectEntry, member, "read").ok).toBe(true);
    expect(authorizeWorkflow(projectEntry, member, "edit").ok).toBe(false);
    expect(authorizeWorkflow(privateEntry, stranger, "read").ok).toBe(false);
    expect(authorizeWorkflow(privateEntry, stranger, "run").ok).toBe(false);
  });
});

describe("ownerless sources are system-owned", () => {
  test("a YAML workflow is a system entry with no row", () => {
    const entry = systemCachedWorkflow(definition("nightly"), "yaml");
    expect(entry).toMatchObject({
      source: "yaml",
      id: null,
      projectId: null,
      userId: null,
      visibility: "system",
      forkedFrom: null,
    });
  });

  test("an extension workflow is a system entry with no row", () => {
    const entry = systemCachedWorkflow(definition("ez-factory:docs"), "extension");
    expect(entry.source).toBe("extension");
    expect(entry.id).toBeNull();
    expect(entry.visibility).toBe("system");
  });

  test("the resolver does not assume a row exists — an ownerless entry authorizes", () => {
    const entries = [systemCachedWorkflow(definition("nightly"), "yaml")];
    expect(resolveWorkflowForCaller(entries, "nightly", stranger, "run").ok).toBe(true);
  });

  test("an ownerless entry is never editable, whoever asks", () => {
    const yaml = systemCachedWorkflow(definition("nightly"), "yaml");
    // Even an admin: a YAML asset is a file on disk, not a row.
    expect(authorizeWorkflow(yaml, admin, "edit")).toEqual({
      ok: false,
      reason: "not-editable-source",
      visibility: "system",
    });
    expect(authorizeWorkflow(yaml, owner, "edit")).toEqual({
      ok: false,
      reason: "not-editable-source",
      visibility: "system",
    });
  });
});

describe("resolveWorkflowForCaller", () => {
  const entries = [
    systemCachedWorkflow(definition("ez-factory:docs"), "extension"),
    systemCachedWorkflow(definition("nightly"), "yaml"),
    dbEntry({ definition: definition("deploy"), visibility: "private", userId: OWNER }),
  ];

  test("an unknown name is not-found", () => {
    expect(resolveWorkflowForCaller(entries, "nope", admin, "read")).toEqual({
      ok: false,
      reason: "not-found",
      // No row matched, so there is no tier to name. The ONE denial that
      // carries a null visibility.
      visibility: null,
    });
  });

  test("resolves by exact name and returns the entry", () => {
    const result = resolveWorkflowForCaller(entries, "nightly", member, "run");
    expect(result.ok && result.entry.definition.name).toBe("nightly");
  });

  test("an unauthorized name denies with the ladder's reason, not not-found", () => {
    // The distinction matters upstream: `denialStatus` turns BOTH into a
    // 404 for reads, but the reason is what an audit log records.
    expect(resolveWorkflowForCaller(entries, "deploy", stranger, "run")).toEqual({
      ok: false,
      reason: "not-owner",
      visibility: "private",
    });
  });

  test("lookup is first-match in cache order, so an extension name cannot be shadowed", () => {
    const shadowed = [
      systemCachedWorkflow(definition("deploy"), "extension"),
      dbEntry({ definition: definition("deploy") }),
    ];
    const result = resolveWorkflowForCaller(shadowed, "deploy", admin, "read");
    expect(result.ok && result.entry.source).toBe("extension");
  });
});

describe("list filtering agrees with the single-entry resolver", () => {
  const entries = [
    systemCachedWorkflow(definition("nightly"), "yaml"),
    dbEntry({
      definition: definition("shared"),
      visibility: "project",
      projectId: PROJECT,
      userId: OWNER,
    }),
    dbEntry({
      definition: definition("secret"),
      visibility: "private",
      projectId: PROJECT,
      userId: OWNER,
    }),
  ];

  test("system entries are visible to everyone", () => {
    for (const caller of [owner, member, stranger, admin, keyNoProject]) {
      expect(visibleWorkflows(entries, caller).map((e) => e.definition.name)).toContain("nightly");
    }
  });

  test("a non-admin sees a strict subset", () => {
    // A member of the project sees the shared workflow but not the
    // private one.
    const seenByMember = visibleWorkflows(entries, member).map((e) => e.definition.name);
    expect(seenByMember).toEqual(["nightly", "shared"]);
    expect(seenByMember.length).toBeLessThan(entries.length);

    // A member of a DIFFERENT project sees neither — the membership split
    // narrowed the list, not just the single-entry resolver, because both
    // are the same `authorizeWorkflow` call.
    const seenByStranger = visibleWorkflows(entries, stranger).map((e) => e.definition.name);
    expect(seenByStranger).toEqual(["nightly"]);
  });

  test("an admin sees everything", () => {
    expect(visibleWorkflows(entries, admin)).toHaveLength(3);
  });

  test("anything a caller may RUN, that caller can also SEE in the list", () => {
    // Runnable-but-invisible is undiagnosable for a user, and it is
    // exactly what two independently-written filters eventually produce.
    // Asserted across the whole cache rather than trusted to review.
    for (const caller of [owner, member, stranger, admin, keyNoProject]) {
      const visible = new Set(visibleWorkflows(entries, caller).map((e) => e.definition.name));
      for (const entry of entries) {
        if (authorizeWorkflow(entry, caller, "run").ok) {
          expect(visible.has(entry.definition.name)).toBe(true);
        }
      }
    }
  });
});

describe("denial status and message", () => {
  /**
   * The table, written out rather than recomputed.
   *
   * A `Record<WorkflowAction, Record<WorkflowVisibility, …>>` on purpose:
   * a fourth tier or a fourth action fails TYPECHECK here until someone
   * decides whether it conceals its rows' existence. Re-deriving the
   * answer from the same `if` chain the function uses would assert
   * nothing.
   *
   * The REASON is absent from the key deliberately. For everything but
   * `not-found` the status is a property of the row and the verb, never
   * of why the ladder said no — and the sweep below proves that across
   * every reason instead of assuming it. Keying on the reason is how
   * `private` + `not-editable-source` would quietly become a 403 and
   * leak the existence the `not-owner` 404 conceals.
   */
  const EXPECTED: Record<WorkflowAction, Record<WorkflowVisibility, 403 | 404>> = {
    // Read and run hide every tier: a 403 confirms the name exists.
    read: { system: 404, project: 404, private: 404 },
    run: { system: 404, project: 404, private: 404 },
    // Edit hides `private` ONLY. `system` and `project` are readable by
    // everyone who can reach the route, so a 403 tells them nothing they
    // could not already see — and a 404 for a workflow sitting in their
    // own list would just be confusing.
    edit: { system: 403, project: 403, private: 404 },
  };
  const ACTIONS = Object.keys(EXPECTED) as WorkflowAction[];
  const TIERS = Object.keys(EXPECTED.read) as WorkflowVisibility[];
  /**
   * Every reason that names a row. `not-found` has none, and is swept apart.
   *
   * A `Record` keyed by the union rather than a bare array, for the same
   * reason {@link EXPECTED} is one: a bare `WorkflowDenialReason[]` accepts
   * a SUBSET silently, so a reason added later is simply never swept and
   * the omission cannot fail anything. `not-project-member` is exactly that
   * case — it arrived with the project-membership split, after this table
   * was written, and a plain array would have left the newest reason the
   * only unswept one. Keyed this way, a fifth reason fails TYPECHECK here
   * until someone decides what status it carries.
   */
  const ROW_NAMING_REASONS: Record<Exclude<WorkflowDenialReason, "not-found">, true> = {
    "not-authenticated": true,
    "not-owner": true,
    "not-editable-source": true,
    "requires-admin": true,
    // Read/run only, and 404 on every tier like every other read/run
    // denial — which is what keeps a project-scoped row's existence from
    // being confirmed to a non-member. Asserted here rather than trusted.
    "not-project-member": true,
  };
  const REASONS = Object.keys(ROW_NAMING_REASONS) as Exclude<WorkflowDenialReason, "not-found">[];

  test("the sweep below is not vacuous", () => {
    expect(ACTIONS).toEqual(["read", "run", "edit"]);
    expect(TIERS.sort()).toEqual(["private", "project", "system"]);
    expect(REASONS).toHaveLength(5);
    expect(REASONS).toContain("not-project-member");
  });

  for (const action of ACTIONS) {
    for (const tier of TIERS) {
      const status = EXPECTED[action][tier];
      test(`${tier} × ${action} → ${status}, whatever the reason`, () => {
        for (const reason of REASONS) {
          expect(denialStatus(reason, action, tier)).toBe(status);
        }
      });
    }
  }

  test("a `private` EDIT denial is indistinguishable from a name that does not exist", () => {
    // THE ruling. Before it, a caller probing PUT/DELETE could tell
    // "this private workflow exists and is not yours" (403) from "no
    // such workflow" (404) — an existence oracle for private names on
    // the write verbs, mirroring the one the read 404 already closed.
    // Status AND body, because either alone re-opens it.
    expect(denialStatus("not-owner", "edit", "private")).toBe(
      denialStatus("not-found", "edit", null),
    );
    expect(denialMessage("not-owner", "edit", "private")).toBe(
      denialMessage("not-found", "edit", null),
    );
    expect(denialMessage("not-owner", "edit", "private")).toBe("Not found");
  });

  test("the concealment is `private`-only — the other two tiers still 403", () => {
    // Discrimination for the test above: the 404 is not blanket. A
    // `system` or `project` edit denial still says "forbidden", and says
    // WHY, because the caller can already see the row.
    expect(denialStatus("requires-admin", "edit", "system")).toBe(403);
    expect(denialStatus("not-owner", "edit", "project")).toBe(403);
    expect(denialStatus("not-editable-source", "edit", "system")).toBe(403);
    expect(denialMessage("requires-admin", "edit", "system")).not.toBe("Not found");
    expect(denialMessage("not-owner", "edit", "project")).not.toBe("Not found");
  });

  test("an unauthorized READ is a 404 on every tier, so the endpoint is not an existence oracle", () => {
    // The claim the old comment made and nothing checked exhaustively.
    for (const tier of TIERS) {
      for (const reason of REASONS) {
        expect(denialStatus(reason, "read", tier)).toBe(404);
        expect(denialStatus(reason, "run", tier)).toBe(404);
        expect(denialMessage(reason, "read", tier)).toBe("Not found");
        expect(denialMessage(reason, "run", tier)).toBe("Not found");
      }
    }
  });

  test("not-found is a 404 whatever the action, and carries no tier", () => {
    for (const action of ACTIONS) {
      expect(denialStatus("not-found", action, null)).toBe(404);
      expect(denialMessage("not-found", action, null)).toBe("Not found");
    }
  });

  test("every 404 body is exactly `Not found` — no message outlives the status", () => {
    // The half a status-only rule would miss: `denialMessage` branches on
    // `denialStatus`, so a 404 that fell through to a reason-specific
    // string ("only an admin can change it") would hand back the
    // existence the status just withheld.
    for (const action of ACTIONS) {
      for (const tier of [...TIERS, null]) {
        for (const reason of [...REASONS, "not-found" as const]) {
          if (denialStatus(reason, action, tier) !== 404) continue;
          expect(denialMessage(reason, action, tier)).toBe("Not found");
        }
      }
    }
  });

  test("each edit denial that IS a 403 carries its own message", () => {
    expect(denialMessage("requires-admin", "edit", "system")).toContain("admin");
    expect(denialMessage("not-editable-source", "edit", "system")).toContain("only DB workflows");
    expect(denialMessage("not-owner", "edit", "project")).toContain("permission");
    expect(denialMessage("not-authenticated", "edit", "project")).toContain("permission");
  });

  test("the status caller cannot lose the tier — the denial carries it", () => {
    // Why the signature changed rather than the call site guessing. The
    // ladder is the only thing that knows which row was refused, so the
    // denial hands the tier over; `resolveWorkflowForCaller` is where a
    // route gets both, and the only `null` it can produce is the one
    // that genuinely has no row.
    const entries = [
      dbEntry({ definition: definition("secret"), visibility: "private", userId: OWNER }),
    ];
    const refused = resolveWorkflowForCaller(entries, "secret", stranger, "edit");
    const missing = resolveWorkflowForCaller(entries, "no-such-name", stranger, "edit");
    expect(refused.ok).toBe(false);
    expect(missing.ok).toBe(false);
    if (refused.ok || missing.ok) throw new Error("expected both to deny");
    expect(refused.visibility).toBe("private");
    expect(missing.visibility).toBeNull();
    // End to end through both functions: the two are the same response.
    expect(denialStatus(refused.reason, "edit", refused.visibility)).toBe(404);
    expect(denialStatus(missing.reason, "edit", missing.visibility)).toBe(404);
    expect(denialMessage(refused.reason, "edit", refused.visibility)).toBe(
      denialMessage(missing.reason, "edit", missing.visibility),
    );
  });
});

describe("readRunAudience names the set each tier admits", () => {
  // The audience is the honest replacement for an `isProjectMember` that
  // returned `caller.userId !== null` and read, at every call site, as a
  // membership check the platform could not perform. It can now, so the
  // `project` tier splits on the ROW's project id. Which tiers are
  // REACHABLE, and what that leaves a delegated fire able to touch, is
  // pinned separately in `workflow-visibility-reach.test.ts`.
  test("each tier maps to its own audience", () => {
    expect(readRunAudience("system", null)).toBe("anyone");
    expect(readRunAudience("private", null)).toBe("owner-and-admins");
    // The split. The tier NAME is identical on both lines; the row's own
    // `project_id` is what moves the answer.
    expect(readRunAudience("project", null)).toBe("any-authenticated-principal");
    expect(readRunAudience("project", PROJECT)).toBe("project-members-and-admins");
  });

  test("the project id does not disturb the other two tiers", () => {
    // `system` and `private` answer the same question whatever the row is
    // scoped to — otherwise "scoped to a project" would quietly become a
    // second visibility axis.
    expect(readRunAudience("system", PROJECT)).toBe("anyone");
    expect(readRunAudience("private", PROJECT)).toBe("owner-and-admins");
  });

  test("a project-SCOPED workflow admits that project's members and refuses everyone else", () => {
    // The behaviour the whole membership model exists for, asserted
    // through the ladder rather than the predicate so it is the real
    // decision being pinned.
    expect(authorizeWorkflow(projectEntry, member, "run").ok).toBe(true);
    for (const caller of [stranger, keyNoProject]) {
      expect(authorizeWorkflow(projectEntry, caller, "run")).toEqual({
        ok: false,
        reason: "not-project-member",
        visibility: "project",
      });
    }
    // The admin override is a ROLE exemption, not a membership: `admin`
    // carries an empty set, so this allow can only come from the role.
    expect(admin.projectMemberships).toHaveLength(0);
    expect(authorizeWorkflow(projectEntry, admin, "run").ok).toBe(true);
  });

  test("a project-LESS workflow still admits every authenticated caller", () => {
    // Same tier, no project id: there is nothing to be a member of, so
    // gating it would refuse everyone rather than narrow anything.
    for (const caller of [member, stranger, keyNoProject]) {
      expect(authorizeWorkflow(projectlessEntry, caller, "run").ok).toBe(true);
    }
  });

  test("the membership set is compared against the ROW's project, not the caller's claim", () => {
    // The one assertion that separates a real check from theatre. The
    // caller CLAIMS the workflow's project (`projectId: PROJECT`) while
    // belonging to a different one — the shape an attacker produces by
    // putting someone else's project id in a query param. If
    // `caller.projectId` were consulted this would pass.
    const liar: WorkflowCaller = {
      userId: "user-liar",
      role: "member",
      projectId: PROJECT,
      projectMemberships: ["project-b"],
    };
    expect(authorizeWorkflow(projectEntry, liar, "run")).toEqual({
      ok: false,
      reason: "not-project-member",
      visibility: "project",
    });
    // …and the mirror image: a real member who claims NO project is still
    // admitted, because the claim is irrelevant in both directions.
    const quietMember: WorkflowCaller = {
      userId: "user-quiet",
      role: "member",
      projectId: null,
      projectMemberships: [PROJECT],
    };
    expect(authorizeWorkflow(projectEntry, quietMember, "run").ok).toBe(true);
  });

  test("`private` refuses that same stranger — the audiences discriminate", () => {
    expect(authorizeWorkflow(privateEntry, stranger, "run")).toEqual({
      ok: false,
      reason: "not-owner",
      visibility: "private",
    });
  });

  test("a userless principal is denied a project workflow but still gets system ones", () => {
    // A userless principal is refused for the reason that applies to IT —
    // it has no identity to key a membership by — rather than for
    // `not-project-member`, which would describe a lookup that could
    // never have succeeded.
    expect(authorizeWorkflow(systemEntry, cli, "run").ok).toBe(true);
    expect(authorizeWorkflow(projectEntry, cli, "run")).toEqual({
      ok: false,
      reason: "not-authenticated",
      visibility: "project",
    });
    expect(authorizeWorkflow(projectlessEntry, cli, "run")).toEqual({
      ok: false,
      reason: "not-authenticated",
      // The TIER, not the project id — a project-less `project` row is
      // still a `project` row, and the denial names what it was refused on.
      visibility: "project",
    });
    expect(authorizeWorkflow(projectEntry, cli, "edit")).toEqual({
      ok: false,
      reason: "not-authenticated",
      visibility: "project",
    });
  });
});

describe("callerFromUser", () => {
  test("maps an admin user to the admin role", () => {
    expect(callerFromUser({ id: "u1", role: "admin" }, "p1", ["p1", "p2"])).toEqual({
      userId: "u1",
      role: "admin",
      projectId: "p1",
      projectMemberships: ["p1", "p2"],
    });
  });

  test("anything that is not literally admin is a member — fail closed", () => {
    expect(callerFromUser({ id: "u1", role: "superuser" }, null, []).role).toBe("member");
    expect(callerFromUser({ id: "u1" }, null, []).role).toBe("member");
  });

  test("an absent project becomes null, never undefined", () => {
    expect(callerFromUser({ id: "u1" }, undefined, []).projectId).toBeNull();
  });

  test("the memberships are passed through verbatim — never defaulted", () => {
    // A default here would be the hazard the required parameter exists to
    // stop: every call site would keep compiling while authorizing
    // against an empty set. There is nothing to assert about a default
    // that does not exist, so what is asserted is the pass-through.
    expect(callerFromUser({ id: "u1" }, null, NO_PROJECT_MEMBERSHIPS).projectMemberships).toBe(
      NO_PROJECT_MEMBERSHIPS,
    );
    expect(callerFromUser({ id: "u1" }, null, ["p9"]).projectMemberships).toEqual(["p9"]);
  });
});

describe("NO_PROJECT_MEMBERSHIPS", () => {
  test("is empty and frozen, so a consumer cannot widen the shared instance", () => {
    expect(NO_PROJECT_MEMBERSHIPS).toEqual([]);
    expect(Object.isFrozen(NO_PROJECT_MEMBERSHIPS)).toBe(true);
  });

  test("satisfies no project-scoped entry — it is the fail-closed value", () => {
    const withNone: WorkflowCaller = {
      userId: "u1",
      role: "member",
      projectId: PROJECT,
      projectMemberships: NO_PROJECT_MEMBERSHIPS,
    };
    expect(authorizeWorkflow(projectEntry, withNone, "run")).toEqual({
      ok: false,
      reason: "not-project-member",
      visibility: "project",
    });
  });
});

describe("denyVisibilityAssignment — who may STAMP a tier", () => {
  // `NO_PROJECT_MEMBERSHIPS` on both, because assignment reads `role` and
  // nothing else — the same reason `denyVisibilityOr` stays synchronous.
  const member: WorkflowCaller = {
    userId: "u1",
    role: "member",
    projectId: null,
    projectMemberships: NO_PROJECT_MEMBERSHIPS,
  };
  const admin: WorkflowCaller = {
    userId: "a1",
    role: "admin",
    projectId: null,
    projectMemberships: NO_PROJECT_MEMBERSHIPS,
  };

  /**
   * The reachable set, stated once.
   *
   * A `Record<WorkflowVisibility, …>` rather than a literal array on
   * purpose: adding a fourth tier to the union fails TYPECHECK here until
   * someone decides who may assign it. This replaces the structural sweep
   * that used to assert the writable set was exactly `{system, project}` —
   * that assertion was true only because `private` was unwritable, and
   * Ruling 1 is precisely the change that makes it false.
   */
  const MAY_A_MEMBER_ASSIGN: Record<WorkflowVisibility, boolean> = {
    system: false,
    project: true,
    private: true,
  };
  const TIERS = Object.keys(MAY_A_MEMBER_ASSIGN) as WorkflowVisibility[];

  test("all three tiers are covered, and the sweep is not vacuous", () => {
    expect(TIERS).toHaveLength(3);
    expect(TIERS).toContain("private");
  });

  test.each(TIERS)("a member assigning %s matches the declared table", (tier) => {
    const allowed = denyVisibilityAssignment(member, tier) === null;
    expect(allowed).toBe(MAY_A_MEMBER_ASSIGN[tier]);
  });

  test.each(TIERS)("an admin may assign %s", (tier) => {
    expect(denyVisibilityAssignment(admin, tier)).toBeNull();
  });

  test("the member's refusal names the actual rule", () => {
    // Not just "some string" — the message a user reads has to say which
    // tier was refused and who could grant it.
    expect(denyVisibilityAssignment(member, "system")).toBe(VISIBILITY_ASSIGNMENT_DENIAL);
    expect(VISIBILITY_ASSIGNMENT_DENIAL).toContain("admin");
    expect(VISIBILITY_ASSIGNMENT_DENIAL).toContain("system");
  });

  test("an absent visibility is not an assignment — the caller is not choosing", () => {
    // An ordinary edit that carries no `visibility` must not be refused,
    // and must not be read as a request for the default either.
    expect(denyVisibilityAssignment(member, undefined)).toBeNull();
    expect(denyVisibilityAssignment(admin, undefined)).toBeNull();
  });

  test("assignment is asked SEPARATELY from edit — clearing edit does not imply it", () => {
    // The discrimination that keeps this function from being redundant.
    // This caller owns a `private` DB row, so the ladder grants them
    // `edit` on it as it stands — and they still may not promote it to
    // `system`. A rule that merely deferred to `authorizeWorkflow` would
    // let them.
    const owned: CachedWorkflow = {
      definition: { name: "w", description: "", steps: [] } as WorkflowDefinition,
      source: "db",
      id: "wf-1",
      projectId: null,
      userId: "u1",
      visibility: "private",
      forkedFrom: null,
    };
    expect(authorizeWorkflow(owned, member, "edit").ok).toBe(true);
    expect(denyVisibilityAssignment(member, "system")).not.toBeNull();
  });
});
