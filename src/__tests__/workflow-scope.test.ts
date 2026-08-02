import { describe, expect, test } from "bun:test";
import {
  authorizeWorkflow,
  callerFromUser,
  denialMessage,
  denialStatus,
  denyVisibilityAssignment,
  VISIBILITY_ASSIGNMENT_DENIAL,
  readRunAudience,
  resolveWorkflowForCaller,
  systemCachedWorkflow,
  visibleWorkflows,
  type CachedWorkflow,
  type WorkflowAction,
  type WorkflowCaller,
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

const owner: WorkflowCaller = { userId: OWNER, role: "member", projectId: PROJECT };
const member: WorkflowCaller = { userId: "user-member", role: "member", projectId: PROJECT };
const stranger: WorkflowCaller = { userId: "user-stranger", role: "member", projectId: "project-b" };
const admin: WorkflowCaller = { userId: "user-admin", role: "admin", projectId: null };
/** An API-key principal with no project context — `requireScope` admits it
 *  and it carries a user identity, but it named no project. */
const keyNoProject: WorkflowCaller = { userId: "user-key", role: "member", projectId: null };

const systemEntry = dbEntry({ visibility: "system" });
const projectEntry = dbEntry({ visibility: "project", projectId: PROJECT, userId: OWNER });
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
    // ── system: any caller may read and run; only an admin may edit ──
    { entry: systemEntry, caller: owner, who: "owner", action: "read", expected: true },
    { entry: systemEntry, caller: owner, who: "owner", action: "run", expected: true },
    { entry: systemEntry, caller: owner, who: "owner", action: "edit", expected: "requires-admin" },
    { entry: systemEntry, caller: member, who: "member", action: "read", expected: true },
    { entry: systemEntry, caller: member, who: "member", action: "run", expected: true },
    { entry: systemEntry, caller: member, who: "member", action: "edit", expected: "requires-admin" },
    { entry: systemEntry, caller: stranger, who: "stranger", action: "read", expected: true },
    { entry: systemEntry, caller: stranger, who: "stranger", action: "run", expected: true },
    { entry: systemEntry, caller: stranger, who: "stranger", action: "edit", expected: "requires-admin" },
    { entry: systemEntry, caller: admin, who: "admin", action: "read", expected: true },
    { entry: systemEntry, caller: admin, who: "admin", action: "run", expected: true },
    { entry: systemEntry, caller: admin, who: "admin", action: "edit", expected: true },
    { entry: systemEntry, caller: keyNoProject, who: "api key", action: "read", expected: true },
    { entry: systemEntry, caller: keyNoProject, who: "api key", action: "run", expected: true },
    { entry: systemEntry, caller: keyNoProject, who: "api key", action: "edit", expected: "requires-admin" },

    // ── project: members read/run; only the creator (or admin) edits ──
    { entry: projectEntry, caller: owner, who: "owner", action: "read", expected: true },
    { entry: projectEntry, caller: owner, who: "owner", action: "run", expected: true },
    { entry: projectEntry, caller: owner, who: "owner", action: "edit", expected: true },
    { entry: projectEntry, caller: member, who: "member", action: "read", expected: true },
    { entry: projectEntry, caller: member, who: "member", action: "run", expected: true },
    { entry: projectEntry, caller: member, who: "member", action: "edit", expected: "not-owner" },
    { entry: projectEntry, caller: stranger, who: "stranger", action: "read", expected: true },
    { entry: projectEntry, caller: stranger, who: "stranger", action: "run", expected: true },
    { entry: projectEntry, caller: stranger, who: "stranger", action: "edit", expected: "not-owner" },
    { entry: projectEntry, caller: admin, who: "admin", action: "read", expected: true },
    { entry: projectEntry, caller: admin, who: "admin", action: "run", expected: true },
    { entry: projectEntry, caller: admin, who: "admin", action: "edit", expected: true },
    { entry: projectEntry, caller: keyNoProject, who: "api key", action: "read", expected: true },
    { entry: projectEntry, caller: keyNoProject, who: "api key", action: "run", expected: true },
    { entry: projectEntry, caller: keyNoProject, who: "api key", action: "edit", expected: "not-owner" },

    // ── private: owner or admin only, for every action ────────────────
    { entry: privateEntry, caller: owner, who: "owner", action: "read", expected: true },
    { entry: privateEntry, caller: owner, who: "owner", action: "run", expected: true },
    { entry: privateEntry, caller: owner, who: "owner", action: "edit", expected: true },
    { entry: privateEntry, caller: member, who: "member", action: "read", expected: "not-owner" },
    { entry: privateEntry, caller: member, who: "member", action: "run", expected: "not-owner" },
    { entry: privateEntry, caller: member, who: "member", action: "edit", expected: "not-owner" },
    { entry: privateEntry, caller: stranger, who: "stranger", action: "read", expected: "not-owner" },
    { entry: privateEntry, caller: stranger, who: "stranger", action: "run", expected: "not-owner" },
    { entry: privateEntry, caller: stranger, who: "stranger", action: "edit", expected: "not-owner" },
    { entry: privateEntry, caller: admin, who: "admin", action: "read", expected: true },
    { entry: privateEntry, caller: admin, who: "admin", action: "run", expected: true },
    { entry: privateEntry, caller: admin, who: "admin", action: "edit", expected: true },
    { entry: privateEntry, caller: keyNoProject, who: "api key", action: "read", expected: "not-owner" },
    { entry: privateEntry, caller: keyNoProject, who: "api key", action: "run", expected: "not-owner" },
    { entry: privateEntry, caller: keyNoProject, who: "api key", action: "edit", expected: "not-owner" },
  ];

  for (const { entry, caller, who, action, expected } of cases) {
    const verdict = expected === true ? "allows" : `denies (${expected})`;
    test(`${entry.visibility} × ${who} × ${action} — ${verdict}`, () => {
      const result = authorizeWorkflow(entry, caller, action);
      if (expected === true) {
        expect(result.ok).toBe(true);
      } else {
        expect(result).toEqual({ ok: false, reason: expected as never });
      }
    });
  }

  test("the matrix covers every visibility × caller × action combination", () => {
    expect(cases).toHaveLength(3 * 5 * 3);
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
    expect(authorizeWorkflow(projectEntry, member, "run")).toEqual({ ok: true, entry: projectEntry });
    expect(authorizeWorkflow(projectEntry, member, "edit")).toEqual({
      ok: false,
      reason: "not-owner",
    });
  });

  test("run is never granted by read alone — every consumer names its action", () => {
    // A caller who can read a project workflow cannot edit it; a caller
    // who can read a private one cannot even run it. Two different
    // separations, both driven by the `action` argument.
    expect(authorizeWorkflow(projectEntry, stranger, "read").ok).toBe(true);
    expect(authorizeWorkflow(projectEntry, stranger, "edit").ok).toBe(false);
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
    });
    expect(authorizeWorkflow(yaml, owner, "edit")).toEqual({
      ok: false,
      reason: "not-editable-source",
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
    dbEntry({ definition: definition("shared"), visibility: "project", projectId: PROJECT, userId: OWNER }),
    dbEntry({ definition: definition("secret"), visibility: "private", projectId: PROJECT, userId: OWNER }),
  ];

  test("system entries are visible to everyone", () => {
    for (const caller of [owner, member, stranger, admin, keyNoProject]) {
      expect(visibleWorkflows(entries, caller).map((e) => e.definition.name)).toContain("nightly");
    }
  });

  test("a non-admin sees a strict subset", () => {
    const seen = visibleWorkflows(entries, stranger).map((e) => e.definition.name);
    expect(seen).toEqual(["nightly", "shared"]);
    expect(seen.length).toBeLessThan(entries.length);
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
  test("an unauthorized READ is a 404, so the endpoint is not an existence oracle", () => {
    expect(denialStatus("not-owner", "read")).toBe(404);
    expect(denialStatus("not-authenticated", "read")).toBe(404);
    expect(denialStatus("not-owner", "run")).toBe(404);
    expect(denialMessage("not-owner", "read")).toBe("Not found");
  });

  test("a denied EDIT is a 403 — the caller can already see it, so there is nothing to conceal", () => {
    expect(denialStatus("requires-admin", "edit")).toBe(403);
    expect(denialStatus("not-owner", "edit")).toBe(403);
    expect(denialStatus("not-editable-source", "edit")).toBe(403);
  });

  test("not-found is a 404 whatever the action", () => {
    expect(denialStatus("not-found", "edit")).toBe(404);
    expect(denialStatus("not-found", "run")).toBe(404);
  });

  test("each edit denial carries its own message", () => {
    expect(denialMessage("requires-admin", "edit")).toContain("admin");
    expect(denialMessage("not-editable-source", "edit")).toContain("only DB workflows");
    expect(denialMessage("not-owner", "edit")).toContain("permission");
    expect(denialMessage("not-authenticated", "edit")).toContain("permission");
  });
});

describe("readRunAudience names the set each tier admits", () => {
  // The audience is the honest replacement for an `isProjectMember` that
  // returned `caller.userId !== null` and read, at every call site, as a
  // membership check the platform cannot perform. Which tiers are
  // REACHABLE, and what that leaves a delegated fire able to touch, is
  // pinned separately in `workflow-visibility-reach.test.ts`.
  test("each tier maps to its own audience", () => {
    expect(readRunAudience("system")).toBe("anyone");
    expect(readRunAudience("project")).toBe("any-authenticated-principal");
    expect(readRunAudience("private")).toBe("owner-and-admins");
  });

  test("`project` admits every authenticated caller, member or not", () => {
    // Same audience for the project's own "member", a total stranger and
    // an API key that named no project: there is nothing to distinguish
    // them by. Asserted through the ladder, not the predicate, so it is
    // the real decision being pinned.
    for (const caller of [member, stranger, keyNoProject]) {
      expect(authorizeWorkflow(projectEntry, caller, "run").ok).toBe(true);
    }
  });

  test("`private` refuses that same stranger — the audiences discriminate", () => {
    expect(authorizeWorkflow(privateEntry, stranger, "run")).toEqual({
      ok: false,
      reason: "not-owner",
    });
  });

  test("a userless principal is denied a project workflow but still gets system ones", () => {
    // The whole read/run difference between `system` and `project`: a
    // login, not an identity. `not-authenticated` says exactly that,
    // where `not-project-member` named a check that never ran.
    const cli: WorkflowCaller = { userId: null, role: "member" };
    expect(authorizeWorkflow(systemEntry, cli, "run").ok).toBe(true);
    expect(authorizeWorkflow(projectEntry, cli, "run")).toEqual({
      ok: false,
      reason: "not-authenticated",
    });
    expect(authorizeWorkflow(projectEntry, cli, "edit")).toEqual({
      ok: false,
      reason: "not-authenticated",
    });
  });
});

describe("callerFromUser", () => {
  test("maps an admin user to the admin role", () => {
    expect(callerFromUser({ id: "u1", role: "admin" }, "p1")).toEqual({
      userId: "u1",
      role: "admin",
      projectId: "p1",
    });
  });

  test("anything that is not literally admin is a member — fail closed", () => {
    expect(callerFromUser({ id: "u1", role: "superuser" }).role).toBe("member");
    expect(callerFromUser({ id: "u1" }).role).toBe("member");
  });

  test("an absent project becomes null, never undefined", () => {
    expect(callerFromUser({ id: "u1" }).projectId).toBeNull();
  });
});

describe("denyVisibilityAssignment — who may STAMP a tier", () => {
  const member: WorkflowCaller = { userId: "u1", role: "member", projectId: null };
  const admin: WorkflowCaller = { userId: "a1", role: "admin", projectId: null };

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
