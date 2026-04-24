/**
 * Server-handler unit tests for
 * /api/conversations/[id]/agent-chat (+server.ts).
 *
 * Covers auth (401), content validation (400), sub-conversation
 * existence (404), non-sub-conversation rejection (400), and the
 * ownership gate (404 when caller doesn't own the root conv).
 *
 * We mock the conversations query module + the runtime context so
 * nothing touches PGlite or the real executor. The conversations
 * module is WIP — the mock pins the contract at the import boundary.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const getConversation = vi.fn();
const getLatestLeaf = vi.fn();
const createMessage = vi.fn();
const getActiveRunForConversation = vi.fn();
const streamChat = vi.fn(() => Promise.resolve());
const busEmit = vi.fn();
const getAgentConfig = vi.fn();

vi.mock("$server/db/queries/conversations", () => ({
  getConversation,
  getLatestLeaf,
  createMessage,
}));

vi.mock("$server/db/queries/agent-configs", () => ({
  getAgentConfig,
}));

vi.mock("$lib/server/context", () => ({
  getExecutor: () => ({
    getActiveRunForConversation,
    streamChat,
  }),
  getBus: () => ({ emit: busEmit }),
}));

vi.mock("$server/runtime/pending-messages", () => ({
  enqueue: vi.fn(),
}));

vi.mock("$lib/server/command-resolver", () => ({
  buildCommandResolver: () => async () => null,
}));

const { POST } = await import(
  "../routes/api/conversations/[id]/agent-chat/+server.ts"
);

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
}) {
  return {
    url: new URL("http://localhost/api/conversations/sub-1/agent-chat"),
    locals: opts.locals ?? {},
    params: { id: "sub-1" },
    request: new Request("http://localhost/api/conversations/sub-1/agent-chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  } as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

describe("POST /api/conversations/[id]/agent-chat", () => {
  beforeEach(() => {
    getConversation.mockReset();
    getLatestLeaf.mockReset();
    createMessage.mockReset();
    getActiveRunForConversation.mockReset();
    streamChat.mockReset();
    streamChat.mockReturnValue(Promise.resolve());
    busEmit.mockReset();
    getAgentConfig.mockReset();
  });

  test("rejects 401 when unauthenticated", async () => {
    let res: Response | undefined;
    try {
      await POST(makeEvent({ body: { content: "hi" } }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("rejects 400 when content is missing", async () => {
    const res = await POST(makeEvent({ locals: { user }, body: {} }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("content is required");
  });

  test("rejects 400 when content is whitespace-only", async () => {
    const res = await POST(
      makeEvent({ locals: { user }, body: { content: "   " } }),
    );
    expect(res.status).toBe(400);
  });

  test("returns 404 when sub-conversation does not exist", async () => {
    getConversation.mockResolvedValue(null);
    const res = await POST(
      makeEvent({ locals: { user }, body: { content: "hi" } }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Not found");
  });

  test("rejects 400 when conversation is not a sub-conversation", async () => {
    getConversation.mockResolvedValue({
      id: "sub-1",
      parentConversationId: null,
      userId: "u1",
    });
    const res = await POST(
      makeEvent({ locals: { user }, body: { content: "hi" } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Not a sub-conversation");
  });

  test("returns 404 when direct parent cannot be found", async () => {
    getConversation.mockImplementation(async (id: string) => {
      if (id === "sub-1") {
        return { id: "sub-1", parentConversationId: "parent-1", userId: null };
      }
      return null;
    });
    const res = await POST(
      makeEvent({ locals: { user }, body: { content: "hi" } }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Parent not found");
  });

  test("ownership gate: non-owner non-admin gets 404", async () => {
    getConversation.mockImplementation(async (id: string) => {
      if (id === "sub-1")
        return { id: "sub-1", parentConversationId: "parent-1", userId: null };
      if (id === "parent-1")
        return {
          id: "parent-1",
          parentConversationId: null,
          userId: "someone-else",
        };
      return null;
    });
    const res = await POST(
      makeEvent({ locals: { user }, body: { content: "hi" } }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Not found");
  });
});
