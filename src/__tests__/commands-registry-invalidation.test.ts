import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const { createUserCommand, updateUserCommand, deleteUserCommand } = await import(
  "../db/queries/user-commands"
);
const { createUser } = await import("../db/queries/users");
const { createCommandRegistry } = await import("../runtime/commands/registry");

/**
 * Integration coverage for the API ↔ DB ↔ registry path. The API
 * handler is unit-tested elsewhere with a fully mocked registry; this
 * test wires the REAL registry against the REAL DB and confirms that:
 *
 *   1. `invalidate({ userId, projectId })` drops only that key, so a
 *      mismatched projectId leaves a stale cache entry.
 *   2. `invalidateUser(userId)` drops every cache entry for the user
 *      regardless of projectId — which is the contract the API
 *      mutating handlers actually need, since the popover keys cache
 *      by the *active chat's* projectId rather than "global". A bug
 *      where handlers call `invalidate({...projectId:"global"})` would
 *      leave in-project popover entries stale for up to 2s.
 */

describe("command registry invalidation across DB mutations", () => {
  let userId: string;

  beforeEach(async () => {
    await setupTestDb();
    const u = await createUser({
      email: "reg@test.com",
      passwordHash: "h",
      name: "Reg",
    });
    userId = u.id;
  });
  afterAll(async () => await closeTestDb());

  function makeRegistry() {
    // Real registry wired against the real DB. `scanHome: false` so we
    // don't pull in the agent's filesystem. `cacheTtlMs: 60_000` so a
    // missing invalidate() call is immediately visible as stale data
    // (otherwise the 2s default could mask a bug under a slow runner).
    return createCommandRegistry({
      homePath: "/tmp/__nowhere__",
      scanHome: false,
      cacheTtlMs: 60_000,
      dbLister: async (uid) => {
        const { listUserCommands } = await import("../db/queries/user-commands");
        const rows = await listUserCommands(uid);
        return rows.map((r) => ({
          name: r.name,
          description: r.description,
          body: r.body,
          frontmatter: (r.frontmatter ?? {}) as Record<string, string>,
        }));
      },
    });
  }

  test("create + invalidate makes the new row visible to listCommands", async () => {
    const registry = makeRegistry();

    // Prime cache with empty result.
    const before = await registry.listCommands({
      userId,
      projectId: "global",
      projectPath: null,
    });
    expect(before).toHaveLength(0);

    await createUserCommand({ userId, name: "fresh", body: "x" });
    registry.invalidate({ userId, projectId: "global" });

    const after = await registry.listCommands({
      userId,
      projectId: "global",
      projectPath: null,
    });
    expect(after.find((c) => c.name === "fresh")).toBeDefined();
  });

  test("WITHOUT invalidate, the cached snapshot is stale (proves the contract matters)", async () => {
    const registry = makeRegistry();

    // Prime cache.
    await registry.listCommands({
      userId,
      projectId: "global",
      projectPath: null,
    });

    // Mutate but DELIBERATELY skip invalidate — the cache should be
    // wrong for up to cacheTtlMs (60s here).
    await createUserCommand({ userId, name: "stale", body: "x" });
    const cached = await registry.listCommands({
      userId,
      projectId: "global",
      projectPath: null,
    });
    expect(cached.find((c) => c.name === "stale")).toBeUndefined();

    // Once we invalidate, the next read picks up the new row.
    registry.invalidate({ userId, projectId: "global" });
    const fresh = await registry.listCommands({
      userId,
      projectId: "global",
      projectPath: null,
    });
    expect(fresh.find((c) => c.name === "stale")).toBeDefined();
  });

  test("update + invalidate surfaces the body change", async () => {
    const registry = makeRegistry();

    await createUserCommand({
      userId,
      name: "edit-me",
      body: "old body",
    });
    registry.invalidate({ userId, projectId: "global" });
    const v1 = await registry.listCommands({
      userId,
      projectId: "global",
      projectPath: null,
    });
    expect(v1.find((c) => c.name === "edit-me")?.body).toBe("old body");

    await updateUserCommand(userId, "edit-me", { body: "new body" });
    registry.invalidate({ userId, projectId: "global" });
    const v2 = await registry.listCommands({
      userId,
      projectId: "global",
      projectPath: null,
    });
    expect(v2.find((c) => c.name === "edit-me")?.body).toBe("new body");
  });

  test("delete + invalidate removes the row from listCommands", async () => {
    const registry = makeRegistry();

    await createUserCommand({ userId, name: "doomed", body: "x" });
    registry.invalidate({ userId, projectId: "global" });
    let snap = await registry.listCommands({
      userId,
      projectId: "global",
      projectPath: null,
    });
    expect(snap.find((c) => c.name === "doomed")).toBeDefined();

    expect(await deleteUserCommand(userId, "doomed")).toBe(true);
    registry.invalidate({ userId, projectId: "global" });
    snap = await registry.listCommands({
      userId,
      projectId: "global",
      projectPath: null,
    });
    expect(snap.find((c) => c.name === "doomed")).toBeUndefined();
  });

  test("findCommand round-trips through the same invalidate flow", async () => {
    const registry = makeRegistry();
    await createUserCommand({
      userId,
      name: "findable",
      body: "discovered",
    });
    registry.invalidate({ userId, projectId: "global" });
    const found = await registry.findCommand({
      userId,
      projectId: "global",
      projectPath: null,
      name: "findable",
    });
    expect(found?.body).toBe("discovered");
    expect(found?.source).toBe("user:db");
  });

  test("invalidate(projectId:'global') does NOT drop a project-scoped cache entry (proves invalidateUser is required)", async () => {
    // This is the core regression: the popover keys cache by the
    // active chat's projectId — typically a real UUID, not the
    // literal "global". Mutating handlers that only invalidate the
    // "global" key leave the in-project popover entry stale.
    const registry = makeRegistry();

    // Prime BOTH cache keys.
    await registry.listCommands({
      userId,
      projectId: "proj-123",
      projectPath: null,
    });
    await registry.listCommands({
      userId,
      projectId: "global",
      projectPath: null,
    });

    await createUserCommand({ userId, name: "in-project", body: "x" });

    // Old behaviour: only the "global" key gets invalidated.
    registry.invalidate({ userId, projectId: "global" });

    // The "proj-123" key is still cached — the new row is INVISIBLE.
    const proj = await registry.listCommands({
      userId,
      projectId: "proj-123",
      projectPath: null,
    });
    expect(proj.find((c) => c.name === "in-project")).toBeUndefined();

    // The "global" key, on the other hand, sees the new row.
    const global = await registry.listCommands({
      userId,
      projectId: "global",
      projectPath: null,
    });
    expect(global.find((c) => c.name === "in-project")).toBeDefined();
  });

  test("invalidateUser drops every cache entry for the user (project + global)", async () => {
    const registry = makeRegistry();

    // Prime BOTH cache keys (each is a different (user, project)
    // pair, so each gets its own cache slot).
    await registry.listCommands({
      userId,
      projectId: "proj-abc",
      projectPath: null,
    });
    await registry.listCommands({
      userId,
      projectId: "global",
      projectPath: null,
    });

    await createUserCommand({ userId, name: "everywhere", body: "x" });

    // The contract that mutating handlers actually call.
    registry.invalidateUser(userId);

    // Both projectIds now see the new row — invalidation was total.
    const proj = await registry.listCommands({
      userId,
      projectId: "proj-abc",
      projectPath: null,
    });
    expect(proj.find((c) => c.name === "everywhere")).toBeDefined();

    const global = await registry.listCommands({
      userId,
      projectId: "global",
      projectPath: null,
    });
    expect(global.find((c) => c.name === "everywhere")).toBeDefined();
  });

  test("invalidateUser is scoped to the target user — other users' caches survive", async () => {
    const registry = makeRegistry();
    const other = await createUser({
      email: "other@test.com",
      passwordHash: "h",
      name: "Other",
    });
    await createUserCommand({ userId: other.id, name: "his", body: "x" });

    // Prime caches for both users.
    await registry.listCommands({
      userId: other.id,
      projectId: "global",
      projectPath: null,
    });
    await registry.listCommands({
      userId,
      projectId: "global",
      projectPath: null,
    });

    // Mutate `other`'s data WITHOUT invalidating, then invalidate
    // only the target user — `other`'s cache must remain stale (proves
    // the prefix match is correctly scoped to `${userId}::`).
    await deleteUserCommand(other.id, "his");
    registry.invalidateUser(userId);

    // Other user's cache survived — the deleted row still shows.
    const otherSnap = await registry.listCommands({
      userId: other.id,
      projectId: "global",
      projectPath: null,
    });
    expect(otherSnap.find((c) => c.name === "his")).toBeDefined();
  });
});
