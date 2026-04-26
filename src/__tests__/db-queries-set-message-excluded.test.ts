/**
 * DB-level coverage for `setMessageExcluded` and the storage-layer guarantee
 * that excluded messages still come back from the message-loading queries.
 *
 * The runtime filter that drops them from the LLM context lives in
 * `loadHistory` (covered separately in load-history-image-rehydrate.test.ts).
 * The queries here exist purely so the UI can keep rendering excluded rows
 * struck-through and toggle them back on, so this file's contract is:
 *   - the flag round-trips
 *   - the flag is reversible
 *   - getMessages + getConversationPath KEEP returning excluded rows
 *   - toggling does NOT bump conversations.updatedAt (it would noisily
 *     reorder the conversation list on every click)
 *   - unknown ids return null instead of throwing
 *   - cross-conversation isolation: excluding from conv A doesn't touch conv B
 */

import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const {
  createConversation,
  createMessage,
  getMessages,
  getConversation,
  getConversationPath,
  setMessageExcluded,
  updateMessageContent,
} = await import("../db/queries/conversations");
const { createProject } = await import("../db/queries/projects");

describe("setMessageExcluded", () => {
  let projectId: string;
  let convId: string;
  let leafId: string;
  let m1Id: string;
  let m2Id: string;
  let m3Id: string;

  beforeEach(async () => {
    await setupTestDb();
    const p = await createProject({ name: "Excl", path: "/tmp/excl" });
    projectId = p.id;
    const c = await createConversation(projectId, { title: "t" });
    convId = c.id;
    // 3-turn linear chain: u1 → a1 → u2
    const m1 = await createMessage(convId, { role: "user", content: "u1" });
    const m2 = await createMessage(convId, { role: "assistant", content: "a1", parentMessageId: m1.id });
    const m3 = await createMessage(convId, { role: "user", content: "u2", parentMessageId: m2.id });
    m1Id = m1.id;
    m2Id = m2.id;
    m3Id = m3.id;
    leafId = m3.id;
  });
  afterAll(async () => await closeTestDb());

  test("fresh messages default to excluded=false", async () => {
    const msgs = await getMessages(convId);
    expect(msgs).toHaveLength(3);
    for (const m of msgs) expect(m.excluded).toBe(false);
  });

  test("flips the flag on and returns the updated row", async () => {
    const updated = await setMessageExcluded(convId, m2Id, true);
    expect(updated).not.toBeNull();
    expect(updated!.id).toBe(m2Id);
    expect(updated!.excluded).toBe(true);
    // Re-read from another query to confirm the write hit disk, not just
    // the returned-row builder.
    const msgs = await getMessages(convId);
    const row = msgs.find((m) => m.id === m2Id)!;
    expect(row.excluded).toBe(true);
  });

  test("flag round-trips (true → false)", async () => {
    await setMessageExcluded(convId, m2Id, true);
    const off = await setMessageExcluded(convId, m2Id, false);
    expect(off!.excluded).toBe(false);
    const msgs = await getMessages(convId);
    expect(msgs.find((m) => m.id === m2Id)!.excluded).toBe(false);
  });

  test("getMessages STILL returns excluded rows (storage layer doesn't filter)", async () => {
    // Storage-layer non-filtering is the load-bearing invariant: if this
    // query started filtering, the UI would lose its ability to render +
    // un-toggle excluded turns. Failing here means the filter slipped from
    // loadHistory into the DB layer.
    await setMessageExcluded(convId, m2Id, true);
    const msgs = await getMessages(convId);
    expect(msgs).toHaveLength(3);
    expect(msgs.map((m) => m.id).sort()).toEqual([m1Id, m2Id, m3Id].sort());
  });

  test("getConversationPath STILL returns excluded rows in the chain", async () => {
    // Same invariant for the recursive-CTE leaf-walker — branch navigation
    // in the UI walks this query, and an excluded turn must remain in the
    // visible chain.
    await setMessageExcluded(convId, m2Id, true);
    const path = await getConversationPath(leafId, convId);
    expect(path.map((m) => m.id)).toEqual([m1Id, m2Id, m3Id]);
    expect(path.find((m) => m.id === m2Id)!.excluded).toBe(true);
  });

  test("does NOT bump conversations.updatedAt", async () => {
    // Toggling exclusion is metadata-only; bumping updatedAt would re-sort
    // the conversation list on every click, which is the opposite of the
    // "lightweight, ambient" UX this feature is supposed to deliver.
    const before = (await getConversation(convId))!.updatedAt;
    // Wait a tick so any (incorrect) NOW() bump would observably differ.
    await new Promise((r) => setTimeout(r, 20));
    await setMessageExcluded(convId, m2Id, true);
    const after = (await getConversation(convId))!.updatedAt;
    expect(after.getTime()).toBe(before.getTime());
  });

  test("contrast: updateMessageContent DOES bump conversations.updatedAt", async () => {
    // Pinned as a regression guard so a future refactor can't accidentally
    // make excluded toggles "consistent" with content edits and lose the
    // no-bump property above.
    const before = (await getConversation(convId))!.updatedAt;
    await new Promise((r) => setTimeout(r, 20));
    await updateMessageContent(convId, m2Id, "edited content");
    const after = (await getConversation(convId))!.updatedAt;
    expect(after.getTime()).toBeGreaterThan(before.getTime());
  });

  test("returns null for unknown messageId", async () => {
    const res = await setMessageExcluded(convId, "does-not-exist", true);
    expect(res).toBeNull();
  });

  test("returns null when messageId belongs to a different conversation", async () => {
    // Cross-conversation safety: the WHERE clause uses BOTH conversationId
    // AND messageId, so a leaked id from another conversation can't flip
    // the wrong row.
    const otherConv = await createConversation(projectId, { title: "other" });
    const stranger = await createMessage(otherConv.id, { role: "user", content: "x" });
    const res = await setMessageExcluded(convId, stranger.id, true);
    expect(res).toBeNull();
    // And the stranger row must still be excluded=false.
    const otherMsgs = await getMessages(otherConv.id);
    expect(otherMsgs.find((m) => m.id === stranger.id)!.excluded).toBe(false);
  });

  test("excluding in conv A leaves conv B's same-content message untouched", async () => {
    const otherConv = await createConversation(projectId, { title: "other" });
    const otherMsg = await createMessage(otherConv.id, { role: "assistant", content: "a1" });
    await setMessageExcluded(convId, m2Id, true);
    const otherMsgs = await getMessages(otherConv.id);
    expect(otherMsgs.find((m) => m.id === otherMsg.id)!.excluded).toBe(false);
  });
});
