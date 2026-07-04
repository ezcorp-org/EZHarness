/**
 * Unit tests for the extension-RBAC grants API
 * (web/src/routes/api/rbac/extension-grants/+server.ts and .../[id]/+server.ts).
 *
 * Mirrors the secrets-route test structure: the DB query layer is an
 * in-memory store, but the DELEGATION LOGIC IS REAL — the routes call the
 * actual `src/auth/extension-rbac.ts` (canManageGrant / resolveEffectiveScopes),
 * whose relative imports of the query + users modules are intercepted by the
 * same mocks, so the full authorization matrix here exercises the genuine
 * rules, not a stub of them. We drive every route line to 100% and assert:
 *   - GET visibility: admin = all rows; manager = own + manage-coverage;
 *     member = own rows only,
 *   - POST/DELETE delegation: admin all-CRUD; manager inside coverage OK,
 *     outside coverage / breadth-escalation / `manage`-touching / admin-
 *     grantee / unknown-grantee all 403; member self-grant 403,
 *   - invalid scopes → 400 (InvalidRbacScopeError message), unknown
 *     user/project/extension → clean 404 (never a 500),
 *   - RBAC_GRANTED / RBAC_REVOKED audit rows on success ONLY,
 *   - no response ever contains a passwordHash.
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "../../../../../../src/__tests__/helpers/mock-cleanup";
import {
  mockServerAlias,
  ADMIN_USER,
  MEMBER_USER,
  createMockEvent,
} from "../../../../../../src/__tests__/helpers/mock-request";
import type { AuthUser } from "../../../../../../src/auth/types";

mockServerAlias();

// Generated SvelteKit `$types` modules don't exist under bun:test — stub them.
mock.module("../../../../../../web/src/routes/api/rbac/extension-grants/$types", () => ({}));
mock.module("../../../../../../web/src/routes/api/rbac/extension-grants/[id]/$types", () => ({}));

// Real pass-throughs: response helper, shared view shaping, audit constants.
import * as httpErrorsActual from "../../../../lib/server/http-errors";
mock.module("$lib/server/http-errors", () => httpErrorsActual);
import * as rbacLogicActual from "../../../../lib/rbac-grants-logic";
mock.module("$lib/rbac-grants-logic", () => rbacLogicActual);
import * as auditActionsActual from "../../../../../../src/extensions/audit-actions";
mock.module("$server/extensions/audit-actions", () => auditActionsActual);

// ── In-memory grant store ───────────────────────────────────────────────
// ORDER MATTERS: the real query + users + auth-core modules are imported
// EAGERLY first, so `src/auth/extension-rbac.ts`'s `export { ... } from
// "../db/queries/extension-rbac"` links against the REAL module (bun can't
// link a named re-export against a not-yet-evaluated lazy mock factory).
// The mock.module calls below then LIVE-PATCH the already-evaluated
// modules, which the core's live ESM bindings pick up — so the delegation
// logic stays real while its DB reads hit the in-memory store. The mocks
// keep the full export shape (spread of the actual namespace) per the
// materialization-freeze rule.
import * as rbacQueriesActual from "../../../../../../src/db/queries/extension-rbac";
import * as usersQueriesActual from "../../../../../../src/db/queries/users";
import * as extensionRbacAuthActual from "../../../../../../src/auth/extension-rbac";

type GrantRow = {
  id: string;
  userId: string;
  projectId: string | null;
  extensionId: string | null;
  scopes: string[];
  grantedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

let grantsStore: GrantRow[] = [];
let deleteResult = true; // false = simulate losing a concurrent-revoke race
let nextGrantId = 1;

const upsertCalls: Array<Record<string, unknown>> = [];
const deleteCalls: string[] = [];

function findByAddress(userId: string, projectId: string | null, extensionId: string | null) {
  return grantsStore.find(
    (g) => g.userId === userId && g.projectId === projectId && g.extensionId === extensionId,
  );
}

const rbacQueriesMock = {
  ...rbacQueriesActual,
  listGrants: async (
    filter: { userId?: string; projectId?: string | null; extensionId?: string | null } = {},
  ) =>
    grantsStore.filter(
      (g) =>
        (filter.userId === undefined || g.userId === filter.userId) &&
        (filter.projectId === undefined || g.projectId === filter.projectId) &&
        (filter.extensionId === undefined || g.extensionId === filter.extensionId),
    ),
  listGrantsForUser: async (userId: string) => grantsStore.filter((g) => g.userId === userId),
  getGrant: async (userId: string, projectId: string | null, extensionId: string | null) =>
    findByAddress(userId, projectId, extensionId),
  upsertGrant: async (input: {
    userId: string;
    projectId: string | null;
    extensionId: string | null;
    scopes: string[];
    grantedByUserId: string | null;
  }) => {
    upsertCalls.push({ ...input });
    const scopes = rbacQueriesActual.validateRbacScopes(input.scopes);
    const existing = findByAddress(input.userId, input.projectId, input.extensionId);
    if (existing) {
      existing.scopes = scopes;
      existing.grantedByUserId = input.grantedByUserId;
      existing.updatedAt = new Date("2026-07-03T00:00:00.000Z");
      return existing;
    }
    const row: GrantRow = {
      id: `g-new-${nextGrantId++}`,
      userId: input.userId,
      projectId: input.projectId,
      extensionId: input.extensionId,
      scopes,
      grantedByUserId: input.grantedByUserId,
      createdAt: new Date("2026-07-02T00:00:00.000Z"),
      updatedAt: new Date("2026-07-02T00:00:00.000Z"),
    };
    grantsStore.push(row);
    return row;
  },
  deleteGrant: async (id: string) => {
    deleteCalls.push(id);
    if (!deleteResult) return false;
    const idx = grantsStore.findIndex((g) => g.id === id);
    if (idx < 0) return false;
    grantsStore.splice(idx, 1);
    return true;
  },
};

// Register the mock for BOTH specifiers that resolve to the query module:
// the `$server/...` alias (the routes' import) and the real file path (what
// `src/auth/extension-rbac.ts`'s relative import resolves to).
mock.module("$server/db/queries/extension-rbac", () => rbacQueriesMock);
mock.module("../../../../../../src/db/queries/extension-rbac", () => rbacQueriesMock);

// ── Users (with passwordHash — proving it can never leak) ──────────────
const MANAGER_USER: AuthUser = {
  id: "manager-001",
  email: "manager@test.local",
  name: "Test Manager",
  role: "member",
};

const DB_USERS: Record<string, { id: string; email: string; name: string; role: string; passwordHash: string }> = {
  "admin-001": { id: "admin-001", email: "admin@test.local", name: "Test Admin", role: "admin", passwordHash: "HASH-admin" },
  "member-001": { id: "member-001", email: "member@test.local", name: "Test Member", role: "member", passwordHash: "HASH-member" },
  "manager-001": { id: "manager-001", email: "manager@test.local", name: "Test Manager", role: "member", passwordHash: "HASH-manager" },
  "member-002": { id: "member-002", email: "target@test.local", name: "Target Member", role: "member", passwordHash: "HASH-target" },
  "member-003": { id: "member-003", email: "third@test.local", name: "Third Member", role: "member", passwordHash: "HASH-third" },
};

const usersMock = {
  ...usersQueriesActual,
  getUserById: async (id: string) => DB_USERS[id],
};
mock.module("$server/db/queries/users", () => usersMock);
mock.module("../../../../../../src/db/queries/users", () => usersMock);

// Real delegation core — already evaluated above; its query/user imports
// now resolve to the live-patched in-memory mocks.
mock.module("$server/auth/extension-rbac", () => extensionRbacAuthActual);

// requireAuth real impl throws a 401 Response when no user — keep it real.
// (mockServerAlias already maps $server/auth/middleware to the real module.)

// Projects / extensions lookups (FK pre-flight).
let projectsById: Record<string, { id: string; name: string }> = {};
let extensionsByName: Record<string, { id: string; name: string }> = {};
mock.module("$server/db/queries/projects", () => ({
  getProject: async (id: string) => projectsById[id],
}));
mock.module("$server/db/queries/extensions", () => ({
  getExtensionByName: async (name: string) => extensionsByName[name] ?? null,
}));

// Audit capture.
const auditCalls: Array<{ userId: string | null; action: string; target?: string; metadata?: Record<string, unknown> }> = [];
mock.module("$server/db/queries/audit-log", () => ({
  insertAuditEntry: async (
    userId: string | null,
    action: string,
    target?: string,
    metadata?: Record<string, unknown>,
  ) => {
    auditCalls.push({ userId, action, target, metadata });
    return "audit-row-1";
  },
}));

// ── Import handlers AFTER mocks ─────────────────────────────────────────
const { GET, POST } = await import(
  "../../../../../../web/src/routes/api/rbac/extension-grants/+server"
);
const { DELETE } = await import(
  "../../../../../../web/src/routes/api/rbac/extension-grants/[id]/+server"
);

afterAll(() => restoreModuleMocks());

const EXT = "github-projects";

beforeEach(() => {
  deleteResult = true;
  nextGrantId = 1;
  upsertCalls.length = 0;
  deleteCalls.length = 0;
  auditCalls.length = 0;
  projectsById = {
    "proj-1": { id: "proj-1", name: "Proj One" },
    "proj-2": { id: "proj-2", name: "Proj Two" },
  };
  extensionsByName = { [EXT]: { id: "ext-uuid-1", name: EXT } };
  const t = (id: string, userId: string, projectId: string | null, extensionId: string | null, scopes: string[]): GrantRow => ({
    id,
    userId,
    projectId,
    extensionId,
    scopes,
    grantedByUserId: "admin-001",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  });
  grantsStore = [
    // The manager's own coverage: `manage` at (proj-1, github-projects).
    t("g-manager", "manager-001", "proj-1", EXT, ["manage", "use"]),
    // A member row INSIDE the manager's coverage.
    t("g-inside", "member-002", "proj-1", EXT, ["use"]),
    // A member row OUTSIDE the manager's coverage (proj-2).
    t("g-outside", "member-002", "proj-2", EXT, ["approve-runs"]),
    // member-001's own all-projects/all-extensions row.
    t("g-own", "member-001", null, null, ["use"]),
    // An ADMIN-owned row inside coverage (visible to the manager, immutable).
    t("g-admin-row", "admin-001", "proj-1", EXT, ["use"]),
    // A `manage`-carrying row inside coverage (visible, admin-only to
    // touch). Owned by member-003 — the COALESCE-unique index allows only
    // one row per (user, project, extension), and member-002 already holds
    // g-inside at these coordinates.
    t("g-manage-target", "member-003", "proj-1", EXT, ["manage"]),
  ];
});

function ev(
  opts: {
    method?: string;
    body?: unknown;
    params?: Record<string, string>;
    user?: AuthUser | null;
  } = {},
) {
  return createMockEvent({
    method: opts.method ?? "GET",
    url: "http://localhost/api/rbac/extension-grants",
    body: opts.body,
    params: opts.params ?? {},
    user: opts.user === null ? undefined : (opts.user ?? ADMIN_USER),
  });
}

async function run(handler: any, event: any): Promise<Response> {
  try {
    return await handler(event);
  } catch (e) {
    return e as Response;
  }
}

// ════════════════════════ GET ════════════════════════
describe("GET grants — visibility matrix", () => {
  test("admin sees every grant, joined to public user views", async () => {
    const res = await run(GET, ev({ user: ADMIN_USER }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.grants.map((g: any) => g.id).sort()).toEqual([
      "g-admin-row",
      "g-inside",
      "g-manage-target",
      "g-manager",
      "g-outside",
      "g-own",
    ]);
    const own = body.grants.find((g: any) => g.id === "g-own");
    expect(own.user).toEqual({ id: "member-001", email: "member@test.local", name: "Test Member" });
    expect(own.grantedBy).toBe("admin-001");
    expect(own.projectId).toBe(null);
    expect(own.extensionId).toBe(null);
    expect(typeof own.updatedAt).toBe("string");
  });

  test("no response ever carries a passwordHash", async () => {
    const res = await run(GET, ev({ user: ADMIN_USER }));
    const raw = JSON.stringify(await res.json());
    expect(raw).not.toContain("passwordHash");
    expect(raw).not.toContain("HASH-");
  });

  test("manager sees own rows + manage-coverage rows, not outside-coverage or others' global rows", async () => {
    const res = await run(GET, ev({ user: MANAGER_USER }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.grants.map((g: any) => g.id).sort()).toEqual([
      "g-admin-row",
      "g-inside",
      "g-manage-target",
      "g-manager",
    ]);
  });

  test("member sees only their own rows", async () => {
    const res = await run(GET, ev({ user: MEMBER_USER }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.grants.map((g: any) => g.id)).toEqual(["g-own"]);
  });

  test("a grant whose user vanished degrades to empty email/name (never 500)", async () => {
    grantsStore.push({
      id: "g-ghost",
      userId: "ghost-user",
      projectId: null,
      extensionId: null,
      scopes: ["use"],
      grantedByUserId: null,
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    const res = await run(GET, ev({ user: ADMIN_USER }));
    expect(res.status).toBe(200);
    const ghost = (await res.json()).grants.find((g: any) => g.id === "g-ghost");
    expect(ghost.user).toEqual({ id: "ghost-user", email: "", name: "" });
  });

  test("missing user → 401", async () => {
    const res = await run(GET, ev({ user: null }));
    expect(res.status).toBe(401);
  });
});

// ════════════════════════ POST ════════════════════════
describe("POST grants — admin", () => {
  test("happy path: creates the row, writes RBAC_GRANTED, returns the public view", async () => {
    const res = await run(
      POST,
      ev({
        method: "POST",
        user: ADMIN_USER,
        body: { userId: "member-002", projectId: "proj-2", extensionId: EXT, scopes: ["use", "configure"] },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      user: { id: "member-002", email: "target@test.local", name: "Target Member" },
      projectId: "proj-2",
      extensionId: EXT,
      scopes: ["use", "configure"],
      grantedBy: "admin-001",
    });
    expect(typeof body.updatedAt).toBe("string");
    expect(JSON.stringify(body)).not.toContain("passwordHash");
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toMatchObject({
      userId: "member-002",
      projectId: "proj-2",
      extensionId: EXT,
      grantedByUserId: "admin-001",
    });
    expect(auditCalls).toEqual([
      {
        userId: "admin-001",
        action: "ext:rbac-granted",
        target: EXT,
        metadata: {
          actor: "admin-001",
          targetUserId: "member-002",
          projectId: "proj-2",
          extensionId: EXT,
          scopes: ["use", "configure"],
        },
      },
    ]);
  });

  test("absent projectId/extensionId → the covers-all (null, null) grant; audit target undefined", async () => {
    const res = await run(
      POST,
      ev({ method: "POST", user: ADMIN_USER, body: { userId: "member-002", scopes: ["use"] } }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.projectId).toBe(null);
    expect(body.extensionId).toBe(null);
    expect(auditCalls[0].target).toBeUndefined();
  });

  test("duplicate scope names are de-duplicated before storage", async () => {
    const res = await run(
      POST,
      ev({ method: "POST", user: ADMIN_USER, body: { userId: "member-002", scopes: ["use", "use"] } }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).scopes).toEqual(["use"]);
  });

  test("upsert replaces an existing row's scope list (same id)", async () => {
    const res = await run(
      POST,
      ev({
        method: "POST",
        user: ADMIN_USER,
        body: { userId: "member-002", projectId: "proj-1", extensionId: EXT, scopes: ["configure"] },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("g-inside");
    expect(body.scopes).toEqual(["configure"]);
    expect(findByAddress("member-002", "proj-1", EXT)!.scopes).toEqual(["configure"]);
  });

  test("admin may grant `manage` (admin bypass)", async () => {
    const res = await run(
      POST,
      ev({ method: "POST", user: ADMIN_USER, body: { userId: "member-002", scopes: ["manage"] } }),
    );
    expect(res.status).toBe(200);
  });

  test("unknown user → 404, nothing written", async () => {
    const res = await run(
      POST,
      ev({ method: "POST", user: ADMIN_USER, body: { userId: "ghost", scopes: ["use"] } }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain("User");
    expect(upsertCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  test("unknown project → 404, nothing written", async () => {
    const res = await run(
      POST,
      ev({ method: "POST", user: ADMIN_USER, body: { userId: "member-002", projectId: "ghost", scopes: ["use"] } }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain("Project");
    expect(upsertCalls).toHaveLength(0);
  });

  test("unknown extension → 404, nothing written", async () => {
    const res = await run(
      POST,
      ev({ method: "POST", user: ADMIN_USER, body: { userId: "member-002", extensionId: "nope", scopes: ["use"] } }),
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain("Extension");
    expect(upsertCalls).toHaveLength(0);
  });
});

describe("POST grants — validation", () => {
  test("invalid JSON body → 400", async () => {
    const e = ev({ method: "POST", user: ADMIN_USER });
    (e as any).request = new Request("http://localhost/x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    const res = await run(POST, e);
    expect(res.status).toBe(400);
    expect(upsertCalls).toHaveLength(0);
  });

  test("missing userId → 400", async () => {
    const res = await run(POST, ev({ method: "POST", user: ADMIN_USER, body: { scopes: ["use"] } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("userId");
  });

  test("non-string projectId → 400", async () => {
    const res = await run(
      POST,
      ev({ method: "POST", user: ADMIN_USER, body: { userId: "member-002", projectId: 7, scopes: ["use"] } }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("projectId");
  });

  test("empty-string extensionId → 400 (null means covers-all, '' is a bug)", async () => {
    const res = await run(
      POST,
      ev({ method: "POST", user: ADMIN_USER, body: { userId: "member-002", extensionId: "", scopes: ["use"] } }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("extensionId");
  });

  test("scopes not an array → 400", async () => {
    const res = await run(
      POST,
      ev({ method: "POST", user: ADMIN_USER, body: { userId: "member-002", scopes: "use" } }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("array");
  });

  test("invalid scope name → 400 with the validator's message", async () => {
    const res = await run(
      POST,
      ev({ method: "POST", user: ADMIN_USER, body: { userId: "member-002", scopes: ["Bad_Scope"] } }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("invalid scope name");
    expect(upsertCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  test("empty scopes array → 400 (revoke by deleting, not by emptying)", async () => {
    const res = await run(
      POST,
      ev({ method: "POST", user: ADMIN_USER, body: { userId: "member-002", scopes: [] } }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("non-empty");
  });

  test("missing user → 401, nothing written", async () => {
    const res = await run(POST, ev({ method: "POST", user: null, body: { userId: "member-002", scopes: ["use"] } }));
    expect(res.status).toBe(401);
    expect(upsertCalls).toHaveLength(0);
  });
});

describe("POST grants — delegation (real canManageGrant)", () => {
  test("manager inside coverage grants core verbs → 200, attributed to the manager", async () => {
    const res = await run(
      POST,
      ev({
        method: "POST",
        user: MANAGER_USER,
        body: { userId: "member-002", projectId: "proj-1", extensionId: EXT, scopes: ["use", "approve-runs"] },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.grantedBy).toBe("manager-001");
    expect(auditCalls[0].userId).toBe("manager-001");
  });

  test("manager outside coverage (other project) → 403, nothing written", async () => {
    const res = await run(
      POST,
      ev({
        method: "POST",
        user: MANAGER_USER,
        body: { userId: "member-002", projectId: "proj-2", extensionId: EXT, scopes: ["use"] },
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("manage");
    expect(upsertCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  test("manager breadth-escalation to an all-projects grant → 403", async () => {
    const res = await run(
      POST,
      ev({
        method: "POST",
        user: MANAGER_USER,
        body: { userId: "member-002", projectId: null, extensionId: EXT, scopes: ["use"] },
      }),
    );
    expect(res.status).toBe(403);
    expect(upsertCalls).toHaveLength(0);
  });

  test("manager granting `manage` → 403 (admin-only, no self-propagation)", async () => {
    const res = await run(
      POST,
      ev({
        method: "POST",
        user: MANAGER_USER,
        body: { userId: "member-002", projectId: "proj-1", extensionId: EXT, scopes: ["manage"] },
      }),
    );
    expect(res.status).toBe(403);
    expect(upsertCalls).toHaveLength(0);
  });

  test("manager overwriting a row that CARRIES `manage` → 403 (union rule)", async () => {
    // Put a ["manage"] row at the exact address being written: replacing it
    // with ["use"] would silently revoke `manage`, so the delegation target
    // is the UNION of old + new scopes and canManageGrant refuses it.
    grantsStore = grantsStore.filter((g) => g.id !== "g-inside");
    grantsStore.push({
      id: "g-manage-addr",
      userId: "member-002",
      projectId: "proj-1",
      extensionId: EXT,
      scopes: ["manage"],
      grantedByUserId: "admin-001",
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    });
    const res = await run(
      POST,
      ev({
        method: "POST",
        user: MANAGER_USER,
        body: { userId: "member-002", projectId: "proj-1", extensionId: EXT, scopes: ["use"] },
      }),
    );
    expect(res.status).toBe(403);
    expect(upsertCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  test("manager granting to an ADMIN user → 403", async () => {
    const res = await run(
      POST,
      ev({
        method: "POST",
        user: MANAGER_USER,
        body: { userId: "admin-001", projectId: "proj-1", extensionId: EXT, scopes: ["use"] },
      }),
    );
    expect(res.status).toBe(403);
    expect(upsertCalls).toHaveLength(0);
  });

  test("manager granting to an unknown user → 403 (fail-closed, no existence oracle)", async () => {
    const res = await run(
      POST,
      ev({
        method: "POST",
        user: MANAGER_USER,
        body: { userId: "ghost", projectId: "proj-1", extensionId: EXT, scopes: ["use"] },
      }),
    );
    expect(res.status).toBe(403);
    expect(upsertCalls).toHaveLength(0);
  });

  test("member SELF-GRANT → 403", async () => {
    const res = await run(
      POST,
      ev({
        method: "POST",
        user: MEMBER_USER,
        body: { userId: "member-001", projectId: "proj-1", extensionId: EXT, scopes: ["use"] },
      }),
    );
    expect(res.status).toBe(403);
    expect(upsertCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  test("member granting to someone else → 403", async () => {
    const res = await run(
      POST,
      ev({ method: "POST", user: MEMBER_USER, body: { userId: "member-002", scopes: ["use"] } }),
    );
    expect(res.status).toBe(403);
    expect(upsertCalls).toHaveLength(0);
  });
});

// ════════════════════════ DELETE ════════════════════════
describe("DELETE grant", () => {
  function delEv(id: string, user: AuthUser | null) {
    return ev({ method: "DELETE", params: { id }, user });
  }

  test("admin revokes: row removed, RBAC_REVOKED carries the PRE-delete scopes", async () => {
    const res = await run(DELETE, delEv("g-inside", ADMIN_USER));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(grantsStore.some((g) => g.id === "g-inside")).toBe(false);
    expect(auditCalls).toEqual([
      {
        userId: "admin-001",
        action: "ext:rbac-revoked",
        target: EXT,
        metadata: {
          actor: "admin-001",
          targetUserId: "member-002",
          projectId: "proj-1",
          extensionId: EXT,
          scopes: ["use"],
        },
      },
    ]);
  });

  test("unknown grant id → 404, nothing deleted", async () => {
    const res = await run(DELETE, delEv("g-nope", ADMIN_USER));
    expect(res.status).toBe(404);
    expect(deleteCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  test("manager revokes inside coverage → 200", async () => {
    const res = await run(DELETE, delEv("g-inside", MANAGER_USER));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(auditCalls[0].userId).toBe("manager-001");
  });

  test("manager revokes outside coverage → 403", async () => {
    const res = await run(DELETE, delEv("g-outside", MANAGER_USER));
    expect(res.status).toBe(403);
    expect(deleteCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });

  test("manager revoking a `manage` row → 403 (revoking manage is admin-only)", async () => {
    const res = await run(DELETE, delEv("g-manage-target", MANAGER_USER));
    expect(res.status).toBe(403);
    expect(deleteCalls).toHaveLength(0);
  });

  test("manager revoking an admin's row → 403", async () => {
    const res = await run(DELETE, delEv("g-admin-row", MANAGER_USER));
    expect(res.status).toBe(403);
    expect(deleteCalls).toHaveLength(0);
  });

  test("member revoking their OWN row → 403 (no self-management)", async () => {
    const res = await run(DELETE, delEv("g-own", MEMBER_USER));
    expect(res.status).toBe(403);
    expect(deleteCalls).toHaveLength(0);
  });

  test("lost concurrent-revoke race → {deleted:false}, NO audit row", async () => {
    deleteResult = false;
    const res = await run(DELETE, delEv("g-inside", ADMIN_USER));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: false });
    expect(auditCalls).toHaveLength(0);
  });

  test("missing user → 401", async () => {
    const res = await run(DELETE, delEv("g-inside", null));
    expect(res.status).toBe(401);
    expect(deleteCalls).toHaveLength(0);
  });
});
