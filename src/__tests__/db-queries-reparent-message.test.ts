/**
 * DB-level coverage for `reparentMessage` — the single-column parent-pointer
 * update behind P4 §1.2 steered-row reconciliation. agent-chat persists a
 * steer's user row at request time with the leaf-at-request parent; when the
 * steer is delivered mid-run the LLM sees it at a LATER branch position, so
 * subscribe-bridge re-parents the row here.
 *
 * Contract:
 *   - the parent pointer round-trips and getConversationPath reflects it
 *   - re-parenting a dangling steer row onto the run's leaf puts it on the
 *     branch, and a subsequent turn parented onto it rebuilds the exact
 *     sequence the LLM saw (the invariant P4 §1.2 exists to protect)
 *   - re-parent to null re-roots the row
 *   - unknown ids return null instead of throwing
 *   - conversation-scoped: a leaked id from another conversation can't be moved
 */

import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const {
  createConversation,
  createMessage,
  getMessages,
  getConversationPath,
  reparentMessage,
} = await import("../db/queries/conversations");
const { createProject } = await import("../db/queries/projects");

describe("reparentMessage", () => {
  let projectId: string;
  let convId: string;

  beforeEach(async () => {
    await setupTestDb();
    const p = await createProject({ name: "Reparent", path: "/tmp/reparent" });
    projectId = p.id;
    const c = await createConversation(projectId, { title: "t" });
    convId = c.id;
  });
  afterAll(async () => await closeTestDb());

  test("moves the parent pointer and returns the updated row", async () => {
    const u1 = await createMessage(convId, { role: "user", content: "u1" });
    const a1 = await createMessage(convId, { role: "assistant", content: "a1", parentMessageId: u1.id });
    const stray = await createMessage(convId, { role: "user", content: "stray", parentMessageId: u1.id });

    const updated = await reparentMessage(convId, stray.id, a1.id);
    expect(updated).not.toBeNull();
    expect(updated!.id).toBe(stray.id);
    expect(updated!.parentMessageId).toBe(a1.id);

    // Confirm the write hit disk, not just the returned-row builder.
    const row = (await getMessages(convId)).find((m) => m.id === stray.id)!;
    expect(row.parentMessageId).toBe(a1.id);
  });

  test("reconciliation: a dangling steer row moves onto the run leaf and a later turn threads through it", async () => {
    // Mirror the divergence P4 §1.2 fixes. At request time the leaf is u1; the
    // route persists the steer U with parent=u1. The run then produces turn B
    // (parented on u1) — so U dangles off u1, OFF the assistant branch.
    const u1 = await createMessage(convId, { role: "user", content: "u1" });
    const steerU = await createMessage(convId, { role: "user", content: "steer", parentMessageId: u1.id });
    const turnB = await createMessage(convId, { role: "assistant", content: "B", parentMessageId: u1.id });

    // Before reconciliation the assistant branch (u1 → B) excludes the steer.
    expect((await getConversationPath(turnB.id, convId)).map((m) => m.content)).toEqual(["u1", "B"]);

    // Delivery reconciliation re-parents the steer onto the injection leaf (B),
    // then the next turn (C) parents onto the steer.
    await reparentMessage(convId, steerU.id, turnB.id);
    const turnC = await createMessage(convId, { role: "assistant", content: "C", parentMessageId: steerU.id });

    // The next run's loadHistory walks from the leaf and rebuilds EXACTLY the
    // sequence the LLM saw: u1 → B → steer → C.
    expect((await getConversationPath(turnC.id, convId)).map((m) => m.content)).toEqual([
      "u1",
      "B",
      "steer",
      "C",
    ]);
  });

  test("re-parent to null re-roots the row", async () => {
    const u1 = await createMessage(convId, { role: "user", content: "u1" });
    const a1 = await createMessage(convId, { role: "assistant", content: "a1", parentMessageId: u1.id });

    const updated = await reparentMessage(convId, a1.id, null);
    expect(updated!.parentMessageId).toBeNull();
    // Path from a1 is now just itself (it re-rooted).
    expect((await getConversationPath(a1.id, convId)).map((m) => m.id)).toEqual([a1.id]);
  });

  test("returns null for an unknown messageId", async () => {
    const u1 = await createMessage(convId, { role: "user", content: "u1" });
    const res = await reparentMessage(convId, "does-not-exist", u1.id);
    expect(res).toBeNull();
  });

  test("conversation-scoped: a stranger id from another conversation is not moved", async () => {
    const u1 = await createMessage(convId, { role: "user", content: "u1" });
    const otherConv = await createConversation(projectId, { title: "other" });
    const stranger = await createMessage(otherConv.id, { role: "user", content: "x" });

    const res = await reparentMessage(convId, stranger.id, u1.id);
    expect(res).toBeNull();
    // The stranger row keeps its original (null) parent.
    const strangerRow = (await getMessages(otherConv.id)).find((m) => m.id === stranger.id)!;
    expect(strangerRow.parentMessageId).toBeNull();
  });
});
