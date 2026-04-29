/**
 * HTTP route tests for `POST /api/conversations/:id/clone-turns` — the
 * select-mode-fork endpoint wired to `cloneTurnsIntoNewConversation`.
 *
 * The underlying DB helper is already covered by
 * `conversations-clone-turns.test.ts`; this file stubs the query module so it
 * focuses narrowly on auth / ownership / validation / error mapping.
 */

import { test, expect, describe, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mockServerAlias, createMockEvent, jsonFromResponse, ADMIN_USER, MEMBER_USER } from "./helpers/mock-request";

mockServerAlias();

mock.module("../../web/src/routes/api/conversations/[id]/clone-turns/$types", () => ({}));
mock.module("$lib/server/security/validation", () =>
  require("../../web/src/lib/server/security/validation"),
);
mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => null,
}));

// ── Mocked conversations query module ────────────────────────────
type MockConv = { id: string; userId: string; projectId: string; title: string; model: string | null; provider: string | null; forkedFromConversationId?: string | null; forkedFromMessageId?: string | null };

let mockSourceConv: MockConv | null = null;
let mockCloneError: Error | null = null;
let mockCloneResult: { conversation: MockConv; messageIdMap: Map<string, string> } | null = null;
let capturedCloneArgs: { sourceConvId: string; messageIds: string[]; opts: { userId?: string | null; title?: string } } | null = null;

const convQueriesMock = () => ({
  getConversation: async (_id: string) => mockSourceConv,
  cloneTurnsIntoNewConversation: async (
    sourceConvId: string,
    messageIds: string[],
    opts: { userId?: string | null; title?: string },
  ) => {
    capturedCloneArgs = { sourceConvId, messageIds, opts };
    if (mockCloneError) throw mockCloneError;
    if (!mockCloneResult) throw new Error("mockCloneResult not set");
    return mockCloneResult;
  },
});

mock.module("$server/db/queries/conversations", convQueriesMock);
mock.module("../db/queries/conversations", convQueriesMock);

// ── Handler under test ───────────────────────────────────────────
import { POST as clonePost } from "../../web/src/routes/api/conversations/[id]/clone-turns/+server";

afterAll(() => {
  restoreModuleMocks();
});

beforeEach(() => {
  mockSourceConv = {
    id: "conv-source",
    userId: MEMBER_USER.id,
    projectId: "proj-1",
    title: "Source chat",
    model: "claude-sonnet-4-6",
    provider: "anthropic",
  };
  mockCloneError = null;
  mockCloneResult = {
    conversation: {
      id: "conv-new",
      userId: MEMBER_USER.id,
      projectId: "proj-1",
      title: "Forked: Source chat",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      forkedFromConversationId: "conv-source",
      forkedFromMessageId: "11111111-1111-4111-8111-111111111111",
    },
    messageIdMap: new Map<string, string>(),
  };
  capturedCloneArgs = null;
});

describe("POST /api/conversations/[id]/clone-turns", () => {
  test("clones turns for the conversation owner and returns the new conversation", async () => {
    const messageId = "11111111-1111-4111-8111-111111111111";
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/conversations/conv-source/clone-turns",
      body: { messageIds: [messageId] },
      params: { id: "conv-source" },
      user: MEMBER_USER,
    });

    const res = await clonePost(event);
    expect(res.status).toBe(201);
    const data = await jsonFromResponse(res);
    expect(data.id).toBe("conv-new");
    expect(data.title).toBe("Forked: Source chat");

    expect(capturedCloneArgs).not.toBeNull();
    expect(capturedCloneArgs!.sourceConvId).toBe("conv-source");
    expect(capturedCloneArgs!.messageIds).toEqual([messageId]);
    expect(capturedCloneArgs!.opts.userId).toBe(MEMBER_USER.id);

    // Fork-link fields are persisted by the helper and round-trip through the route.
    expect(data.forkedFromConversationId).toBe("conv-source");
    expect(data.forkedFromMessageId).toBe(messageId);
  });

  test("returns 404 when caller is not the conversation owner", async () => {
    mockSourceConv = { ...mockSourceConv!, userId: "someone-else" };
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/conversations/conv-source/clone-turns",
      body: { messageIds: ["11111111-1111-4111-8111-111111111111"] },
      params: { id: "conv-source" },
      user: MEMBER_USER,
    });
    const res = await clonePost(event);
    expect(res.status).toBe(404);
  });

  test("admin can fork conversations owned by other users", async () => {
    mockSourceConv = { ...mockSourceConv!, userId: "someone-else" };
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/conversations/conv-source/clone-turns",
      body: { messageIds: ["11111111-1111-4111-8111-111111111111"] },
      params: { id: "conv-source" },
      user: ADMIN_USER,
    });
    const res = await clonePost(event);
    expect(res.status).toBe(201);
  });

  test("returns 404 when the source conversation does not exist", async () => {
    mockSourceConv = null;
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/conversations/conv-source/clone-turns",
      body: { messageIds: ["11111111-1111-4111-8111-111111111111"] },
      params: { id: "conv-source" },
      user: MEMBER_USER,
    });
    const res = await clonePost(event);
    expect(res.status).toBe(404);
  });

  test("rejects empty messageIds with 400", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/conversations/conv-source/clone-turns",
      body: { messageIds: [] },
      params: { id: "conv-source" },
      user: MEMBER_USER,
    });
    const res = await clonePost(event);
    expect(res.status).toBe(400);
  });

  test("rejects non-uuid messageIds with 400", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/conversations/conv-source/clone-turns",
      body: { messageIds: ["not-a-uuid"] },
      params: { id: "conv-source" },
      user: MEMBER_USER,
    });
    const res = await clonePost(event);
    expect(res.status).toBe(400);
  });

  test("maps 'do not belong' errors from the DB helper to 400", async () => {
    mockCloneError = new Error("One or more messageIds do not belong to the source conversation");
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/conversations/conv-source/clone-turns",
      body: { messageIds: ["11111111-1111-4111-8111-111111111111"] },
      params: { id: "conv-source" },
      user: MEMBER_USER,
    });
    const res = await clonePost(event);
    expect(res.status).toBe(400);
    const data = await jsonFromResponse(res);
    expect(data.error).toMatch(/do not belong/);
  });

  test("maps unexpected errors from the DB helper to 500", async () => {
    mockCloneError = new Error("database down");
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/conversations/conv-source/clone-turns",
      body: { messageIds: ["11111111-1111-4111-8111-111111111111"] },
      params: { id: "conv-source" },
      user: MEMBER_USER,
    });
    const res = await clonePost(event);
    expect(res.status).toBe(500);
  });

  test("forwards custom title to the clone helper", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/conversations/conv-source/clone-turns",
      body: { messageIds: ["11111111-1111-4111-8111-111111111111"], title: "Test title" },
      params: { id: "conv-source" },
      user: MEMBER_USER,
    });
    await clonePost(event);
    expect(capturedCloneArgs!.opts.title).toBe("Test title");
  });
});
