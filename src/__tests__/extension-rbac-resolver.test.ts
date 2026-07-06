import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "./helpers/test-pglite";

mockDbConnection();

import {
  RBAC_ALL_SCOPES,
  resolveEffectiveScopes,
  hasExtensionScope,
  canManageGrant,
} from "../auth/extension-rbac";
import type { RbacUser } from "../auth/extension-rbac";
import { upsertGrant } from "../db/queries/extension-rbac";
import { extensions, projects, users } from "../db/schema";
import { sql } from "drizzle-orm";

const EXT_A = "rbac-res-ext-a";
const EXT_B = "rbac-res-ext-b";
let projectA: string;
let projectB: string;

// ── Principals ─────────────────────────────────────────────────────────
// The admin principal used by the no-DB describe below — its id is NEVER
// seeded, which is part of the proof that the admin path does no DB work.
const ADMIN: RbacUser = { id: "unseeded-admin-id", role: "admin" };

let memberNoGrants: RbacUser; // deny-by-default subject
let memberNN: RbacUser; //     grant (null, null)      {use}
let memberPN: RbacUser; //     grant (A,    null)      {use}
let memberNE: RbacUser; //     grant (null, EXT_A)     {use}
let memberPE: RbacUser; //     grant (A,    EXT_A)     {use}
let memberUnion: RbacUser; //  grants (A,null)={use} + (null,EXT_A)={configure,approve-runs}
let managerPE: RbacUser; //    manage at (A, EXT_A)
let managerP: RbacUser; //     manage at (A, null)
let managerE: RbacUser; //     manage at (null, EXT_A)
let managerAll: RbacUser; //   manage at (null, null)
let adminGrantee: RbacUser; // role=admin IN THE DB — delegation target only

async function createMember(email: string, role: "admin" | "member" = "member"): Promise<RbacUser> {
  const rows = await getTestDb()
    .insert(users)
    .values({ email, passwordHash: "x", name: email, role })
    .returning({ id: users.id, role: users.role });
  return { id: rows[0]!.id, role: rows[0]!.role };
}

async function seed(): Promise<void> {
  const db = getTestDb();
  for (const name of [EXT_A, EXT_B]) {
    await db.insert(extensions).values({
      name,
      version: "1.0.0",
      source: "test:fixture",
      manifest: sql`${JSON.stringify({
        schemaVersion: 2,
        name,
        version: "1.0.0",
        description: "",
        author: { name: "test" },
        kind: "subprocess",
        entrypoint: { command: ["true"] },
      })}::jsonb`,
    });
  }
  const projRows = await db
    .insert(projects)
    .values([
      { name: "Resolver Project A", path: "/tmp/rbac-res-a" },
      { name: "Resolver Project B", path: "/tmp/rbac-res-b" },
    ])
    .returning({ id: projects.id });
  projectA = projRows[0]!.id;
  projectB = projRows[1]!.id;

  memberNoGrants = await createMember("none@rbac.test");
  memberNN = await createMember("nn@rbac.test");
  memberPN = await createMember("pn@rbac.test");
  memberNE = await createMember("ne@rbac.test");
  memberPE = await createMember("pe@rbac.test");
  memberUnion = await createMember("union@rbac.test");
  managerPE = await createMember("mgr-pe@rbac.test");
  managerP = await createMember("mgr-p@rbac.test");
  managerE = await createMember("mgr-e@rbac.test");
  managerAll = await createMember("mgr-all@rbac.test");
  adminGrantee = await createMember("admin-grantee@rbac.test", "admin");

  const grant = (
    userId: string,
    projectId: string | null,
    extensionId: string | null,
    scopes: string[],
  ) => upsertGrant({ userId, projectId, extensionId, scopes, grantedByUserId: adminGrantee.id });

  await grant(memberNN.id, null, null, ["use"]);
  await grant(memberPN.id, projectA, null, ["use"]);
  await grant(memberNE.id, null, EXT_A, ["use"]);
  await grant(memberPE.id, projectA, EXT_A, ["use"]);
  await grant(memberUnion.id, projectA, null, ["use"]);
  await grant(memberUnion.id, null, EXT_A, ["configure", "approve-runs"]);
  await grant(managerPE.id, projectA, EXT_A, ["manage"]);
  await grant(managerP.id, projectA, null, ["manage", "use"]);
  await grant(managerE.id, null, EXT_A, ["manage"]);
  await grant(managerAll.id, null, null, ["manage"]);
}

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

// ── Admin bypass — MUST run before any setupTestDb() ────────────────────
// The mocked getDb()/getTestDb() throw until setupTestDb() runs, so these
// tests structurally PROVE the admin path never touches the DB: any DB hit
// would reject with "Test DB not initialized".
describe("admin bypass (no DB initialized — any DB hit would throw)", () => {
  test("hasExtensionScope is true for any scope at any coordinates", async () => {
    expect(await hasExtensionScope(ADMIN, { projectId: null, extensionId: null, scope: "use" })).toBe(true);
    expect(await hasExtensionScope(ADMIN, { projectId: "any-project", extensionId: "any-ext", scope: "manage" })).toBe(
      true,
    );
    expect(await hasExtensionScope(ADMIN, { projectId: null, extensionId: "x", scope: "write-tickets" })).toBe(true);
  });

  test("resolveEffectiveScopes returns the ALL sentinel (identity + has()-always-true)", async () => {
    const scopes = await resolveEffectiveScopes(ADMIN, "p", "e");
    expect(scopes).toBe(RBAC_ALL_SCOPES);
    expect(scopes.has("use")).toBe(true);
    expect(scopes.has("anything-at-all")).toBe(true);
    // The sentinel is has()-only — it deliberately enumerates as empty
    // (custom scopes are open-ended, so "all" is not listable).
    expect(scopes.size).toBe(0);
    expect([...scopes]).toEqual([]);
  });

  test("canManageGrant: admins may manage anything — even manage-bearing grants for unknown users", async () => {
    expect(
      await canManageGrant(ADMIN, {
        userId: "ghost-user",
        projectId: null,
        extensionId: null,
        scopes: ["manage", "use"],
      }),
    ).toBe(true);
  });
});

describe("resolveEffectiveScopes / hasExtensionScope (real PGlite)", () => {
  beforeAll(async () => {
    await setupTestDb();
    await seed();
  }, 30_000);

  test("matching matrix: 4 grant shapes × 4 query shapes resolve exactly per NULL-covers-all", async () => {
    // Rows: grant shape. Columns: query (projectId, extensionId). A query
    // NULL coordinate is only covered by a grant NULL on that axis — a
    // narrower grant never covers a broader context.
    const queries: Array<[string | null, string | null]> = [
      [null, null],
      [projectA, null],
      [null, EXT_A],
      [projectA, EXT_A],
    ];
    const matrix: Array<[RbacUser, boolean[]]> = [
      [memberNN, [true, true, true, true]], //  (null, null) covers everything
      [memberPN, [false, true, false, true]], // (A, null) needs project A
      [memberNE, [false, false, true, true]], // (null, EXT_A) needs ext A
      [memberPE, [false, false, false, true]], // (A, EXT_A) needs both
    ];
    for (const [user, expected] of matrix) {
      for (let i = 0; i < queries.length; i++) {
        const [projectId, extensionId] = queries[i]!;
        const scopes = await resolveEffectiveScopes(user, projectId, extensionId);
        expect(scopes.has("use")).toBe(expected[i]!);
        // Granted-or-not, the resolved set never contains scopes nobody granted.
        expect(scopes.has("secrets")).toBe(false);
      }
    }
  });

  test("different coordinates never match: project B / extension B queries miss the specific grants", async () => {
    expect((await resolveEffectiveScopes(memberPN, projectB, null)).size).toBe(0);
    expect((await resolveEffectiveScopes(memberNE, null, EXT_B)).size).toBe(0);
    expect((await resolveEffectiveScopes(memberPE, projectB, EXT_A)).size).toBe(0);
    expect((await resolveEffectiveScopes(memberPE, projectA, EXT_B)).size).toBe(0);
    // …while the all-covering grant still matches foreign coordinates.
    expect((await resolveEffectiveScopes(memberNN, projectB, EXT_B)).has("use")).toBe(true);
  });

  test("union across multiple matching grants", async () => {
    // (A, EXT_A): BOTH rows cover → full union.
    const both = await resolveEffectiveScopes(memberUnion, projectA, EXT_A);
    expect([...both].sort()).toEqual(["approve-runs", "configure", "use"]);
    // (A, EXT_B): only the (A, null) row covers.
    const projOnly = await resolveEffectiveScopes(memberUnion, projectA, EXT_B);
    expect([...projOnly]).toEqual(["use"]);
    // (B, EXT_A): only the (null, EXT_A) row covers.
    const extOnly = await resolveEffectiveScopes(memberUnion, projectB, EXT_A);
    expect([...extOnly].sort()).toEqual(["approve-runs", "configure"]);
    // (null, null): NEITHER row covers the global context — empty.
    expect((await resolveEffectiveScopes(memberUnion, null, null)).size).toBe(0);
  });

  test("deny-by-default: a member with zero grants resolves empty everywhere", async () => {
    for (const [p, e] of [
      [null, null],
      [projectA, null],
      [null, EXT_A],
      [projectA, EXT_A],
    ] as Array<[string | null, string | null]>) {
      const scopes = await resolveEffectiveScopes(memberNoGrants, p, e);
      expect(scopes.size).toBe(0);
      expect(scopes).not.toBe(RBAC_ALL_SCOPES);
    }
    expect(await hasExtensionScope(memberNoGrants, { projectId: projectA, extensionId: EXT_A, scope: "use" })).toBe(
      false,
    );
  });

  test("a member's resolved set is a real set, not the admin sentinel", async () => {
    const scopes = await resolveEffectiveScopes(memberNN, projectA, EXT_A);
    expect(scopes).not.toBe(RBAC_ALL_SCOPES);
    expect(scopes.has("use")).toBe(true);
    expect(scopes.has("totally-made-up")).toBe(false);
  });

  test("unknown / un-granted scope checks are false", async () => {
    expect(await hasExtensionScope(memberNN, { projectId: null, extensionId: null, scope: "approve-runs" })).toBe(
      false,
    );
    expect(await hasExtensionScope(memberNN, { projectId: null, extensionId: null, scope: "made-up-scope" })).toBe(
      false,
    );
    expect(await hasExtensionScope(memberNN, { projectId: null, extensionId: null, scope: "use" })).toBe(true);
  });

  test("scope names are case-sensitive", async () => {
    for (const variant of ["Use", "USE", "uSe"]) {
      expect(await hasExtensionScope(memberNN, { projectId: null, extensionId: null, scope: variant })).toBe(false);
    }
  });
});

describe("canManageGrant delegation matrix (real PGlite)", () => {
  // Seeding happened in the previous describe's beforeAll (bun runs
  // describes in declaration order); principals + grants are read-only here.
  const target = (userId: string, projectId: string | null, extensionId: string | null, scopes: string[]) => ({
    userId,
    projectId,
    extensionId,
    scopes,
  });

  test("admin: allowed for everything — manage-bearing targets and admin-owned targets included", async () => {
    expect(await canManageGrant(ADMIN, target(memberNN.id, projectA, EXT_A, ["use"]))).toBe(true);
    expect(await canManageGrant(ADMIN, target(memberNN.id, null, null, ["manage"]))).toBe(true);
    expect(await canManageGrant(ADMIN, target(adminGrantee.id, null, null, ["use", "manage"]))).toBe(true);
  });

  test("manager with (project, extension) manage may grant/revoke core + custom verbs within coverage", async () => {
    expect(await canManageGrant(managerPE, target(memberNN.id, projectA, EXT_A, ["use"]))).toBe(true);
    expect(await canManageGrant(managerPE, target(memberNN.id, projectA, EXT_A, ["configure", "approve-runs"]))).toBe(
      true,
    );
    expect(await canManageGrant(managerPE, target(memberNN.id, projectA, EXT_A, ["secrets", "write-tickets"]))).toBe(
      true,
    );
  });

  test("managers may NEVER grant `manage` — nor touch (revoke) a manage-bearing grant", async () => {
    expect(await canManageGrant(managerPE, target(memberNN.id, projectA, EXT_A, ["manage"]))).toBe(false);
    expect(await canManageGrant(managerPE, target(memberNN.id, projectA, EXT_A, ["use", "manage"]))).toBe(false);
    // Even the instance-wide manager cannot revoke another manager's grant.
    expect(await canManageGrant(managerAll, target(managerPE.id, projectA, EXT_A, ["manage"]))).toBe(false);
  });

  test("project-scoped manager cannot create/touch a NULL-project (broader) grant", async () => {
    expect(await canManageGrant(managerP, target(memberNN.id, null, EXT_A, ["use"]))).toBe(false);
    expect(await canManageGrant(managerP, target(memberNN.id, null, null, ["use"]))).toBe(false);
    // …but is free anywhere inside the project, any extension.
    expect(await canManageGrant(managerP, target(memberNN.id, projectA, EXT_A, ["use"]))).toBe(true);
    expect(await canManageGrant(managerP, target(memberNN.id, projectA, EXT_B, ["use"]))).toBe(true);
    expect(await canManageGrant(managerP, target(memberNN.id, projectA, null, ["use"]))).toBe(true);
    // Other projects are out of coverage entirely.
    expect(await canManageGrant(managerP, target(memberNN.id, projectB, EXT_A, ["use"]))).toBe(false);
  });

  test("extension-scoped manager cannot touch other extensions (nor the all-extensions shape)", async () => {
    expect(await canManageGrant(managerE, target(memberNN.id, projectA, EXT_B, ["use"]))).toBe(false);
    expect(await canManageGrant(managerE, target(memberNN.id, projectA, null, ["use"]))).toBe(false);
    // Their extension, in any project — including the all-projects shape.
    expect(await canManageGrant(managerE, target(memberNN.id, projectA, EXT_A, ["use"]))).toBe(true);
    expect(await canManageGrant(managerE, target(memberNN.id, projectB, EXT_A, ["use"]))).toBe(true);
    expect(await canManageGrant(managerE, target(memberNN.id, null, EXT_A, ["use"]))).toBe(true);
  });

  test("instance-wide manager covers every non-manage, non-admin target", async () => {
    expect(await canManageGrant(managerAll, target(memberNN.id, null, null, ["use"]))).toBe(true);
    expect(await canManageGrant(managerAll, target(memberNN.id, projectB, EXT_B, ["configure"]))).toBe(true);
  });

  test("managers cannot touch grants belonging to admin users; unknown grantees fail closed", async () => {
    expect(await canManageGrant(managerAll, target(adminGrantee.id, projectA, EXT_A, ["use"]))).toBe(false);
    expect(await canManageGrant(managerAll, target("no-such-user-id", projectA, EXT_A, ["use"]))).toBe(false);
  });

  test("non-manager members are denied everything — including self-grants", async () => {
    // Self-grant attempt: a member trying to hand themselves `use`.
    expect(
      await canManageGrant(memberNoGrants, target(memberNoGrants.id, projectA, EXT_A, ["use"])),
    ).toBe(false);
    // Holding non-manage scopes (memberNN has `use` everywhere) grants no
    // delegation power.
    expect(await canManageGrant(memberNN, target(memberNoGrants.id, projectA, EXT_A, ["use"]))).toBe(false);
    expect(await canManageGrant(memberNN, target(memberNN.id, null, null, ["use", "configure"]))).toBe(false);
  });

  test("manage held elsewhere does not cover foreign coordinates", async () => {
    // managerPE's manage lives at (A, EXT_A) — (B, EXT_A) and (A, EXT_B)
    // are out of coverage even though the scope name matches.
    expect(await canManageGrant(managerPE, target(memberNN.id, projectB, EXT_A, ["use"]))).toBe(false);
    expect(await canManageGrant(managerPE, target(memberNN.id, projectA, EXT_B, ["use"]))).toBe(false);
  });
});
