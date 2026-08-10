/**
 * Integration guard for the phantom-branch bug.
 *
 * `recordCapabilityCall` persists a `capability-event` row WITHOUT a
 * `parentMessageId` (see recordCapabilityCall.ts ≈L209) — i.e. a root-level
 * synthetic row. `getMessages` (the source for the chat's `?all=true` load)
 * returns ALL rows including these. So the message list the frontend
 * receives for a brand-new chat contains TWO null-parent rows: the first
 * user message AND the capability-event.
 *
 * That coexistence is exactly what used to make `buildSiblingMap` group both
 * under `__root__` and render a phantom `‹ 1/2 ›` branch switcher on a chat
 * that was never branched. This test pins the data contract end-to-end
 * (real PGlite + real recordCapabilityCall + real getMessages) so the
 * frontend's `role !== "capability-event"` filter has a verified shape to
 * defend against. The complementary frontend proof lives in
 * `web/.../load-messages.test.ts` (buildSiblingMap) and the LLM-history
 * side in `load-history-capability-event-filter.test.ts`.
 */

import { test, expect, beforeAll, afterAll, mock } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

const { recordCapabilityCall } = await import("../extensions/recordCapabilityCall");
const { createExtension } = await import("../db/queries/extensions");
const { createUser } = await import("../db/queries/users");
const { createProject } = await import("../db/queries/projects");
const { createConversation, createMessage, getMessages } = await import(
  "../db/queries/conversations"
);

let userId = "";
let conversationId = "";
let extensionId = "";

beforeAll(async () => {
  await setupTestDb();
  const u = await createUser({
    email: "cap-sibling@test.com",
    passwordHash: "h",
    name: "CAP-SIB",
  });
  userId = u.id;
  const p = await createProject({ name: "cap-sib-proj", path: "/tmp/cap-sib" });
  const conv = await createConversation(p.id, { userId });
  conversationId = conv.id;

  const ext = await createExtension({
    name: "cap-sibling-ext",
    version: "1.0.0",
    description: "",
    manifest: {
      schemaVersion: 2 as const,
      name: "cap-sibling-ext",
      version: "1.0.0",
      description: "",
      author: { name: "tester" },
      permissions: {},
    },
    source: "local:/tmp/x",
    installPath: "/tmp/x",
    enabled: true,
    grantedPermissions: { grantedAt: {} } as any,
    checksumVerified: false,
    consecutiveFailures: 0,
  } as any);
  extensionId = ext.id;
});

afterAll(async () => {
  await closeTestDb();
  mock.restore();
});

test("recordCapabilityCall persists a root-level (null-parent) capability-event", async () => {
  // A brand-new chat: one user turn + its assistant reply.
  const u1 = await createMessage(conversationId, {
    role: "user",
    content: "first question",
  });
  await createMessage(conversationId, {
    role: "assistant",
    content: "first answer",
    parentMessageId: u1.id,
  });

  // The turn fires a capability call (the production path that creates
  // the offending null-parent row).
  await recordCapabilityCall({
    ctx: {
      actorExtensionId: extensionId,
      onBehalfOf: userId,
      conversationId,
      runId: "r-cap-sib",
      parentCallId: null,
    },
    capability: "llm",
    action: "complete",
    success: true,
    durationMs: 10,
    costUsd: 0.001,
    model: "gpt-4o-mini",
  });

  const rows = await getMessages(conversationId);

  // getMessages returns the capability-event alongside the real turns.
  expect(rows.map((m) => m.role).sort()).toEqual(["assistant", "capability-event", "user"]);

  // The capability-event is root-level — null parentMessageId.
  const cap = rows.find((m) => m.role === "capability-event");
  expect(cap).toBeTruthy();
  expect(cap!.parentMessageId).toBeNull();

  // THE BUG PRECONDITION: two distinct null-parent rows reach the client
  // (the user message + the capability-event). The frontend sibling-map
  // MUST exclude capability-event rows or it renders a phantom branch.
  const rootRows = rows.filter((m) => m.parentMessageId === null);
  expect(rootRows.map((m) => m.role).sort()).toEqual(["capability-event", "user"]);
  // Real conversational root nodes (what buildSiblingMap should count):
  // exactly one — the user message. No genuine branch exists.
  const treeRootRows = rootRows.filter((m) => m.role !== "capability-event");
  expect(treeRootRows).toHaveLength(1);
  expect(treeRootRows[0]!.role).toBe("user");
});
