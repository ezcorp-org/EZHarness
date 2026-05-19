/**
 * Integration coverage for `getLatestLeaf`'s `excludeCapabilityEvents`
 * mode — the parent-resolution default added for the "random side
 * threads" fix.
 *
 * Why this test exists: when the chat composer re-enables the instant a
 * stream ends but before `reconcileAfterStream` repoints `activeLeafId`
 * off the `streaming-<runId>` placeholder, the client now sends no
 * parent and the server anchors the turn to `getLatestLeaf(convId,
 * { excludeCapabilityEvents: true })`. For that to keep the thread
 * linear, the leaf lookup must treat `capability-event` rows as
 * transparent (skip them as candidates AND ignore them when deciding
 * whether their parent still has children) — mirroring the client's
 * `computeLatestLeaf`. Filtering only the outer query would make an
 * assistant turn with a trailing capability-event child resolve to
 * NULL → a root-level branch → exactly the bug, reintroduced after any
 * auto-allowed tool run.
 *
 * Default mode is asserted unchanged so the GET conversation-path
 * caller keeps its existing behavior (zero blast radius).
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { tmpdir } from "node:os";

mockDbConnection();

const { createUser } = await import("../db/queries/users");
const { createProject } = await import("../db/queries/projects");
const { createConversation, createMessage, getLatestLeaf } = await import(
  "../db/queries/conversations"
);

const SAFE_CWD = tmpdir();

let userId = "";
let projectId = "";

beforeAll(async () => {
  await setupTestDb();
  const u = await createUser({
    email: "getlatestleaf-capevent@test.com",
    passwordHash: "h",
    name: "GLL-CAP",
  });
  userId = u.id;
  const p = await createProject({ name: "p", path: "/tmp" });
  projectId = p.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
  process.chdir(SAFE_CWD);
});

const CAP_PAYLOAD = JSON.stringify({
  __ezcorp_capability_event: true,
  sdkCapabilityCallId: "c-x",
  capability: "llm",
  action: "complete",
});

describe("getLatestLeaf — excludeCapabilityEvents", () => {
  test("default mode is unchanged: a trailing capability-event IS the latest leaf", async () => {
    const conv = await createConversation(projectId, { userId });
    const u1 = await createMessage(conv.id, { role: "user", content: "q" });
    const a1 = await createMessage(conv.id, {
      role: "assistant",
      content: "a",
      parentMessageId: u1.id,
    });
    const cap = await createMessage(conv.id, {
      role: "capability-event",
      content: CAP_PAYLOAD,
      parentMessageId: a1.id,
    });

    const leaf = await getLatestLeaf(conv.id);
    expect(leaf?.id).toBe(cap.id);
  });

  test("excludeCapabilityEvents: resolves to the assistant turn, not the capability-event, not null", async () => {
    const conv = await createConversation(projectId, { userId });
    const u1 = await createMessage(conv.id, { role: "user", content: "q" });
    const a1 = await createMessage(conv.id, {
      role: "assistant",
      content: "a",
      parentMessageId: u1.id,
    });
    await createMessage(conv.id, {
      role: "capability-event",
      content: CAP_PAYLOAD,
      parentMessageId: a1.id,
    });

    const leaf = await getLatestLeaf(conv.id, {
      excludeCapabilityEvents: true,
    });
    // The whole point: the next user turn parents off the assistant
    // reply, NOT the inline capability annotation, and NOT root.
    expect(leaf?.id).toBe(a1.id);
    expect(leaf?.role).toBe("assistant");
  });

  test("excludeCapabilityEvents: transparent through multiple consecutive capability-events", async () => {
    const conv = await createConversation(projectId, { userId });
    const u1 = await createMessage(conv.id, { role: "user", content: "go" });
    const a1 = await createMessage(conv.id, {
      role: "assistant",
      content: "reply",
      parentMessageId: u1.id,
    });
    const c1 = await createMessage(conv.id, {
      role: "capability-event",
      content: CAP_PAYLOAD,
      parentMessageId: a1.id,
    });
    await createMessage(conv.id, {
      role: "capability-event",
      content: CAP_PAYLOAD,
      parentMessageId: c1.id,
    });

    const leaf = await getLatestLeaf(conv.id, {
      excludeCapabilityEvents: true,
    });
    expect(leaf?.id).toBe(a1.id);
  });

  test("excludeCapabilityEvents: normal linear thread resolves to the last turn", async () => {
    const conv = await createConversation(projectId, { userId });
    const u1 = await createMessage(conv.id, { role: "user", content: "q" });
    const a1 = await createMessage(conv.id, {
      role: "assistant",
      content: "a",
      parentMessageId: u1.id,
    });

    const leaf = await getLatestLeaf(conv.id, {
      excludeCapabilityEvents: true,
    });
    expect(leaf?.id).toBe(a1.id);
  });

  test("empty conversation → null in both modes", async () => {
    const conv = await createConversation(projectId, { userId });
    expect(await getLatestLeaf(conv.id)).toBeNull();
    expect(
      await getLatestLeaf(conv.id, { excludeCapabilityEvents: true }),
    ).toBeNull();
  });
});
