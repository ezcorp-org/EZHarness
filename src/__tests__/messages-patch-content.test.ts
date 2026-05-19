/**
 * HTTP route tests for `PATCH /api/conversations/:id/messages/:mid` — the
 * content-only edit endpoint that backs the "Edit text" affordance on
 * assistant turns (seeded into cloned chats via select-mode).
 */

import { test, expect, describe, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mockServerAlias, createMockEvent, jsonFromResponse, ADMIN_USER, MEMBER_USER } from "./helpers/mock-request";

mockServerAlias();

mock.module("../../web/src/routes/api/conversations/[id]/messages/[mid]/$types", () => ({}));
mock.module("$lib/server/security/validation", () =>
  require("../../web/src/lib/server/security/validation"),
);
mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => null,
}));

type MockConv = { id: string; userId: string };
type MockMessage = {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  parentMessageId: string | null;
  runId: string | null;
  excluded?: boolean;
};

let mockSourceConv: MockConv | null = null;
let mockUpdatedMessage: MockMessage | null = null;
let mockActiveRun: { id: string; conversationId: string } | null = null;
let capturedUpdate: { conversationId: string; messageId: string; content: string } | null = null;
let capturedExcluded:
  | { conversationId: string; messageId: string; excluded: boolean }
  | null = null;

const convQueriesMock = () => ({
  getConversation: async (_id: string) => mockSourceConv,
  updateMessageContent: async (conversationId: string, messageId: string, content: string) => {
    capturedUpdate = { conversationId, messageId, content };
    return mockUpdatedMessage;
  },
  // Locked-in regression for the PATCH excluded branch — the route imports
  // `convQueries.setMessageExcluded`, so the mock has to expose it. A
  // missing export here previously fell through to `undefined(...)` →
  // TypeError → 500 in production for every strike-through click.
  setMessageExcluded: async (conversationId: string, messageId: string, excluded: boolean) => {
    capturedExcluded = { conversationId, messageId, excluded };
    return mockUpdatedMessage;
  },
});

const activeRunsMock = () => ({
  getActiveRun: async (_id: string) => mockActiveRun,
});

mock.module("$server/db/queries/conversations", convQueriesMock);
mock.module("../db/queries/conversations", convQueriesMock);
mock.module("$server/db/queries/active-runs", activeRunsMock);
mock.module("../db/queries/active-runs", activeRunsMock);

import { PATCH as patchMessage } from "../../web/src/routes/api/conversations/[id]/messages/[mid]/+server";

afterAll(() => {
  restoreModuleMocks();
});

beforeEach(() => {
  mockSourceConv = { id: "conv-1", userId: MEMBER_USER.id };
  mockActiveRun = null;
  mockUpdatedMessage = {
    id: "msg-1",
    conversationId: "conv-1",
    role: "assistant",
    content: "Edited text.",
    parentMessageId: null,
    runId: null,
    excluded: false,
  };
  capturedUpdate = null;
  capturedExcluded = null;
});

describe("PATCH /api/conversations/[id]/messages/[mid]", () => {
  test("updates content for the conversation owner", async () => {
    const event = createMockEvent({
      method: "PATCH",
      url: "http://localhost/api/conversations/conv-1/messages/msg-1",
      body: { content: "Edited text." },
      params: { id: "conv-1", mid: "msg-1" },
      user: MEMBER_USER,
    });
    const res = await patchMessage(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.content).toBe("Edited text.");
    expect(capturedUpdate).toEqual({ conversationId: "conv-1", messageId: "msg-1", content: "Edited text." });
  });

  test("returns 404 when caller does not own the conversation", async () => {
    mockSourceConv = { id: "conv-1", userId: "someone-else" };
    const event = createMockEvent({
      method: "PATCH",
      url: "http://localhost/api/conversations/conv-1/messages/msg-1",
      body: { content: "x" },
      params: { id: "conv-1", mid: "msg-1" },
      user: MEMBER_USER,
    });
    const res = await patchMessage(event);
    expect(res.status).toBe(404);
  });

  test("admin may edit any conversation's messages", async () => {
    mockSourceConv = { id: "conv-1", userId: "someone-else" };
    const event = createMockEvent({
      method: "PATCH",
      url: "http://localhost/api/conversations/conv-1/messages/msg-1",
      body: { content: "x" },
      params: { id: "conv-1", mid: "msg-1" },
      user: ADMIN_USER,
    });
    const res = await patchMessage(event);
    expect(res.status).toBe(200);
  });

  test("returns 404 when conversation does not exist", async () => {
    mockSourceConv = null;
    const event = createMockEvent({
      method: "PATCH",
      url: "http://localhost/api/conversations/conv-1/messages/msg-1",
      body: { content: "x" },
      params: { id: "conv-1", mid: "msg-1" },
      user: MEMBER_USER,
    });
    const res = await patchMessage(event);
    expect(res.status).toBe(404);
  });

  test("returns 409 when the conversation has an active run", async () => {
    mockActiveRun = { id: "run-1", conversationId: "conv-1" };
    const event = createMockEvent({
      method: "PATCH",
      url: "http://localhost/api/conversations/conv-1/messages/msg-1",
      body: { content: "x" },
      params: { id: "conv-1", mid: "msg-1" },
      user: MEMBER_USER,
    });
    const res = await patchMessage(event);
    expect(res.status).toBe(409);
  });

  test("returns 400 when content is empty", async () => {
    const event = createMockEvent({
      method: "PATCH",
      url: "http://localhost/api/conversations/conv-1/messages/msg-1",
      body: { content: "" },
      params: { id: "conv-1", mid: "msg-1" },
      user: MEMBER_USER,
    });
    const res = await patchMessage(event);
    expect(res.status).toBe(400);
  });

  test("returns 404 when the target message is not in the conversation", async () => {
    mockUpdatedMessage = null; // simulate DB helper returning null (no row matched)
    const event = createMockEvent({
      method: "PATCH",
      url: "http://localhost/api/conversations/conv-1/messages/msg-nonexistent",
      body: { content: "x" },
      params: { id: "conv-1", mid: "msg-nonexistent" },
      user: MEMBER_USER,
    });
    const res = await patchMessage(event);
    expect(res.status).toBe(404);
  });

  // ── Excluded branch ──────────────────────────────────────────────────
  // These cases lock in the strike-through "exclude from LLM context"
  // wire path that previously 500'd because the route imported a
  // non-existent `convQueries.setMessageExcluded`. Each test asserts the
  // 200 status AND that the route routed to the excluded helper (not the
  // content helper) — a regression that swapped helpers would still hit
  // 200 here but flip the wrong DB column, and `capturedExcluded` is the
  // only signal that catches that.
  test("PATCH {excluded: true} routes to setMessageExcluded and returns 200", async () => {
    mockUpdatedMessage = { ...mockUpdatedMessage!, excluded: true };
    const event = createMockEvent({
      method: "PATCH",
      url: "http://localhost/api/conversations/conv-1/messages/msg-1",
      body: { excluded: true },
      params: { id: "conv-1", mid: "msg-1" },
      user: MEMBER_USER,
    });
    const res = await patchMessage(event);
    expect(res.status).toBe(200);
    const data = await jsonFromResponse(res);
    expect(data.excluded).toBe(true);
    expect(capturedExcluded).toEqual({ conversationId: "conv-1", messageId: "msg-1", excluded: true });
    // Belt + suspenders: the content helper must NOT have been called.
    expect(capturedUpdate).toBeNull();
  });

  test("PATCH {excluded: false} routes to setMessageExcluded with the false flag", async () => {
    mockUpdatedMessage = { ...mockUpdatedMessage!, excluded: false };
    const event = createMockEvent({
      method: "PATCH",
      url: "http://localhost/api/conversations/conv-1/messages/msg-1",
      body: { excluded: false },
      params: { id: "conv-1", mid: "msg-1" },
      user: MEMBER_USER,
    });
    const res = await patchMessage(event);
    expect(res.status).toBe(200);
    expect(capturedExcluded).toEqual({ conversationId: "conv-1", messageId: "msg-1", excluded: false });
  });

  test("PATCH {excluded: true} returns 404 when the message is not found", async () => {
    mockUpdatedMessage = null;
    const event = createMockEvent({
      method: "PATCH",
      url: "http://localhost/api/conversations/conv-1/messages/msg-missing",
      body: { excluded: true },
      params: { id: "conv-1", mid: "msg-missing" },
      user: MEMBER_USER,
    });
    const res = await patchMessage(event);
    expect(res.status).toBe(404);
  });

  test("PATCH {excluded: true} is rejected with 409 while a run is streaming", async () => {
    mockActiveRun = { id: "run-1", conversationId: "conv-1" };
    const event = createMockEvent({
      method: "PATCH",
      url: "http://localhost/api/conversations/conv-1/messages/msg-1",
      body: { excluded: true },
      params: { id: "conv-1", mid: "msg-1" },
      user: MEMBER_USER,
    });
    const res = await patchMessage(event);
    expect(res.status).toBe(409);
    expect(capturedExcluded).toBeNull();
  });

  test("ambiguous payload {content, excluded} is rejected with 400 (XOR refine)", async () => {
    const event = createMockEvent({
      method: "PATCH",
      url: "http://localhost/api/conversations/conv-1/messages/msg-1",
      body: { content: "x", excluded: true },
      params: { id: "conv-1", mid: "msg-1" },
      user: MEMBER_USER,
    });
    const res = await patchMessage(event);
    expect(res.status).toBe(400);
    expect(capturedExcluded).toBeNull();
    expect(capturedUpdate).toBeNull();
  });
});
