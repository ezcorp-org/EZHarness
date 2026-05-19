/**
 * Phase 48 Wave 1 — DB-query-level invariants around the Ez mode lock.
 *
 * The 403-rejection logic lives in the API layer (verified by
 * web/src/__tests__/api-conversations-ez-lock.server.test.ts). These
 * tests pin the DB-level facts that guard depends on:
 *  - getOrCreateEzConversation hardcodes modeId = 'builtin-ez'
 *  - the seeded 'ez' mode has slug='ez' and id='builtin-ez' — the API
 *    can rely on either marker
 *  - kind defaults to 'regular' for createConversation
 *  - updating a kind='ez' row's modeId via the raw query DOES succeed
 *    (the lock is enforced at the API, not the DB) — sanity check
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const { createUser } = await import("../db/queries/users");
const {
  getOrCreateEzConversation,
  createConversation,
  updateConversation,
  getConversation,
} = await import("../db/queries/conversations");
const { createProject } = await import("../db/queries/projects");
const { getModeBySlug } = await import("../db/queries/modes");

let userId: string;
let projectId: string;

beforeAll(async () => {
  await setupTestDb();
  const u = await createUser({ email: "ez-lock@test.com", passwordHash: "h", name: "EZ" });
  userId = u.id;
  const p = await createProject({ name: "Test Project", path: "/tmp/test" });
  projectId = p.id;
});

afterAll(async () => {
  await closeTestDb();
});

describe("conversation-side facts the API ez-lock depends on", () => {
  test("the seeded 'ez' mode has the well-known id 'builtin-ez'", async () => {
    // The API guard checks `mode.slug === 'ez'` to reject regular conversations
    // that try to adopt the Ez mode. The id 'builtin-ez' is the seed's
    // primary key — also stable. Both markers must be present so the
    // application has flexible reject paths.
    const mode = await getModeBySlug("ez");
    expect(mode).toBeDefined();
    expect(mode!.id).toBe("builtin-ez");
    expect(mode!.slug).toBe("ez");
    expect(mode!.builtin).toBe(true);
  });

  test("getOrCreateEzConversation hardcodes modeId='builtin-ez'", async () => {
    const conv = await getOrCreateEzConversation(userId);
    expect(conv.modeId).toBe("builtin-ez");
    expect(conv.kind).toBe("ez");
  });

  test("createConversation defaults kind to 'regular' (the lock only fires on ez)", async () => {
    const conv = await createConversation(projectId, { userId });
    expect(conv.kind).toBe("regular");
  });

  test("updateConversation at the query layer is unguarded — the lock is API-level", async () => {
    // The DB-layer query is dumb; the API handler is the bouncer. This
    // test pins the contract so a future refactor knows where the
    // safety net lives.
    const ez = await getOrCreateEzConversation(userId);
    const updated = await updateConversation(ez.id, { modeId: null });
    expect(updated).toBeDefined();
    expect(updated!.modeId).toBeNull();

    // Restore so other tests in the file see a coherent ez row.
    await updateConversation(ez.id, { modeId: "builtin-ez" });
    const restored = await getConversation(ez.id);
    expect(restored!.modeId).toBe("builtin-ez");
  });

  test("a regular conversation with no modeId carries kind='regular'", async () => {
    // Defensive: the unique partial index conversations_user_ez_unique
    // only fires WHERE kind='ez' — a project-scoped regular conv must
    // not spuriously trip it.
    const a = await createConversation(projectId, { userId, title: "regular-1" });
    const b = await createConversation(projectId, { userId, title: "regular-2" });
    expect(a.kind).toBe("regular");
    expect(b.kind).toBe("regular");
    expect(a.id).not.toBe(b.id);
  });
});
