import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb, getTestPglite } from "./helpers/test-pglite";

mockDbConnection();

import {
  CORE_RBAC_SCOPES,
  InvalidRbacScopeError,
  isValidCustomRbacScopeName,
  isValidRbacScopeName,
  validateRbacScopes,
  getGrant,
  listGrants,
  listGrantsForUser,
  upsertGrant,
  deleteGrant,
} from "../db/queries/extension-rbac";
import type { RbacGrantInput } from "../db/queries/extension-rbac";
import { extensionRbacGrants, extensions, projects, users } from "../db/schema";
import { eq, sql } from "drizzle-orm";

const EXT_A = "rbac-ext-a";
const EXT_B = "rbac-ext-b";
const USER_ID = "11111111-1111-1111-1111-111111111111";
const GRANTOR_ID = "22222222-2222-2222-2222-222222222222";
let projectA: string;
let projectB: string;

// Seed the FK parent rows: two `extensions` rows (the slug FK target), two
// `projects`, a grantee user, and a grantor user (for granted_by attribution).
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
  const projRows = await getTestDb()
    .insert(projects)
    .values([
      { name: "RBAC Project A", path: "/tmp/rbac-a" },
      { name: "RBAC Project B", path: "/tmp/rbac-b" },
    ])
    .returning({ id: projects.id });
  projectA = projRows[0]!.id;
  projectB = projRows[1]!.id;
  await db.insert(users).values([
    { id: USER_ID, email: "rbac-grantee@example.com", passwordHash: "x", name: "Grantee" },
    { id: GRANTOR_ID, email: "rbac-grantor@example.com", passwordHash: "x", name: "Grantor", role: "admin" },
  ]);
}

function grantInput(overrides: Partial<RbacGrantInput> = {}): RbacGrantInput {
  return {
    userId: USER_ID,
    projectId: null,
    extensionId: null,
    scopes: ["use"],
    grantedByUserId: GRANTOR_ID,
    ...overrides,
  };
}

beforeEach(async () => {
  await setupTestDb();
  await seed();
}, 30_000);

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

describe("scope-name validation", () => {
  test("core verbs and grammar-valid custom names are storable", () => {
    for (const core of CORE_RBAC_SCOPES) expect(isValidRbacScopeName(core)).toBe(true);
    for (const custom of ["write-tickets", "manage2", "a", "x9-y"]) {
      expect(isValidRbacScopeName(custom)).toBe(true);
    }
  });

  test("invalid characters / shapes are rejected", () => {
    for (const bad of ["Use", "USE", "2use", "-x", "foo_bar", "foo bar", "", "über"]) {
      expect(isValidRbacScopeName(bad)).toBe(false);
    }
  });

  test("custom-declaration validator additionally rejects core-verb collisions", () => {
    for (const core of CORE_RBAC_SCOPES) expect(isValidCustomRbacScopeName(core)).toBe(false);
    expect(isValidCustomRbacScopeName("write-tickets")).toBe(true);
    expect(isValidCustomRbacScopeName("manage2")).toBe(true); // longer name ≠ collision
    expect(isValidCustomRbacScopeName("Manage")).toBe(false); // grammar still applies
  });

  test("validateRbacScopes de-duplicates and rejects empty / malformed lists", () => {
    expect(validateRbacScopes(["use", "use", "configure"])).toEqual(["use", "configure"]);
    expect(() => validateRbacScopes([])).toThrow(InvalidRbacScopeError);
    expect(() => validateRbacScopes(["use", "Nope"])).toThrow(InvalidRbacScopeError);
    expect(() => validateRbacScopes(["use", 42] as unknown as string[])).toThrow(InvalidRbacScopeError);
  });
});

describe("getGrant", () => {
  test("returns undefined on a miss", async () => {
    expect(await getGrant(USER_ID, null, null)).toBeUndefined();
  });

  test("addresses null scope columns via IS NULL and returns the row", async () => {
    await upsertGrant(grantInput({ scopes: ["use", "configure"] }));
    const row = await getGrant(USER_ID, null, null);
    expect(row).toBeDefined();
    expect(row!.scopes).toEqual(["use", "configure"]);
    expect(row!.projectId).toBeNull();
    expect(row!.extensionId).toBeNull();
    expect(row!.grantedByUserId).toBe(GRANTOR_ID);
  });

  test("distinguishes all four (project, extension) address shapes for one user", async () => {
    await upsertGrant(grantInput({ scopes: ["use"] }));
    await upsertGrant(grantInput({ projectId: projectA, scopes: ["configure"] }));
    await upsertGrant(grantInput({ extensionId: EXT_A, scopes: ["secrets"] }));
    await upsertGrant(grantInput({ projectId: projectA, extensionId: EXT_A, scopes: ["approve-runs"] }));

    expect((await getGrant(USER_ID, null, null))!.scopes).toEqual(["use"]);
    expect((await getGrant(USER_ID, projectA, null))!.scopes).toEqual(["configure"]);
    expect((await getGrant(USER_ID, null, EXT_A))!.scopes).toEqual(["secrets"]);
    expect((await getGrant(USER_ID, projectA, EXT_A))!.scopes).toEqual(["approve-runs"]);
    // All four coexist — the COALESCE index treats them as distinct tuples.
    expect(await listGrantsForUser(USER_ID)).toHaveLength(4);
  });
});

describe("upsertGrant", () => {
  test("insert path: creates a fresh row with timestamps + grantor attribution", async () => {
    const row = await upsertGrant(grantInput({ projectId: projectA, extensionId: EXT_A }));
    expect(row.id).toBeDefined();
    expect(row.userId).toBe(USER_ID);
    expect(row.scopes).toEqual(["use"]);
    expect(row.grantedByUserId).toBe(GRANTOR_ID);
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.updatedAt).toBeInstanceOf(Date);
  });

  test("update path: replaces scopes + grantor, stamps updatedAt, keeps the id", async () => {
    const first = await upsertGrant(grantInput({ scopes: ["use"] }));
    const second = await upsertGrant(grantInput({ scopes: ["configure", "approve-runs"], grantedByUserId: null }));
    expect(second.id).toBe(first.id);
    expect(second.scopes).toEqual(["configure", "approve-runs"]);
    expect(second.grantedByUserId).toBeNull();
    expect(second.updatedAt.getTime()).toBeGreaterThanOrEqual(first.updatedAt.getTime());
    // Still exactly one row at the address — COALESCE uniqueness held.
    expect(await listGrantsForUser(USER_ID)).toHaveLength(1);
  });

  test("validates scope names BEFORE any write — invalid list leaves no row", async () => {
    await expect(upsertGrant(grantInput({ scopes: ["use", "NOT-VALID"] }))).rejects.toThrow(InvalidRbacScopeError);
    await expect(upsertGrant(grantInput({ scopes: [] }))).rejects.toThrow(InvalidRbacScopeError);
    expect(await listGrantsForUser(USER_ID)).toHaveLength(0);
  });

  test("stores the de-duplicated scope list", async () => {
    const row = await upsertGrant(grantInput({ scopes: ["use", "use", "write-tickets"] }));
    expect(row.scopes).toEqual(["use", "write-tickets"]);
  });

  test("the DB index itself rejects a duplicate (user, NULL, NULL) row written past the query layer", async () => {
    await upsertGrant(grantInput());
    // Bypass upsertGrant entirely: a raw second INSERT at the same all-NULL
    // address must hit the COALESCE-unique index (a plain UNIQUE would let
    // every NULL collide-free and accept this).
    await expect(
      getTestPglite().query(
        "INSERT INTO extension_rbac_grants (id, user_id, project_id, extension_id, scopes) VALUES ($1, $2, NULL, NULL, $3)",
        ["dup-row-id", USER_ID, JSON.stringify(["configure"])],
      ),
    ).rejects.toThrow(/idx_extension_rbac_grants_scope|duplicate key/);
  });

  test("concurrent first-writes: the unique-index loser retries as an update — one row, no 500", async () => {
    // Both calls pass the select (no row yet) before either INSERT runs:
    // Promise.all invokes both synchronously, so both selects enter PGlite's
    // FIFO queue ahead of both inserts. The second INSERT then hits the
    // COALESCE-unique index; the retry path re-selects the winner's row and
    // converts the write into the replace update. All-NULL address on
    // purpose — that is exactly the address a plain onConflict target can't
    // hit, so the raced INSERT truly relies on the retry.
    await Promise.all([
      upsertGrant(grantInput({ scopes: ["use"] })),
      upsertGrant(grantInput({ scopes: ["configure"] })),
    ]);

    // Exactly ONE row survived the race at the address.
    const all = await getTestDb().select().from(extensionRbacGrants);
    expect(all).toHaveLength(1);
    // Queue order pins the outcome: the first inserts, the second conflicts
    // → re-select → replace. The second writer's scopes land last.
    expect(all[0]!.scopes).toEqual(["configure"]);
  });

  test("a non-race insert failure is rethrown unchanged (re-select finds no winner)", async () => {
    // FK violation (grantee user missing), NOT the unique-violation race:
    // the retry's re-select finds nothing, so the original error surfaces.
    const orphan = grantInput({ userId: "99999999-9999-9999-9999-999999999999" });
    await expect(upsertGrant(orphan)).rejects.toThrow();
    expect(await getGrant(orphan.userId, null, null)).toBeUndefined();
  });
});

describe("deleteGrant", () => {
  test("hit: returns true and removes the row", async () => {
    const row = await upsertGrant(grantInput());
    expect(await deleteGrant(row.id)).toBe(true);
    expect(await getGrant(USER_ID, null, null)).toBeUndefined();
  });

  test("miss: returns false", async () => {
    expect(await deleteGrant("no-such-grant-id")).toBe(false);
  });
});

describe("listGrants / listGrantsForUser", () => {
  async function seedGrantMatrix(): Promise<void> {
    await upsertGrant(grantInput({ scopes: ["use"] }));
    await upsertGrant(grantInput({ projectId: projectA, scopes: ["configure"] }));
    await upsertGrant(grantInput({ projectId: projectA, extensionId: EXT_A, scopes: ["secrets"] }));
    await upsertGrant(grantInput({ userId: GRANTOR_ID, extensionId: EXT_B, scopes: ["approve-runs"] }));
  }

  test("no filter returns every row", async () => {
    await seedGrantMatrix();
    expect(await listGrants()).toHaveLength(4);
  });

  test("filters by user / project (null vs value) / extension, alone and combined", async () => {
    await seedGrantMatrix();
    expect(await listGrants({ userId: USER_ID })).toHaveLength(3);
    // Single-condition path: project only.
    const projA = await listGrants({ projectId: projectA });
    expect(projA).toHaveLength(2);
    // null = only the all-projects rows, NOT "any project".
    const globalProject = await listGrants({ projectId: null });
    expect(globalProject).toHaveLength(2);
    expect(globalProject.every((g) => g.projectId === null)).toBe(true);
    expect(await listGrants({ extensionId: EXT_B })).toHaveLength(1);
    expect(await listGrants({ extensionId: null })).toHaveLength(2);
    // Combined conditions narrow conjunctively.
    const combined = await listGrants({ userId: USER_ID, projectId: projectA, extensionId: EXT_A });
    expect(combined).toHaveLength(1);
    expect(combined[0]!.scopes).toEqual(["secrets"]);
    expect(await listGrants({ userId: GRANTOR_ID, projectId: projectA })).toHaveLength(0);
    expect(await listGrants({ projectId: projectB })).toHaveLength(0);
  });

  test("listGrantsForUser returns only that user's rows", async () => {
    await seedGrantMatrix();
    const mine = await listGrantsForUser(USER_ID);
    expect(mine).toHaveLength(3);
    expect(mine.every((g) => g.userId === USER_ID)).toBe(true);
    const theirs = await listGrantsForUser(GRANTOR_ID);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]!.extensionId).toBe(EXT_B);
  });
});

describe("FK behavior", () => {
  test("deleting the grantee user cascades their grants away", async () => {
    await upsertGrant(grantInput());
    await upsertGrant(grantInput({ projectId: projectA }));
    await getTestDb().delete(users).where(eq(users.id, USER_ID));
    expect(await listGrantsForUser(USER_ID)).toHaveLength(0);
  });

  test("deleting a project cascades its scoped grants; all-projects rows survive", async () => {
    await upsertGrant(grantInput({ scopes: ["use"] }));
    await upsertGrant(grantInput({ projectId: projectA, scopes: ["configure"] }));
    await getTestDb().delete(projects).where(eq(projects.id, projectA));
    const remaining = await listGrantsForUser(USER_ID);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.projectId).toBeNull();
  });

  test("deleting an extension cascades its scoped grants; all-extensions rows survive", async () => {
    await upsertGrant(grantInput({ scopes: ["use"] }));
    await upsertGrant(grantInput({ extensionId: EXT_A, scopes: ["secrets"] }));
    await getTestDb().delete(extensions).where(eq(extensions.name, EXT_A));
    const remaining = await listGrantsForUser(USER_ID);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.extensionId).toBeNull();
  });

  test("deleting the GRANTOR only un-attributes (SET NULL) — the grant survives", async () => {
    await upsertGrant(grantInput());
    await getTestDb().delete(users).where(eq(users.id, GRANTOR_ID));
    const row = await getGrant(USER_ID, null, null);
    expect(row).toBeDefined();
    expect(row!.grantedByUserId).toBeNull();
    expect(row!.scopes).toEqual(["use"]);
  });
});
