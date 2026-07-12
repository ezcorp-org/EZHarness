/**
 * Defense-in-depth: {@link getConversationPath}'s recursive parent-walk CTE
 * bounds its depth so a `parent_message_id` CYCLE (corrupt/adversarial data,
 * since the self-FK has no cycle constraint) TRUNCATES instead of looping
 * forever and exhausting the DB (a self-DoS). See MAX_CONVERSATION_PATH_DEPTH.
 *
 * Cases:
 *   1. A→B→A cycle terminates and returns a bounded number of rows (would
 *      hang/OOM without the cap) — exercised with a SMALL injected cap so the
 *      test is fast while proving the production cap's mechanism.
 *   2. The cap never truncates a normal (acyclic) linear branch shorter than
 *      the cap — full history is returned root→leaf.
 */
import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";
import { conversations, messages, projects } from "../db/schema";

mockDbConnection();

const { getConversationPath, MAX_CONVERSATION_PATH_DEPTH } = await import("../db/queries/conversations");

const PROJECT_ID = "p-depthcap";
let convSeq = 0;
const BASE = new Date("2026-07-12T00:00:00.000Z").getTime();
const at = (i: number): Date => new Date(BASE + i * 1000);

async function newConversation(): Promise<string> {
  const db = getTestDb();
  await db.insert(projects).values({ id: PROJECT_ID, name: "P", path: "/tmp/p" }).onConflictDoNothing();
  const convId = `depthcap-conv-${++convSeq}`;
  await db.insert(conversations).values({ id: convId, projectId: PROJECT_ID, title: "C" });
  return convId;
}

async function seedMsg(convId: string, id: string, parentId: string | null, i: number): Promise<void> {
  await getTestDb().insert(messages).values({
    id,
    conversationId: convId,
    role: i % 2 === 0 ? "user" : "assistant",
    content: id,
    parentMessageId: parentId,
    createdAt: at(i),
  });
}

describe("getConversationPath — recursive-CTE depth cap", () => {
  beforeEach(async () => { await setupTestDb(); }, 30_000);
  afterAll(async () => { await closeTestDb(); });

  test("a parent_message_id cycle terminates and returns a bounded path", async () => {
    const c = await newConversation();
    // A→B, then close the loop B→A (a same-conversation UPDATE the FK allows).
    await seedMsg(c, "A", null, 0);
    await seedMsg(c, "B", "A", 1);
    await getTestDb().update(messages).set({ parentMessageId: "B" }).where(eq(messages.id, "A"));

    // Small injected cap: without the bound this recursion never terminates.
    const path = await getConversationPath("A", c, 5);
    // Bounded: cap+1 rows at most (initial depth 0 .. maxDepth), never infinite.
    expect(path.length).toBeLessThanOrEqual(6);
    expect(path.length).toBeGreaterThan(0);
  });

  test("an acyclic branch shorter than the cap is returned in full, root→leaf", async () => {
    const c = await newConversation();
    await seedMsg(c, "m0", null, 0);
    await seedMsg(c, "m1", "m0", 1);
    await seedMsg(c, "m2", "m1", 2);

    const path = await getConversationPath("m2", c);
    expect(path.map((m) => m.id)).toEqual(["m0", "m1", "m2"]);
    // Sanity: the production default is far above any real branch length.
    expect(MAX_CONVERSATION_PATH_DEPTH).toBeGreaterThan(1000);
  });
});
