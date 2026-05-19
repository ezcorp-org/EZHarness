/**
 * Integration coverage for the per-message `excluded` flag — the data
 * layer behind the strike-through "exclude from LLM context" affordance.
 *
 * Pre-fix, the column didn't exist on `messages`, the `setMessageExcluded`
 * query was missing entirely, and `rowToMessage` (used by the recursive-
 * CTE branch path loader) silently dropped the field. End result: every
 * strike-through click 500'd because the route called an undefined
 * function, and even if the call had worked, load-history would never
 * have seen the flag because `getConversationPath` returned rows without
 * it. This test pins all three surfaces together so a regression on any
 * one of them fails loudly here instead of silently in production.
 *
 * Cases:
 *   1. Round-trip — flip excluded=true via the query, read back via
 *      `getMessages`, assert the field is true.
 *   2. Round-trip via the branch path — same flip, but read via
 *      `getConversationPath` so the `rowToMessage` mapper is exercised.
 *   3. Idempotent re-flip — toggling true → false → true does not
 *      lose intermediate values.
 *   4. Missing message — query returns `null` so the route can map to
 *      404 instead of crashing.
 *   5. Cross-conversation isolation — flipping a message in conv A
 *      does NOT mutate a same-id-shaped row in conv B (the WHERE
 *      clause must include `conversationId`).
 *   6. New rows default to `excluded=false` so old transcripts and
 *      newly-created turns both ride the same code path.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

mockDbConnection();

const { createUser } = await import("../db/queries/users");
const { createProject } = await import("../db/queries/projects");
const {
  createConversation,
  createMessage,
  getMessages,
  getConversationPath,
  setMessageExcluded,
} = await import("../db/queries/conversations");

let userId = "";
let projectId = "";

beforeAll(async () => {
  await setupTestDb();
  const u = await createUser({ email: "excluded@test.com", passwordHash: "h", name: "Excluded" });
  userId = u.id;
  const p = await createProject({ name: "p", path: "/tmp" });
  projectId = p.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

async function seedConversationWithMessage(content = "hello") {
  const conv = await createConversation(projectId, { userId });
  const msg = await createMessage(conv.id, { role: "user", content });
  return { conv, msg };
}

describe("setMessageExcluded — query layer", () => {
  beforeEach(async () => {
    // Each test gets a fresh conversation so cross-test state can't leak.
    // setupTestDb() in beforeAll provisions the schema once; we don't
    // reset the whole DB per test because the user/project rows above
    // are reused.
  });

  test("new messages default to excluded=false", async () => {
    const { msg } = await seedConversationWithMessage("default-included");
    expect(msg.excluded).toBe(false);
  });

  test("flipping excluded=true round-trips through getMessages", async () => {
    const { conv, msg } = await seedConversationWithMessage();
    const updated = await setMessageExcluded(conv.id, msg.id, true);
    expect(updated).not.toBeNull();
    expect(updated!.excluded).toBe(true);

    const all = await getMessages(conv.id);
    const found = all.find((m) => m.id === msg.id);
    expect(found?.excluded).toBe(true);
  });

  test("flipping excluded round-trips through getConversationPath (rowToMessage)", async () => {
    // The branch-path loader uses a recursive CTE + rowToMessage, which
    // is a separate code path from getMessages's drizzle select(). A
    // mapper that drops `excluded` would pass the previous test and
    // still break load-history's filter — that's the bug this case
    // pins down.
    const { conv, msg } = await seedConversationWithMessage("branch-path-test");
    await setMessageExcluded(conv.id, msg.id, true);

    const path = await getConversationPath(msg.id, conv.id);
    expect(path.length).toBe(1);
    expect(path[0]!.excluded).toBe(true);
  });

  test("toggle on → off → on preserves the most recent flip", async () => {
    const { conv, msg } = await seedConversationWithMessage();

    let r = await setMessageExcluded(conv.id, msg.id, true);
    expect(r!.excluded).toBe(true);

    r = await setMessageExcluded(conv.id, msg.id, false);
    expect(r!.excluded).toBe(false);

    r = await setMessageExcluded(conv.id, msg.id, true);
    expect(r!.excluded).toBe(true);

    const reread = (await getMessages(conv.id))[0]!;
    expect(reread.excluded).toBe(true);
  });

  test("returns null when the message id is unknown", async () => {
    const { conv } = await seedConversationWithMessage();
    const r = await setMessageExcluded(conv.id, "no-such-message", true);
    expect(r).toBeNull();
  });

  test("does NOT mutate a row from a different conversation", async () => {
    // Same message UUID won't collide naturally (UUIDs are unique), but
    // the WHERE clause MUST include conversation_id — if a future
    // refactor drops it, this test catches the cross-conversation
    // bleed by attempting to flip a real message via the wrong conv id.
    const a = await seedConversationWithMessage("conv-a");
    const b = await seedConversationWithMessage("conv-b");

    const r = await setMessageExcluded(b.conv.id, a.msg.id, true);
    expect(r).toBeNull(); // wrong conv → no rows match → null

    const reread = (await getMessages(a.conv.id)).find((m) => m.id === a.msg.id);
    expect(reread?.excluded).toBe(false);
  });
});
