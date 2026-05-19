/**
 * Integration coverage for `loadHistory`'s `excluded` filter — the
 * server-side half of the strike-through "exclude from LLM context"
 * affordance. The UI flips the flag via PATCH; this test pins down the
 * load-history side: rows where `excluded=true` MUST be dropped before
 * the array is shaped into pi-ai messages.
 *
 * Cases:
 *   1. Mixed branch — excluded user turn is filtered out, surrounding
 *      turns survive in order.
 *   2. All excluded — empty branch is shaped (no crash, no leak of the
 *      excluded content into the request).
 *   3. Toggle off restores the row — flipping back to false makes the
 *      row reappear in the next load-history call.
 *
 * Why integration: the filter applies to rows produced by
 * `getConversationPath`, which uses a recursive CTE + the snake-case
 * `rowToMessage` mapper. A unit test against an in-memory array would
 * miss the very layer the original bug lived in.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { tmpdir } from "node:os";

mockDbConnection();

const { loadHistory } = await import("../runtime/stream-chat/load-history");
const { createUser } = await import("../db/queries/users");
const { createProject } = await import("../db/queries/projects");
const {
  createConversation,
  createMessage,
  setMessageExcluded,
} = await import("../db/queries/conversations");
import type { StreamChatContext } from "../runtime/stream-chat/context";

const SAFE_CWD = tmpdir();

let userId = "";
let projectId = "";

beforeAll(async () => {
  await setupTestDb();
  const u = await createUser({ email: "loadhist-excl@test.com", passwordHash: "h", name: "LH" });
  userId = u.id;
  const p = await createProject({ name: "p", path: "/tmp" });
  projectId = p.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
  process.chdir(SAFE_CWD);
});

function mkCtx(): StreamChatContext {
  return { system: undefined } as unknown as StreamChatContext;
}

async function seedThreeTurns() {
  const conv = await createConversation(projectId, { userId });
  const u1 = await createMessage(conv.id, { role: "user", content: "first user" });
  const a1 = await createMessage(conv.id, {
    role: "assistant",
    content: "first assistant",
    parentMessageId: u1.id,
  });
  const u2 = await createMessage(conv.id, {
    role: "user",
    content: "second user (excluded)",
    parentMessageId: a1.id,
  });
  const a2 = await createMessage(conv.id, {
    role: "assistant",
    content: "second assistant",
    parentMessageId: u2.id,
  });
  return { conv, u1, a1, u2, a2 };
}

/** Flatten pi-ai content (string | array of parts) into a single text
 *  string for substring assertions. Image parts (etc.) are ignored — we
 *  only need to detect leaks of excluded text content into history. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (typeof p === "object" && p !== null && "text" in p ? String((p as any).text) : ""))
    .join("\n");
}

describe("loadHistory — excluded filter", () => {
  test("drops the excluded turn from the pi-ai message array", async () => {
    const ctx = mkCtx();
    const { conv, u2, a2 } = await seedThreeTurns();

    await setMessageExcluded(conv.id, u2.id, true);

    const result = await loadHistory(ctx, conv.id, {
      parentMessageId: a2.id,
      projectId,
    });

    expect(result.history.length).toBe(3); // 4 turns → 3 after one excluded
    const blob = result.history.map((m) => textOf(m.content)).join("\n");
    expect(blob).toContain("first user");
    expect(blob).toContain("first assistant");
    expect(blob).toContain("second assistant");
    // The excluded turn's content must NOT have leaked into history.
    expect(blob).not.toContain("second user (excluded)");
  });

  test("all-excluded branch produces an empty history without throwing", async () => {
    const ctx = mkCtx();
    const { conv, u1, a1, u2, a2 } = await seedThreeTurns();

    for (const id of [u1.id, a1.id, u2.id, a2.id]) {
      await setMessageExcluded(conv.id, id, true);
    }

    const result = await loadHistory(ctx, conv.id, {
      parentMessageId: a2.id,
      projectId,
    });
    expect(result.history.length).toBe(0);
  });

  test("toggling excluded back to false re-includes the row on the next load", async () => {
    const ctx = mkCtx();
    const { conv, u2, a2 } = await seedThreeTurns();

    await setMessageExcluded(conv.id, u2.id, true);
    let result = await loadHistory(ctx, conv.id, { parentMessageId: a2.id, projectId });
    expect(result.history.length).toBe(3);

    await setMessageExcluded(conv.id, u2.id, false);
    result = await loadHistory(ctx, conv.id, { parentMessageId: a2.id, projectId });
    expect(result.history.length).toBe(4);
    const blob = result.history.map((m) => textOf(m.content)).join("\n");
    expect(blob).toContain("second user (excluded)");
  });
});
