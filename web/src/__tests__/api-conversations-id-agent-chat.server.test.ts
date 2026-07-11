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
const steerConversation = vi.fn();
const streamChat = vi.fn(() => Promise.resolve());
const busEmit = vi.fn();
const getAgentConfig = vi.fn();
const enqueue = vi.fn();

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
    steerConversation,
    streamChat,
  }),
  getBus: () => ({ emit: busEmit }),
}));

vi.mock("$server/runtime/pending-messages", () => ({
  enqueue,
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
    steerConversation.mockReset();
    streamChat.mockReset();
    streamChat.mockReturnValue(Promise.resolve());
    busEmit.mockReset();
    getAgentConfig.mockReset();
    enqueue.mockReset();
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

  // ── Model/provider body override (sub-chat ModelSelector) ────────────
  //
  // The agent sub-chat panel sends `provider` + `model` in the POST body
  // so the user can switch the run's model without leaving the panel.
  // These tests pin the resolution precedence (body > config > parent
  // conv) and the both-or-neither contract.

  describe("body provider/model override (idle run)", () => {
    // Convenience: install the standard "sub-1 (sub of parent-1, root owned)" graph
    function installSubConvGraph(opts: {
      agentConfig?: { provider?: string; model?: string; name?: string; prompt?: string };
      parentConvModel?: { provider?: string; model?: string };
    } = {}) {
      getConversation.mockImplementation(async (id: string) => {
        if (id === "sub-1") {
          return {
            id: "sub-1",
            parentConversationId: "parent-1",
            userId: null,
            agentConfigId: "cfg-1",
            projectId: "proj-1",
            systemPrompt: null,
            model: null,
            provider: null,
          } as any;
        }
        if (id === "parent-1") {
          return {
            id: "parent-1",
            parentConversationId: null,
            userId: user.id,
            projectId: "proj-1",
            agentConfigId: null,
            systemPrompt: null,
            model: opts.parentConvModel?.model ?? null,
            provider: opts.parentConvModel?.provider ?? null,
          } as any;
        }
        return null;
      });
      getLatestLeaf.mockResolvedValue({ id: "leaf-1" });
      createMessage.mockResolvedValue({
        id: "msg-new",
        role: "user",
        content: "hi",
        parentMessageId: "leaf-1",
        createdAt: new Date(),
      });
      getActiveRunForConversation.mockReturnValue(null);
      getAgentConfig.mockResolvedValue(
        opts.agentConfig ?? null,
      );
    }

    test("body provider/model override CURRENT_MODEL_SENTINEL config + parent fallback", async () => {
      installSubConvGraph({
        agentConfig: {
          provider: "__current__",
          model: "__current__",
          name: "Agent",
          prompt: "p",
        },
        parentConvModel: { provider: "anthropic", model: "claude-opus-4-7" },
      });

      const res = await POST(
        makeEvent({
          locals: { user },
          body: { content: "hi", provider: "openai", model: "gpt-5" },
        }),
      );
      expect(res.status).toBe(200);
      expect(streamChat).toHaveBeenCalledTimes(1);
      const opts = (streamChat.mock.calls[0] as unknown as [string, string, { provider?: string; model?: string }])[2];
      expect(opts.provider).toBe("openai");
      expect(opts.model).toBe("gpt-5");
    });

    test("body provider/model override non-sentinel agent-config model", async () => {
      installSubConvGraph({
        agentConfig: {
          provider: "anthropic",
          model: "claude-opus-4-7",
          name: "Agent",
          prompt: "p",
        },
      });

      const res = await POST(
        makeEvent({
          locals: { user },
          body: { content: "hi", provider: "openai", model: "gpt-5" },
        }),
      );
      expect(res.status).toBe(200);
      const opts = (streamChat.mock.calls[0] as unknown as [string, string, { provider?: string; model?: string }])[2];
      expect(opts.provider).toBe("openai");
      expect(opts.model).toBe("gpt-5");
    });

    test("missing body model falls back to existing chain (regression)", async () => {
      installSubConvGraph({
        agentConfig: {
          provider: "__current__",
          model: "__current__",
          name: "Agent",
          prompt: "p",
        },
        parentConvModel: { provider: "anthropic", model: "claude-sonnet" },
      });

      const res = await POST(makeEvent({ locals: { user }, body: { content: "hi" } }));
      expect(res.status).toBe(200);
      const opts = (streamChat.mock.calls[0] as unknown as [string, string, { provider?: string; model?: string }])[2];
      expect(opts.provider).toBe("anthropic");
      expect(opts.model).toBe("claude-sonnet");
    });

    test("partial body (model only) is rejected 400 — both-or-neither", async () => {
      installSubConvGraph();
      const res = await POST(
        makeEvent({
          locals: { user },
          body: { content: "hi", model: "gpt-5" },
        }),
      );
      expect(res.status).toBe(400);
      expect(streamChat).not.toHaveBeenCalled();
    });

    test("partial body (provider only) is rejected 400 — both-or-neither", async () => {
      installSubConvGraph();
      const res = await POST(
        makeEvent({
          locals: { user },
          body: { content: "hi", provider: "openai" },
        }),
      );
      expect(res.status).toBe(400);
      expect(streamChat).not.toHaveBeenCalled();
    });

    test("schema rejects empty-string model — 400", async () => {
      installSubConvGraph();
      const res = await POST(
        makeEvent({
          locals: { user },
          body: { content: "hi", provider: "openai", model: "" },
        }),
      );
      expect(res.status).toBe(400);
      expect(streamChat).not.toHaveBeenCalled();
    });

    test("schema rejects empty-string provider — 400", async () => {
      installSubConvGraph();
      const res = await POST(
        makeEvent({
          locals: { user },
          body: { content: "hi", provider: "", model: "gpt-5" },
        }),
      );
      expect(res.status).toBe(400);
      expect(streamChat).not.toHaveBeenCalled();
    });

    test("subConv.model wins over parent conv fallback when no body override (idle run)", async () => {
      // Pin the new fallback-chain priority: body > subConv > config (or
      // its CURRENT_MODEL_SENTINEL → parent) > parent. The sub-chat
      // picker's PUT writes onto subConv.model/provider, so the very
      // next idle send MUST pick those up — even though parentConv has
      // a different model set. Pre-fix this was a no-op (parentConv
      // always won) and the picker only appeared sticky because the UI
      // re-seeded from the last assistant message.
      getConversation.mockImplementation(async (id: string) => {
        if (id === "sub-1") {
          return {
            id: "sub-1",
            parentConversationId: "parent-1",
            userId: null,
            agentConfigId: "cfg-1",
            projectId: "proj-1",
            systemPrompt: null,
            model: "subconv-model",
            provider: "subconv-provider",
          } as any;
        }
        if (id === "parent-1") {
          return {
            id: "parent-1",
            parentConversationId: null,
            userId: user.id,
            projectId: "proj-1",
            agentConfigId: null,
            systemPrompt: null,
            model: "parent-model",
            provider: "parent-provider",
          } as any;
        }
        return null;
      });
      getLatestLeaf.mockResolvedValue({ id: "leaf-1" });
      createMessage.mockResolvedValue({
        id: "msg-new",
        role: "user",
        content: "hi",
        parentMessageId: "leaf-1",
        createdAt: new Date(),
      });
      getActiveRunForConversation.mockReturnValue(null);
      // Config uses sentinel → would normally fall through to parent.
      // The new sub-conv rung sits ABOVE the config rung, so it wins.
      getAgentConfig.mockResolvedValue({
        provider: "__current__",
        model: "__current__",
        name: "Agent",
        prompt: "p",
      });

      const res = await POST(makeEvent({ locals: { user }, body: { content: "hi" } }));
      expect(res.status).toBe(200);
      const opts = (streamChat.mock.calls[0] as unknown as [string, string, { provider?: string; model?: string }])[2];
      expect(opts.provider).toBe("subconv-provider");
      expect(opts.model).toBe("subconv-model");
    });

    test("active-run path (steered): atomic — steer the live run, do NOT enqueue", async () => {
      installSubConvGraph({
        agentConfig: {
          provider: "anthropic",
          model: "claude-opus-4-7",
          name: "Agent",
          prompt: "p",
        },
      });
      getActiveRunForConversation.mockReturnValue({ id: "run-active" });
      steerConversation.mockReturnValue({ status: "steered", runId: "run-active" });

      const res = await POST(
        makeEvent({
          locals: { user },
          body: { content: "hi", provider: "openai", model: "gpt-5" },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status?: string };
      expect(body.status).toBe("steered");
      // Content is steered verbatim; a fallback re-enqueue callback is passed.
      expect(steerConversation).toHaveBeenCalledWith("sub-1", "hi", expect.any(Function));
      // Atomic: a steered message is NOT also enqueued.
      expect(enqueue).not.toHaveBeenCalled();
      expect(streamChat).not.toHaveBeenCalled();
    });

    test("active-run path (not steered): atomic — enqueue to pending-messages, status queued", async () => {
      installSubConvGraph({
        agentConfig: { provider: "anthropic", model: "claude-opus-4-7", name: "Agent", prompt: "p" },
      });
      getActiveRunForConversation.mockReturnValue({ id: "run-active" });
      // The pre-first-token window / terminal race: steer declined.
      steerConversation.mockReturnValue({ status: "no-agent", runId: "run-active" });

      const res = await POST(makeEvent({ locals: { user }, body: { content: "hi" } }));

      expect(res.status).toBe(200);
      const body = (await res.json()) as { status?: string };
      expect(body.status).toBe("queued");
      // Falls back to today's behavior: enqueue exactly once, no steer delivery.
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(enqueue).toHaveBeenCalledWith("sub-1", expect.objectContaining({ content: "hi" }));
      expect(streamChat).not.toHaveBeenCalled();
    });
  });
});
