import { describe, expect, test } from "bun:test";
import {
  authorizeWorkflow,
  callerFromUser,
  denialMessage,
  denialStatus,
  isProjectMember,
  resolveWorkflowForCaller,
  systemCachedWorkflow,
  visibleWorkflows,
  type CachedWorkflow,
  type WorkflowAction,
  type WorkflowCaller,
} from "../runtime/workflow-scope";
import type { WorkflowDefinition } from "../types";

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
    expect(denialStatus("not-project-member", "read")).toBe(404);
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
    expect(denialMessage("not-project-member", "edit")).toContain("permission");
  });
});

describe("project membership is not a confidentiality boundary today", () => {
  // Recorded as a test, not a comment, because it is a real limitation
  // and the day it stops being true this test SHOULD fail and be updated.
  // `projects` has no owner column, there is no `project_members` table,
  // and `GET /api/projects` returns every project to every authenticated
  // caller — so `project` visibility is an edit boundary and a label,
  // never a confidentiality boundary. `private` is the real one.
  test("every authenticated caller is a member of every project", () => {
    expect(isProjectMember(member, PROJECT)).toBe(true);
    expect(isProjectMember(stranger, PROJECT)).toBe(true);
    expect(isProjectMember(keyNoProject, PROJECT)).toBe(true);
  });

  test("a principal with no user identity is a member of nothing", () => {
    expect(isProjectMember({ userId: null, role: "member" }, PROJECT)).toBe(false);
  });

  test("a userless principal is denied a project workflow but still gets system ones", () => {
    const cli: WorkflowCaller = { userId: null, role: "member" };
    expect(authorizeWorkflow(systemEntry, cli, "run").ok).toBe(true);
    expect(authorizeWorkflow(projectEntry, cli, "run")).toEqual({
      ok: false,
      reason: "not-project-member",
    });
    expect(authorizeWorkflow(projectEntry, cli, "edit")).toEqual({
      ok: false,
      reason: "not-project-member",
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
