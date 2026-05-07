/**
 * Server-handler tests for the EZ Actions hook in
 * `/api/conversations/[id]/messages/+server.ts` POST (Phase 3.3 of EZ
 * Actions v1).
 *
 * Coverage targets (per plan §3.5):
 *   - Action-only message → action handler fires, NO streamChat call,
 *     no assistant turn started, response carries `ezActionResults`
 *     and `runId: null`
 *   - Mixed message → action handler fires AND streamChat is called
 *     (with the original content; the EZ-strip happens inside
 *     build-prompt.ts which is upstream of the executor signature)
 *   - Multiple actions in one message → all fire, all results
 *     persisted in order
 *   - Unknown action name → silent strip (no error message persisted,
 *     no handler invocation, streamChat still fires for the
 *     surrounding text)
 *   - Action handler throw → captured as error result message; flow
 *     continues
 *   - No EZ tokens → behavior unchanged (regression guard)
 *
 * Mock setup mirrors `api-conversations-id-messages.server.test.ts`
 * — every persistence + runtime dep is mocked so this test is a pure
 * handler exercise.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

const getConversation = vi.fn();
const getMessages = vi.fn();
const getLatestLeaf = vi.fn();
const getConversationPath = vi.fn();
const getMessagesWithToolCalls = vi.fn();
const getSubConversationToolCalls = vi.fn();
const createMessage = vi.fn();
const insertAttachment = vi.fn();
const deleteAttachmentsForMessage = vi.fn();
const getProject = vi.fn();
const streamChat = vi.fn(() => ({ catch: () => Promise.resolve() }));
const checkTokenBudget = vi.fn();
const getEzAction = vi.fn();

vi.mock("$server/db/queries/conversations", () => ({
  getConversation,
  getLatestLeaf,
  getConversationPath,
  getMessages,
  getMessagesWithToolCalls,
  getSubConversationToolCalls,
  createMessage,
}));

vi.mock("$server/db/queries/attachments", () => ({
  insertAttachment,
  deleteAttachmentsForMessage,
}));

vi.mock("$server/db/queries/projects", () => ({
  getProject,
}));

vi.mock("$lib/server/context", () => ({
  getExecutor: () => ({ streamChat }),
}));

vi.mock("$lib/server/security/resource-quotas", () => ({
  checkTokenBudget,
}));

vi.mock("$lib/server/command-resolver", () => ({
  buildCommandResolver: () => async () => null,
}));

vi.mock("$server/runtime/ez-actions/registry", () => ({
  getEzAction,
}));

const { POST } = await import(
  "../routes/api/conversations/[id]/messages/+server.ts"
);

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

function makeEvent(opts: { body: { content: string } }) {
  const href = "http://localhost/api/conversations/c1/messages";
  return {
    url: new URL(href),
    locals: { user },
    params: { id: "c1" },
    request: new Request(href, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts.body),
    }),
  } as any;
}

describe("POST messages — EZ action dispatch", () => {
  beforeEach(() => {
    getConversation.mockReset();
    createMessage.mockReset();
    streamChat.mockClear();
    checkTokenBudget.mockReset();
    getEzAction.mockReset();
    // Default: conversation exists, owned by `user`, no token cap hit.
    getConversation.mockResolvedValue({
      id: "c1",
      userId: user.id,
      projectId: "p1",
      provider: "anthropic",
      model: "claude-3",
      agentConfigId: null,
      modeId: null,
    });
    checkTokenBudget.mockResolvedValue({ allowed: true });
    // First createMessage call (user message) → user-msg row.
    // Subsequent calls (EZ result rows) → assigned per-test below.
    createMessage.mockImplementation(async (_cid: string, data: any) => {
      const id = data.role === "user" ? "user-msg-1" : `result-${Math.random().toString(36).slice(2, 8)}`;
      return { id, role: data.role, content: data.content };
    });
  });

  test("action-only message → handler fires, NO streamChat call, runId is null", async () => {
    const handler = vi.fn().mockResolvedValue({
      kind: "success",
      card: {
        title: "Lesson captured",
        body: "abc",
        variant: "success",
      },
      ref: { kind: "lesson", slug: "abc" },
    });
    getEzAction.mockReturnValue({ name: "distill", description: "x", handler });

    const res = await POST(
      makeEvent({ body: { content: "![EZ:distill]" } }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runId: string | null;
      ezActionResults: Array<{ id: string }>;
      userMessage: { id: string };
    };
    expect(body.runId).toBeNull();
    expect(body.ezActionResults).toHaveLength(1);
    expect(handler).toHaveBeenCalledWith({
      conversationId: "c1",
      userId: user.id,
      projectId: "p1",
    });
    // streamChat was NOT called — no LLM turn for action-only message.
    expect(streamChat).not.toHaveBeenCalled();
  });

  test("mixed message → handler fires AND streamChat is called", async () => {
    const handler = vi.fn().mockResolvedValue({
      kind: "success",
      card: { title: "x", body: "y", variant: "success" },
    });
    getEzAction.mockReturnValue({ name: "distill", description: "x", handler });

    const res = await POST(
      makeEvent({
        body: { content: "please ![EZ:distill] then continue" },
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runId: string | null;
      ezActionResults: unknown[];
    };
    expect(body.runId).not.toBeNull();
    expect(body.ezActionResults).toHaveLength(1);
    expect(handler).toHaveBeenCalled();
    expect(streamChat).toHaveBeenCalledTimes(1);
  });

  test("multiple actions in one message → all fire, all results persisted in order", async () => {
    const handler = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "success",
        card: { title: "First", body: "x", variant: "success" },
      })
      .mockResolvedValueOnce({
        kind: "decline",
        card: { title: "Second", body: "y", variant: "info" },
      });
    getEzAction.mockReturnValue({ name: "distill", description: "x", handler });

    const res = await POST(
      makeEvent({
        body: { content: "![EZ:distill] ![EZ:distill]" },
      }),
    );

    const body = (await res.json()) as {
      ezActionResults: Array<{ content: string }>;
    };
    expect(body.ezActionResults).toHaveLength(2);
    expect(handler).toHaveBeenCalledTimes(2);
    // First result is the success card, second is the decline.
    const r0 = JSON.parse(body.ezActionResults[0]!.content);
    const r1 = JSON.parse(body.ezActionResults[1]!.content);
    expect(r0.kind).toBe("success");
    expect(r1.kind).toBe("decline");
  });

  test("unknown action name → silent strip; streamChat still fires (mixed-equivalent)", async () => {
    // getEzAction returns null for unknown names — the dispatch loop
    // skips persistence + handler invocation, but the strip already
    // removed the token from `body.content` for prompt-build (via
    // build-prompt.ts's own strip pass).
    getEzAction.mockReturnValue(null);

    const res = await POST(
      makeEvent({
        body: { content: "do ![EZ:nonsense] something" },
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runId: string | null;
      ezActionResults: unknown[];
    };
    // No result message was persisted (unknown-action silent path).
    expect(body.ezActionResults).toHaveLength(0);
    // streamChat fires because there's surrounding prose.
    expect(body.runId).not.toBeNull();
    expect(streamChat).toHaveBeenCalledTimes(1);
  });

  test("unknown action AND action-only → silent strip, NO streamChat (no real action AND no surrounding text)", async () => {
    // `![EZ:nonsense]` is the only content — strip removes it,
    // leaving empty string, AND no actions actually got invoked
    // (getEzAction returns null). Per the implementation contract:
    // we still skip streamChat because the post-strip text is
    // whitespace-only AND ezStrip.actions.length > 0 (the parser
    // captured the unknown-name token).
    getEzAction.mockReturnValue(null);

    const res = await POST(
      makeEvent({ body: { content: "![EZ:nonsense]" } }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runId: string | null;
      ezActionResults: unknown[];
    };
    expect(body.ezActionResults).toHaveLength(0);
    expect(body.runId).toBeNull();
    expect(streamChat).not.toHaveBeenCalled();
  });

  test("handler throw → captured as error result message; flow continues", async () => {
    const handler = vi.fn().mockRejectedValue(new Error("kaboom"));
    getEzAction.mockReturnValue({ name: "distill", description: "x", handler });

    const res = await POST(
      makeEvent({ body: { content: "![EZ:distill]" } }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ezActionResults: Array<{ content: string }>;
      runId: string | null;
    };
    expect(body.ezActionResults).toHaveLength(1);
    const r = JSON.parse(body.ezActionResults[0]!.content);
    expect(r.kind).toBe("error");
    expect(r.card.title).toBe("Action failed");
    // Action-only → still no streamChat.
    expect(body.runId).toBeNull();
  });

  test("no EZ tokens → behavior unchanged (regression guard)", async () => {
    const res = await POST(
      makeEvent({ body: { content: "just plain text" } }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runId: string | null;
      ezActionResults: unknown[];
    };
    // ezActionResults is always present (empty when no actions).
    expect(body.ezActionResults).toEqual([]);
    expect(body.runId).not.toBeNull();
    expect(streamChat).toHaveBeenCalledTimes(1);
    expect(getEzAction).not.toHaveBeenCalled();
  });

  test("action-only message persists user message AND result message in order", async () => {
    const handler = vi.fn().mockResolvedValue({
      kind: "decline",
      card: { title: "Distiller declined", body: "no", variant: "info" },
    });
    getEzAction.mockReturnValue({ name: "distill", description: "x", handler });

    await POST(makeEvent({ body: { content: "![EZ:distill]" } }));

    // Two createMessage calls: user message first (role:"user",
    // content includes the original ![EZ:distill] token), then
    // result message (role:"ez-action-result", content is JSON).
    expect(createMessage).toHaveBeenCalledTimes(2);
    expect(createMessage.mock.calls[0]![1]).toMatchObject({
      role: "user",
      content: "![EZ:distill]",
    });
    expect(createMessage.mock.calls[1]![1]).toMatchObject({
      role: "ez-action-result",
    });
    const persistedResult = JSON.parse(createMessage.mock.calls[1]![1].content);
    expect(persistedResult.kind).toBe("decline");
  });
});
