/**
 * query-aux (db-audit): the session-sync APPEND cursor must not permanently
 * skip a message row that commits LATE with an old createdAt.
 *
 * `messages.createdAt` defaults to now() = TRANSACTION-START time on external
 * Postgres, so with Bun.sql's pool an insert can commit AFTER a concurrent
 * sync already read a later-createdAt row and advanced the high-water cursor
 * past this row's timestamp (message inserts aren't under withConvSessionLock);
 * a backward clock step causes the same inversion. The OLD gate
 * (`if (ms < cursor) continue;`) then skipped that row FOREVER — a permanently
 * missing tree node whose children orphan the whole subtree.
 *
 * The fix makes the cursor a fast-path ONLY: it may skip a row that is
 * genuinely present, but a row ABSENT from the tree is appended regardless of
 * the cursor. This test reproduces the inversion deterministically (seed a row
 * whose createdAt is below an already-advanced cursor) and asserts the row is
 * healed onto the tree and reads back on the branch.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const { syncSessionForConversation, computeSessionBranch, SYNC_CURSOR_META_KEY } =
  await import("../db/session-sync");

const PROJECT_ID = "p-race";
let convSeq = 0;
const BASE = new Date("2026-07-15T00:00:00.000Z").getTime();
const at = (i: number): Date => new Date(BASE + i * 1000);

async function newConversation(): Promise<string> {
  const db = getTestDb();
  const { projects, conversations } = await import("../db/schema");
  await db.insert(projects).values({ id: PROJECT_ID, name: "P", path: "/tmp/p-race" }).onConflictDoNothing();
  const convId = `race-conv-${++convSeq}`;
  await db.insert(conversations).values({ id: convId, projectId: PROJECT_ID, title: "C" });
  return convId;
}

async function seedMsg(convId: string, id: string, role: string, parentId: string | null, createdAt: Date): Promise<void> {
  const { messages } = await import("../db/schema");
  await getTestDb().insert(messages).values({
    id, conversationId: convId, role, content: id, parentMessageId: parentId, createdAt,
  });
}

async function cursorOf(convId: string): Promise<unknown> {
  const { agentSessions } = await import("../db/schema");
  const [s] = await getTestDb().select().from(agentSessions).where(eq(agentSessions.conversationId, convId));
  return (s?.metadata as Record<string, unknown> | null)?.[SYNC_CURSOR_META_KEY];
}

describe("syncSessionForConversation — late-commit / clock-step race", () => {
  beforeEach(async () => { await setupTestDb(); }, 30_000);
  afterAll(async () => { await closeTestDb(); });

  test("a row whose createdAt is BELOW the advanced cursor is still appended (not skipped forever)", async () => {
    const c = await newConversation();
    // First sync advances the cursor to at(10).
    await seedMsg(c, "u1", "user", null, at(0));
    await seedMsg(c, "a1", "assistant", "u1", at(10));
    await syncSessionForConversation(c);
    expect(await cursorOf(c)).toBe(at(10).getTime());

    // A late-committing insert lands with a transaction-start createdAt of
    // at(5) — STRICTLY BELOW the cursor. Under the old `ms < cursor` gate this
    // row would be skipped on every subsequent sync and never appended.
    await seedMsg(c, "u2", "user", "a1", at(5));
    const { storage } = await syncSessionForConversation(c);

    const ids = (await storage.getEntries())
      .filter((e) => e.type === "message")
      .map((e) => e.id)
      .sort();
    expect(ids).toEqual(["a1", "u1", "u2"]);
    // The cursor is unchanged — the late row is older than the high-water mark.
    expect(await cursorOf(c)).toBe(at(10).getTime());
    // And the healed node reads back on the branch (children would otherwise
    // orphan the subtree and force the legacy-CTE fallback).
    expect((await computeSessionBranch(c, "u2")).map((r) => r.id)).toEqual(["u1", "a1", "u2"]);
  });

  test("an already-present row below the cursor is NOT re-appended (fast-path intact)", async () => {
    const c = await newConversation();
    await seedMsg(c, "u1", "user", null, at(0));
    await seedMsg(c, "a1", "assistant", "u1", at(10));
    await syncSessionForConversation(c);
    // Re-sync with no new rows: u1 (below cursor, present) stays single.
    const { storage } = await syncSessionForConversation(c);
    const u1 = (await storage.getEntries()).filter((e) => e.id === "u1");
    expect(u1.length).toBe(1);
  });
});
