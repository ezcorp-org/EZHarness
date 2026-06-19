/**
 * Migration coverage for the `runs.user_id` attribution backfill (IDOR fix).
 *
 * Locks in the security invariant at the storage layer: re-running migrate()
 * attributes every HISTORICAL chat run to its ROOT conversation's owner, so a
 * run created before run-attribution existed becomes ownable (and thus
 * deniable to non-owners) instead of being treated as "anyone may act".
 *
 * Covers:
 *   - top-level chat run → backfilled to the conversation's owner
 *   - SUB-conversation chat run → backfilled to the ROOT owner (recursive walk)
 *   - agent/CLI run (conversation_id NULL) → stays NULL (admin-only downstream)
 *   - a run that already carries a user_id is NOT overwritten (idempotent)
 *   - the column is nullable + the index exists
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { sql } from "drizzle-orm";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, getTestDb, getTestPglite, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import { users, projects, conversations, runs } from "../db/schema";
import { migrate } from "../db/migrate";

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

describe("migrate(): runs.user_id attribution backfill", () => {
  test("top-level chat run is backfilled from the conversation owner", async () => {
    const db = getTestDb();
    const USER_ID = "u-run-bf-1";
    const PROJECT_ID = "p-run-bf-1";
    const CONV_ID = "conv-run-bf-1";
    const RUN_ID = "run-bf-1";

    await db.insert(users).values({ id: USER_ID, email: "r1@x.com", passwordHash: "x", name: "R1", role: "member" } as any);
    await db.insert(projects).values({ id: PROJECT_ID, name: "r1", path: "/tmp/r1" } as any);
    await db.insert(conversations).values({ id: CONV_ID, projectId: PROJECT_ID, userId: USER_ID } as any);
    // Run inserted as if before user_id existed — explicitly NULL.
    await db.insert(runs).values({
      id: RUN_ID, agentName: "chat", conversationId: CONV_ID,
      status: "success", startedAt: new Date(), userId: null,
    } as any);

    await migrate(db);

    const { rows } = await getTestPglite().query<{ user_id: string | null }>(
      `SELECT user_id FROM runs WHERE id = $1`, [RUN_ID],
    );
    expect(rows[0]!.user_id).toBe(USER_ID);
  });

  test("sub-conversation chat run is backfilled from the ROOT owner (recursive walk)", async () => {
    const db = getTestDb();
    const USER_ID = "u-run-bf-2";
    const PROJECT_ID = "p-run-bf-2";
    const ROOT_ID = "conv-root-bf-2";
    const SUB_ID = "conv-sub-bf-2";
    const RUN_ID = "run-bf-2";

    await db.insert(users).values({ id: USER_ID, email: "r2@x.com", passwordHash: "x", name: "R2", role: "member" } as any);
    await db.insert(projects).values({ id: PROJECT_ID, name: "r2", path: "/tmp/r2" } as any);
    await db.insert(conversations).values({ id: ROOT_ID, projectId: PROJECT_ID, userId: USER_ID } as any);
    // Sub-conversation: userId NULL, parent → owned root.
    await db.insert(conversations).values({ id: SUB_ID, projectId: PROJECT_ID, userId: null, parentConversationId: ROOT_ID } as any);
    await db.insert(runs).values({
      id: RUN_ID, agentName: "chat", conversationId: SUB_ID,
      status: "success", startedAt: new Date(), userId: null,
    } as any);

    await migrate(db);

    const { rows } = await getTestPglite().query<{ user_id: string | null }>(
      `SELECT user_id FROM runs WHERE id = $1`, [RUN_ID],
    );
    expect(rows[0]!.user_id).toBe(USER_ID);
  });

  test("agent/CLI run (conversation_id NULL) stays NULL after backfill (admin-only)", async () => {
    const db = getTestDb();
    const RUN_ID = "run-bf-3-agent";
    await db.insert(runs).values({
      id: RUN_ID, agentName: "writer", conversationId: null,
      status: "success", startedAt: new Date(), userId: null,
    } as any);

    await migrate(db);

    const { rows } = await getTestPglite().query<{ user_id: string | null }>(
      `SELECT user_id FROM runs WHERE id = $1`, [RUN_ID],
    );
    expect(rows[0]!.user_id).toBeNull();
  });

  test("backfill never overwrites a run that already carries a user_id (idempotent)", async () => {
    const db = getTestDb();
    const OWNER_ID = "u-run-bf-4-owner";
    const OTHER_ID = "u-run-bf-4-other";
    const PROJECT_ID = "p-run-bf-4";
    const CONV_ID = "conv-run-bf-4";
    const RUN_ID = "run-bf-4";

    await db.insert(users).values({ id: OWNER_ID, email: "r4o@x.com", passwordHash: "x", name: "R4o", role: "member" } as any);
    await db.insert(users).values({ id: OTHER_ID, email: "r4x@x.com", passwordHash: "x", name: "R4x", role: "member" } as any);
    await db.insert(projects).values({ id: PROJECT_ID, name: "r4", path: "/tmp/r4" } as any);
    // Conversation owned by OWNER, but the run already attributes to OTHER.
    await db.insert(conversations).values({ id: CONV_ID, projectId: PROJECT_ID, userId: OWNER_ID } as any);
    await db.insert(runs).values({
      id: RUN_ID, agentName: "chat", conversationId: CONV_ID,
      status: "success", startedAt: new Date(), userId: OTHER_ID,
    } as any);

    await migrate(db);

    const { rows } = await getTestPglite().query<{ user_id: string | null }>(
      `SELECT user_id FROM runs WHERE id = $1`, [RUN_ID],
    );
    // Pre-existing attribution survives — backfill only fills NULLs.
    expect(rows[0]!.user_id).toBe(OTHER_ID);
  });

  test("runs.user_id column is nullable (pre-migration writers stay valid)", async () => {
    const pg = getTestPglite();
    const { rows } = await pg.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'runs' AND column_name = 'user_id'`,
    );
    expect(rows[0]!.is_nullable).toBe("YES");
  });

  test("idx_runs_user_id index exists", async () => {
    const pg = getTestPglite();
    const { rows } = await pg.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'runs'`,
    );
    expect(new Set(rows.map((r) => r.indexname)).has("idx_runs_user_id")).toBe(true);
  });

  test("sql tag import smoke (guards the drizzle SQL import the file relies on)", () => {
    expect(typeof sql).toBe("function");
  });
});
