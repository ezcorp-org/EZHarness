/**
 * Integration tests for the fork-link columns added to `conversations`:
 *   `forkedFromConversationId` (FK → conversations.id, ON DELETE SET NULL)
 *   `forkedFromMessageId`     (anchor message id; nullable text, no FK)
 *
 * These tests seed conversations directly via drizzle (not via
 * `cloneTurnsIntoNewConversation` — that helper has its own coverage in
 * `conversations-clone-turns.test.ts`) so the assertions stay focused on
 * schema/migration/query behaviour.
 */

import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, getTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

import { eq } from "drizzle-orm";
import { users, projects, conversations, messages } from "../db/schema";
import { migrate } from "../db/migrate";
import {
  getConversation,
  listConversations,
  deleteConversation,
} from "../db/queries/conversations";

const USER_ID = "u-fork-1";
const PROJECT_ID = "p-fork-1";
const SOURCE_CONV_ID = "conv-fork-source";
const FORK_CONV_ID = "conv-fork-child";
const SUB_CONV_ID = "conv-sub-child";
const ANCHOR_MSG_ID = "msg-fork-anchor";

async function seedFixtures() {
  const db = getTestDb();
  await db.insert(users).values({
    id: USER_ID,
    email: "f@x.com",
    passwordHash: "x",
    name: "Fork",
    role: "member",
  } as any);
  await db.insert(projects).values({ id: PROJECT_ID, name: "p", path: "/tmp/p" } as any);

  // Source conversation with a single anchor message.
  await db.insert(conversations).values({
    id: SOURCE_CONV_ID,
    projectId: PROJECT_ID,
    title: "Source chat",
    model: "claude-sonnet-4-6",
    provider: "anthropic",
    systemPrompt: "Be helpful.",
    userId: USER_ID,
  } as any);
  await db.insert(messages).values({
    id: ANCHOR_MSG_ID,
    conversationId: SOURCE_CONV_ID,
    role: "user",
    content: "Anchor message.",
    parentMessageId: null,
    runId: null,
    createdAt: new Date("2026-04-01T00:00:00Z"),
  } as any);
}

beforeEach(async () => {
  await setupTestDb();
  await seedFixtures();
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

describe("fork-link integration", () => {
  test("migrate(db) is idempotent — running it a second time does not throw", async () => {
    // setupTestDb() already ran migrate() once. A second invocation against
    // the same PGlite must succeed (every relevant ALTER/CREATE in
    // src/db/migrate.ts uses IF NOT EXISTS / IF EXISTS guards).
    const db = getTestDb();
    await expect(migrate(db)).resolves.toBeUndefined();
    // Sanity: the fork columns are still present and queryable post second-run.
    const rows = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, SOURCE_CONV_ID));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.forkedFromConversationId).toBeNull();
    expect(rows[0]!.forkedFromMessageId).toBeNull();
  });

  test("listConversations includes forks (parentConversationId IS NULL, forkedFromConversationId IS NOT NULL)", async () => {
    const db = getTestDb();
    await db.insert(conversations).values({
      id: FORK_CONV_ID,
      projectId: PROJECT_ID,
      title: "Forked: Source chat",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      systemPrompt: "Be helpful.",
      userId: USER_ID,
      parentConversationId: null,
      parentMessageId: null,
      forkedFromConversationId: SOURCE_CONV_ID,
      forkedFromMessageId: ANCHOR_MSG_ID,
    } as any);

    const list = await listConversations(PROJECT_ID, USER_ID);
    const ids = list.map((c) => c.id);
    expect(ids).toContain(SOURCE_CONV_ID);
    expect(ids).toContain(FORK_CONV_ID);
    const fork = list.find((c) => c.id === FORK_CONV_ID)!;
    expect(fork.forkedFromConversationId).toBe(SOURCE_CONV_ID);
    expect(fork.forkedFromMessageId).toBe(ANCHOR_MSG_ID);
    expect(fork.parentConversationId).toBeNull();
  });

  test("listConversations excludes sub-conversations (parentConversationId IS NOT NULL)", async () => {
    const db = getTestDb();
    await db.insert(conversations).values({
      id: SUB_CONV_ID,
      projectId: PROJECT_ID,
      title: "Sub-conversation",
      userId: USER_ID,
      parentConversationId: SOURCE_CONV_ID,
      parentMessageId: ANCHOR_MSG_ID,
    } as any);

    const list = await listConversations(PROJECT_ID, USER_ID);
    const ids = list.map((c) => c.id);
    expect(ids).toContain(SOURCE_CONV_ID);
    expect(ids).not.toContain(SUB_CONV_ID);
  });

  test("getConversation returns both fork-link fields populated on a fork row", async () => {
    const db = getTestDb();
    await db.insert(conversations).values({
      id: FORK_CONV_ID,
      projectId: PROJECT_ID,
      title: "Forked: Source chat",
      userId: USER_ID,
      forkedFromConversationId: SOURCE_CONV_ID,
      forkedFromMessageId: ANCHOR_MSG_ID,
    } as any);

    const fork = await getConversation(FORK_CONV_ID);
    expect(fork).not.toBeNull();
    expect(fork!.forkedFromConversationId).toBe(SOURCE_CONV_ID);
    expect(fork!.forkedFromMessageId).toBe(ANCHOR_MSG_ID);
    // Source conv stays unlinked.
    const source = await getConversation(SOURCE_CONV_ID);
    expect(source!.forkedFromConversationId).toBeNull();
    expect(source!.forkedFromMessageId).toBeNull();
  });

  test("deleting the source conversation clears forkedFromConversationId on the fork (ON DELETE SET NULL)", async () => {
    const db = getTestDb();
    await db.insert(conversations).values({
      id: FORK_CONV_ID,
      projectId: PROJECT_ID,
      title: "Forked: Source chat",
      userId: USER_ID,
      forkedFromConversationId: SOURCE_CONV_ID,
      forkedFromMessageId: ANCHOR_MSG_ID,
    } as any);

    const deleted = await deleteConversation(SOURCE_CONV_ID);
    expect(deleted).toBe(true);

    // Fork row survives.
    const fork = await getConversation(FORK_CONV_ID);
    expect(fork).not.toBeNull();
    // Source-pointer column was nulled out by the ON DELETE SET NULL FK.
    expect(fork!.forkedFromConversationId).toBeNull();
    // forkedFromMessageId has no FK — schema leaves it untouched. The anchor
    // id remains as a tombstone reference (still useful for diagnostics).
    expect(fork!.forkedFromMessageId).toBe(ANCHOR_MSG_ID);

    // Source is gone.
    const source = await getConversation(SOURCE_CONV_ID);
    expect(source).toBeNull();
  });

  test("fork rows do not populate parentConversationId / parentMessageId — those belong to sub-conversations only", async () => {
    const db = getTestDb();
    await db.insert(conversations).values({
      id: FORK_CONV_ID,
      projectId: PROJECT_ID,
      title: "Forked: Source chat",
      userId: USER_ID,
      forkedFromConversationId: SOURCE_CONV_ID,
      forkedFromMessageId: ANCHOR_MSG_ID,
    } as any);

    const fork = await getConversation(FORK_CONV_ID);
    expect(fork).not.toBeNull();
    expect(fork!.parentConversationId).toBeNull();
    expect(fork!.parentMessageId).toBeNull();
    // And the inverse: a sub-conversation with parentConversationId set must
    // leave the fork columns null. The two link mechanisms are disjoint.
    await db.insert(conversations).values({
      id: SUB_CONV_ID,
      projectId: PROJECT_ID,
      title: "Sub-conversation",
      userId: USER_ID,
      parentConversationId: SOURCE_CONV_ID,
      parentMessageId: ANCHOR_MSG_ID,
    } as any);
    const sub = await getConversation(SUB_CONV_ID);
    expect(sub).not.toBeNull();
    expect(sub!.parentConversationId).toBe(SOURCE_CONV_ID);
    expect(sub!.parentMessageId).toBe(ANCHOR_MSG_ID);
    expect(sub!.forkedFromConversationId).toBeNull();
    expect(sub!.forkedFromMessageId).toBeNull();
  });
});
