/**
 * Real-PGlite coverage for the creator-modify ownership queries:
 *   - createExtension persists `creator_user_id`; `modifiable`
 *     defaults FALSE.
 *   - getUserModifiableExtension is the opaque owner+flag+!bundled
 *     gate (by id AND by name); every disqualifier → null.
 *   - setExtensionModifiable flips the admin gate.
 *
 * Mirrors the test-pglite harness used by
 * `bundled-grant-reconcile-drafts.test.ts`.
 */

import { test, expect, describe, beforeAll, afterAll, afterEach, mock } from "bun:test";

mock.module("../db/connection", () => ({
  getDb: () => {
    const pg = getTestPglite();
    if (!pg) throw new Error("Test DB not initialized — call setupTestDb() first");
    const { drizzle } = require("drizzle-orm/pglite");
    const schema = require("../db/schema");
    return drizzle(pg, { schema });
  },
  getPglite: () => getTestPglite(),
  getDbPath: () => ":memory:",
  initDb: async () => {},
  closeDb: async () => {},
}));

import { setupTestDb, closeTestDb, getTestPglite } from "./helpers/test-pglite";

const OWNER = "user-owns";
const STRANGER = "user-stranger";

const baseManifest = {
  schemaVersion: 2 as const,
  name: "",
  version: "1.0.0",
  description: "x",
  author: { name: "t" },
  entrypoint: "index.ts",
  tools: [],
};

async function seedExt(over: Record<string, unknown>) {
  const { createExtension } = await import("../db/queries/extensions");
  const name = over.name as string;
  return createExtension({
    name,
    version: "1.0.0",
    description: "x",
    manifest: { ...baseManifest, name } as never,
    source: `local:/tmp/${name}`,
    installPath: `/tmp/${name}`,
    enabled: true,
    grantedPermissions: { grantedAt: {} } as never,
    checksumVerified: true,
    consecutiveFailures: 0,
    ...over,
  } as never);
}

describe("extension creator-modify queries", () => {
  beforeAll(async () => {
    await setupTestDb();
    const { getDb } = await import("../db/connection");
    const { users } = await import("../db/schema");
    for (const id of [OWNER, STRANGER]) {
      await getDb()
        .insert(users)
        .values({ id, email: `${id}@t.local`, passwordHash: "x", name: id } as never)
        .onConflictDoNothing();
    }
  });
  afterAll(async () => {
    await closeTestDb();
  });
  afterEach(async () => {
    const { getDb } = await import("../db/connection");
    const { extensions } = await import("../db/schema");
    await getDb().delete(extensions);
  });

  test("createExtension persists creatorUserId; modifiable defaults false", async () => {
    const ext = await seedExt({ name: "e-default", creatorUserId: OWNER });
    expect(ext.creatorUserId).toBe(OWNER);
    expect(ext.modifiable).toBe(false);
  });

  test("getUserModifiableExtension: owner + modifiable + !bundled → row (by id AND name)", async () => {
    const { getUserModifiableExtension } = await import("../db/queries/extensions");
    const ext = await seedExt({
      name: "e-ok",
      creatorUserId: OWNER,
      modifiable: true,
    });
    expect((await getUserModifiableExtension(ext.id, OWNER))?.id).toBe(ext.id);
    expect((await getUserModifiableExtension("e-ok", OWNER))?.id).toBe(ext.id);
  });

  test("opaque null: wrong user / flag-off / bundled / missing", async () => {
    const { getUserModifiableExtension } = await import("../db/queries/extensions");
    const ok = await seedExt({ name: "e1", creatorUserId: OWNER, modifiable: true });
    await seedExt({ name: "e2", creatorUserId: OWNER, modifiable: false });
    await seedExt({
      name: "e3",
      creatorUserId: OWNER,
      modifiable: true,
      isBundled: true,
    });
    await seedExt({ name: "e4", creatorUserId: null }); // no creator

    expect(await getUserModifiableExtension(ok.id, STRANGER)).toBeNull(); // not owner
    expect(await getUserModifiableExtension("e2", OWNER)).toBeNull(); // flag off
    expect(await getUserModifiableExtension("e3", OWNER)).toBeNull(); // bundled
    expect(await getUserModifiableExtension("e4", OWNER)).toBeNull(); // no creator
    expect(await getUserModifiableExtension("nope", OWNER)).toBeNull(); // missing
  });

  // A manifest name only has to match /^[a-z0-9][a-z0-9-_.]{0,63}$/, which a
  // `crypto.randomUUID()` string satisfies. So `or(id, name)` can match TWO
  // owned+modifiable rows, and `rows[0]` would pick whichever the planner
  // returned first. That matters more here than on the read-only detail route:
  // this query feeds `modify_extension`, so the wrong row is reopened and
  // re-installed OVER — a silent overwrite of a different extension.
  test("getUserModifiableExtension: the id wins when a rival row is NAMED like it", async () => {
    const { getUserModifiableExtension } = await import("../db/queries/extensions");

    // Pin the target's id up front so the IMPOSTOR can be inserted FIRST.
    // Order matters for this assertion to mean anything: an unordered
    // `or(id, name)` returns both rows, and `rows[0]` is whatever the scan
    // yields first. With the target inserted first the buggy code picks it by
    // luck and the test passes either way — proving nothing. Inserting the
    // impostor first makes `rows[0]` the WRONG row, so only a real id-wins
    // tiebreak can satisfy this.
    const targetId = "11111111-2222-4333-8444-555555555555";

    const impostor = await seedExt({
      name: targetId, // a name that is exactly the target's id
      creatorUserId: OWNER,
      modifiable: true,
    });
    const target = await seedExt({
      id: targetId,
      name: "e-target",
      creatorUserId: OWNER,
      modifiable: true,
    });

    // One reference, two matching owned+modifiable rows.
    const got = await getUserModifiableExtension(targetId, OWNER);
    expect(got?.id).toBe(target.id);
    expect(got?.id).not.toBe(impostor.id);

    // The impostor is still reachable by its own id — this is a tiebreak,
    // not a blanket preference for one row.
    expect((await getUserModifiableExtension(impostor.id, OWNER))?.id).toBe(impostor.id);
  });

  test("setExtensionModifiable flips and persists the gate", async () => {
    const { getExtension, setExtensionModifiable } = await import("../db/queries/extensions");
    const ext = await seedExt({ name: "e-flip", creatorUserId: OWNER });
    expect(ext.modifiable).toBe(false);

    const updated = await setExtensionModifiable(ext.id, true);
    expect(updated?.modifiable).toBe(true);
    expect((await getExtension(ext.id))?.modifiable).toBe(true);

    await setExtensionModifiable(ext.id, false);
    expect((await getExtension(ext.id))?.modifiable).toBe(false);
  });
});
