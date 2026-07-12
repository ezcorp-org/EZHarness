/**
 * Wave6 A3 — the high-water APPEND cursor in syncSessionForConversation.
 *
 * The existing P3 suite (session-sync.test.ts) already pins the reparent-past-
 * cursor case (its "topology reconcile" test reparents an already-synced row
 * and the FULL, cursor-independent sweep must still catch it — the design's
 * load-bearing honesty). This file pins the properties NEW to the cursor:
 *
 *   1. The cursor is PERSISTED to agent_sessions.metadata and advances to the
 *      newest reconciled createdAt.
 *   2. Same-MILLISECOND correctness: a new row sharing the exact createdAt of
 *      the cursor is STILL appended. This is why the gate is `createdAt <
 *      cursor` (strict), never `<=` — messages routinely share a createdAt ms
 *      (see getConversationPath's ordering note); a `<=` gate would silently
 *      drop the straddling row.
 *   3. A row strictly OLDER than the cursor that is already present is skipped
 *      without a duplicate append (the O(delta) fast path).
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";
import { agentSessions, conversations, messages, projects } from "../db/schema";

mockDbConnection();

const { syncSessionForConversation, computeSessionBranch, SYNC_CURSOR_META_KEY } = await import("../db/session-sync");

const PROJECT_ID = "p-cursor";
let convSeq = 0;
const BASE = new Date("2026-07-12T00:00:00.000Z").getTime();
const at = (i: number): Date => new Date(BASE + i * 1000);

async function newConversation(): Promise<string> {
  const db = getTestDb();
  await db.insert(projects).values({ id: PROJECT_ID, name: "P", path: "/tmp/p" }).onConflictDoNothing();
  const convId = `cursor-conv-${++convSeq}`;
  await db.insert(conversations).values({ id: convId, projectId: PROJECT_ID, title: "C" });
  return convId;
}

async function seedMsg(convId: string, id: string, role: string, parentId: string | null, createdAt: Date): Promise<void> {
  await getTestDb().insert(messages).values({
    id, conversationId: convId, role, content: id, parentMessageId: parentId, createdAt,
  });
}

async function cursorOf(convId: string): Promise<unknown> {
  const [s] = await getTestDb().select().from(agentSessions).where(eq(agentSessions.conversationId, convId));
  return (s?.metadata as Record<string, unknown> | null)?.[SYNC_CURSOR_META_KEY];
}

describe("syncSessionForConversation — high-water append cursor", () => {
  beforeEach(async () => { await setupTestDb(); }, 30_000);
  afterAll(async () => { await closeTestDb(); });

  test("persists the cursor at the newest reconciled createdAt and advances it", async () => {
    const c = await newConversation();
    await seedMsg(c, "u1", "user", null, at(0));
    await seedMsg(c, "a1", "assistant", "u1", at(1));
    await syncSessionForConversation(c);
    expect(await cursorOf(c)).toBe(at(1).getTime());

    await seedMsg(c, "u2", "user", "a1", at(5));
    await syncSessionForConversation(c);
    expect(await cursorOf(c)).toBe(at(5).getTime());
  });

  test("a new row sharing the cursor's exact millisecond is still appended (strict `<` gate)", async () => {
    const c = await newConversation();
    // u1 and a1 share the SAME createdAt ms; the sync sets cursor to that ms.
    await seedMsg(c, "u1", "user", null, at(3));
    await seedMsg(c, "a1", "assistant", "u1", at(3));
    await syncSessionForConversation(c);
    expect(await cursorOf(c)).toBe(at(3).getTime());

    // A THIRD row arrives at the very same ms (same-millisecond turn). A `<=`
    // gate would skip it as "already synced"; the strict `<` gate re-checks it.
    await seedMsg(c, "u2", "user", "a1", at(3));
    const { storage } = await syncSessionForConversation(c);
    const ids = (await storage.getEntries()).filter((e) => e.type === "message").map((e) => e.id);
    expect(ids.sort()).toEqual(["a1", "u1", "u2"]);
    // And it reads back on the branch.
    expect((await computeSessionBranch(c, "u2")).map((r) => r.id)).toEqual(["u1", "a1", "u2"]);
  });

  test("an older, already-present row is skipped with no duplicate append", async () => {
    const c = await newConversation();
    await seedMsg(c, "u1", "user", null, at(0));
    await seedMsg(c, "a1", "assistant", "u1", at(2));
    await syncSessionForConversation(c); // cursor = at(2); u1 (at 0) now < cursor
    // Re-sync with no new rows: u1 is strictly older than the cursor → skipped,
    // and no duplicate entry is written for it.
    const { storage } = await syncSessionForConversation(c);
    const u1entries = (await storage.getEntries()).filter((e) => e.id === "u1");
    expect(u1entries.length).toBe(1);
    // Cursor unchanged (no new rows to advance past).
    expect(await cursorOf(c)).toBe(at(2).getTime());
  });
});
