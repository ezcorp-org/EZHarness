/**
 * Vitest server-handler tests for `POST /api/ez-actions/[name]/+server.ts`
 * (Phase 3.1 of EZ Actions v1).
 *
 * Coverage targets (per plan §3.5):
 *   - 401 unauthenticated
 *   - 404 unknown action name
 *   - 404 conversation not owned (collapsed with not-found per
 *     id-enumeration defense)
 *   - 400 missing conversationId
 *   - 200 success path returns `{result, messageId}`
 *   - persisted message has `role: "ez-action-result"` and JSON body
 *   - request body's projectId is IGNORED in favor of conv.projectId
 *     (the dispatch never trusts client-supplied project routing)
 *
 * Mocks: `getEzAction` (registry), `getConversation` + `createMessage`
 * (DB), and `requireScope` (security middleware) so the test runs
 * pure-handler without a DB or registered action set.
 *
 * Note: these tests use the synthetic action name `test-action` so the
 * generic registry-handler path is exercised. The `distill` action is
 * special-cased by the route as of Phase 53 (forwards to the bundled
 * `lessons-distiller` extension's `distill_now` tool); behaviour of the
 * forwarder is covered by the distiller-port-parity test and the
 * extension's own unit tests, not here.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

const mockGetEzAction = vi.fn();
vi.mock("$server/runtime/ez-actions/registry", () => ({
  getEzAction: mockGetEzAction,
}));

const mockGetConversation = vi.fn();
const mockCreateMessage = vi.fn();
const mockGetLatestLeaf = vi.fn();
vi.mock("$server/db/queries/conversations", () => ({
  getConversation: mockGetConversation,
  createMessage: mockCreateMessage,
  getLatestLeaf: mockGetLatestLeaf,
}));

vi.mock("$lib/server/security/api-keys", () => ({
  // requireScope returns null on success, a Response on failure. We
  // default to "pass" and let individual tests override.
  requireScope: () => null,
}));

const { POST } = await import("../routes/api/ez-actions/[name]/+server");

const USER = { id: "u1", email: "u@x", name: "u", role: "user" } as const;

function makeEvent(opts: {
  name: string;
  body?: unknown;
  locals?: Record<string, unknown>;
}) {
  const href = `http://localhost/api/ez-actions/${opts.name}`;
  return {
    params: { name: opts.name },
    request: new Request(href, {
      method: "POST",
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      headers: { "Content-Type": "application/json" },
    }),
    locals: opts.locals ?? { user: USER },
    url: new URL(href),
  } as any;
}

describe("POST /api/ez-actions/[name]", () => {
  beforeEach(() => {
    mockGetEzAction.mockReset();
    mockGetConversation.mockReset();
    mockCreateMessage.mockReset();
    mockGetLatestLeaf.mockReset();
    // Default: empty conversation (no leaf). Individual tests that
    // exercise the parentMessageId wiring override this.
    mockGetLatestLeaf.mockResolvedValue(null);
  });

  test("401 when no authenticated user", async () => {
    // requireAuth throws a Response when locals.user is missing.
    let res: Response | null = null;
    try {
      const result = await POST(
        makeEvent({
          name: "test-action",
          body: { conversationId: "c1" },
          locals: {}, // no user
        }),
      );
      res = result;
    } catch (thrown) {
      // requireAuth's contract throws a Response — capture it.
      if (thrown instanceof Response) res = thrown;
      else throw thrown;
    }
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
  });

  test("404 unknown action name", async () => {
    mockGetEzAction.mockReturnValue(null);
    const res = await POST(
      makeEvent({
        name: "nonexistent",
        body: { conversationId: "c1" },
      }),
    );
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/no such ez action/i);
  });

  test("400 missing conversationId in body", async () => {
    mockGetEzAction.mockReturnValue({
      name: "test-action",
      description: "x",
      handler: vi.fn(),
    });
    const res = await POST(
      makeEvent({
        name: "test-action",
        body: {}, // missing conversationId
      }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/conversationid is required/i);
  });

  test("400 when body is not JSON", async () => {
    mockGetEzAction.mockReturnValue({
      name: "test-action",
      description: "x",
      handler: vi.fn(),
    });
    const event = {
      params: { name: "test-action" },
      request: new Request("http://localhost/api/ez-actions/test-action", {
        method: "POST",
        body: "not json",
        headers: { "Content-Type": "application/json" },
      }),
      locals: { user: USER },
      url: new URL("http://localhost/api/ez-actions/test-action"),
    } as any;
    const res = await POST(event);
    expect(res.status).toBe(400);
  });

  test("404 conversation not found", async () => {
    mockGetEzAction.mockReturnValue({
      name: "test-action",
      description: "x",
      handler: vi.fn(),
    });
    mockGetConversation.mockResolvedValue(null);

    const res = await POST(
      makeEvent({
        name: "test-action",
        body: { conversationId: "ghost" },
      }),
    );
    expect(res.status).toBe(404);
    expect(mockGetConversation).toHaveBeenCalledWith("ghost");
  });

  test("404 conversation not owned by caller (collapsed with not-found)", async () => {
    mockGetEzAction.mockReturnValue({
      name: "test-action",
      description: "x",
      handler: vi.fn(),
    });
    mockGetConversation.mockResolvedValue({
      id: "c1",
      userId: "DIFFERENT_USER",
      projectId: "p1",
    });

    const res = await POST(
      makeEvent({
        name: "test-action",
        body: { conversationId: "c1" },
      }),
    );
    // Same status code as not-found per id-enumeration defense.
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: string };
    expect(json.error).toMatch(/conversation not found/i);
  });

  test("200 success path returns {result, messageId}; result persisted as ez-action-result message", async () => {
    const handlerResult = {
      kind: "success" as const,
      card: { title: "Lesson captured", body: "abc", variant: "success" as const },
      ref: { kind: "lesson" as const, slug: "abc" },
    };
    const handlerSpy = vi.fn().mockResolvedValue(handlerResult);
    mockGetEzAction.mockReturnValue({
      name: "test-action",
      description: "x",
      handler: handlerSpy,
    });
    mockGetConversation.mockResolvedValue({
      id: "c1",
      userId: USER.id,
      projectId: "p1",
    });
    mockCreateMessage.mockResolvedValue({
      id: "msg-99",
      role: "ez-action-result",
      content: JSON.stringify(handlerResult),
    });

    const res = await POST(
      makeEvent({
        name: "test-action",
        body: { conversationId: "c1" },
      }),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      result: typeof handlerResult;
      messageId: string;
    };
    expect(json.result).toEqual(handlerResult);
    expect(json.messageId).toBe("msg-99");

    // Handler invoked with conv-derived projectId, NOT the body's.
    expect(handlerSpy).toHaveBeenCalledWith({
      conversationId: "c1",
      userId: USER.id,
      projectId: "p1",
    });

    // Message persisted with correct role + JSON-encoded payload.
    // parentMessageId is undefined here because mockGetLatestLeaf
    // returns null (the `beforeEach` default — empty conversation).
    // The next test exercises the populated-leaf branch.
    expect(mockCreateMessage).toHaveBeenCalledWith("c1", {
      role: "ez-action-result",
      content: JSON.stringify(handlerResult),
      parentMessageId: undefined,
    });
  });

  test("persisted message has parentMessageId set to the conversation's leaf id", async () => {
    // Mirrors the submit-time path's pattern (messages/+server.ts uses
    // userMessage.id as parent). The dispatcher has no preceding user
    // message, so the conversation's current leaf is the canonical
    // anchor — without it, the row drifts in the branched-conversation
    // render path.
    const handlerResult = {
      kind: "success" as const,
      card: { title: "x", body: "y", variant: "success" as const },
    };
    mockGetEzAction.mockReturnValue({
      name: "test-action",
      description: "x",
      handler: vi.fn().mockResolvedValue(handlerResult),
    });
    mockGetConversation.mockResolvedValue({
      id: "c1",
      userId: USER.id,
      projectId: "p1",
    });
    mockGetLatestLeaf.mockResolvedValue({
      id: "leaf-msg-42",
      conversationId: "c1",
      role: "assistant",
      content: "prior turn",
    });
    mockCreateMessage.mockResolvedValue({
      id: "msg-101",
      role: "ez-action-result",
      content: JSON.stringify(handlerResult),
      parentMessageId: "leaf-msg-42",
    });

    const res = await POST(
      makeEvent({
        name: "test-action",
        body: { conversationId: "c1" },
      }),
    );
    expect(res.status).toBe(200);
    expect(mockGetLatestLeaf).toHaveBeenCalledWith("c1");

    // The persisted row's parentMessageId is the leaf's id — NOT null
    // and NOT undefined.
    const callArgs = mockCreateMessage.mock.calls[0]!;
    expect(callArgs[0]).toBe("c1");
    expect(callArgs[1].parentMessageId).toBe("leaf-msg-42");
    expect(callArgs[1].parentMessageId).not.toBeNull();
  });

  test("body's projectId is IGNORED in favor of conv.projectId", async () => {
    const handlerSpy = vi.fn().mockResolvedValue({
      kind: "success",
      card: { title: "x", body: "y", variant: "success" },
    });
    mockGetEzAction.mockReturnValue({
      name: "test-action",
      description: "x",
      handler: handlerSpy,
    });
    mockGetConversation.mockResolvedValue({
      id: "c1",
      userId: USER.id,
      projectId: "TRUE_PROJECT",
    });
    mockCreateMessage.mockResolvedValue({
      id: "msg-100",
      role: "ez-action-result",
      content: "{}",
    });

    await POST(
      makeEvent({
        name: "test-action",
        body: { conversationId: "c1", projectId: "ATTACKER_PROJECT" },
      }),
    );

    expect(handlerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "TRUE_PROJECT" }),
    );
    expect(handlerSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "ATTACKER_PROJECT" }),
    );
  });

  test("handler throw → 200 with synthesized error result card (matches submit-time pattern)", async () => {
    // Pre-fix this returned 500. The dispatcher endpoint and the submit-
    // time path now BOTH catch handler throws and persist an error
    // result card — the inline-card UX is the contract: every action
    // invocation yields a card, never a bare HTTP error. HTTP 5xx is
    // reserved for genuine transport / persistence failures.
    mockGetEzAction.mockReturnValue({
      name: "test-action",
      description: "x",
      handler: vi.fn().mockRejectedValue(new Error("kaboom")),
    });
    mockGetConversation.mockResolvedValue({
      id: "c1",
      userId: USER.id,
      projectId: "p1",
    });
    mockCreateMessage.mockImplementation(async (_convId, data) => ({
      id: "msg-thrown",
      role: data.role,
      content: data.content,
      parentMessageId: data.parentMessageId ?? null,
    }));

    const res = await POST(
      makeEvent({
        name: "test-action",
        body: { conversationId: "c1" },
      }),
    );

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      result: { kind: string; card: { title: string; variant: string } };
      messageId: string;
    };
    expect(json.result.kind).toBe("error");
    expect(json.result.card.variant).toBe("error");
    expect(json.result.card.title).toMatch(/action failed/i);

    // Server-side error detail is NOT leaked into the persisted card —
    // matches the submit-time pattern + avoids exposing raw error
    // messages to the chat-renderable history.
    expect(JSON.stringify(json.result)).not.toContain("kaboom");

    // The error card is persisted as a normal ez-action-result row.
    expect(mockCreateMessage).toHaveBeenCalledTimes(1);
    expect(mockCreateMessage.mock.calls[0]![1].role).toBe("ez-action-result");
  });

  test("decline / error result still persists a message and returns 200", async () => {
    // Action handlers that return a `decline` or `error` result are
    // NOT exceptions — they're successful invocations of an action
    // that chose to decline. The endpoint persists the card and
    // returns 200 so the client can render it.
    const declineResult = {
      kind: "decline" as const,
      card: {
        title: "Distiller declined",
        body: "no insight",
        variant: "info" as const,
      },
    };
    mockGetEzAction.mockReturnValue({
      name: "test-action",
      description: "x",
      handler: vi.fn().mockResolvedValue(declineResult),
    });
    mockGetConversation.mockResolvedValue({
      id: "c1",
      userId: USER.id,
      projectId: "p1",
    });
    mockCreateMessage.mockResolvedValue({
      id: "msg-decline",
      role: "ez-action-result",
      content: JSON.stringify(declineResult),
    });

    const res = await POST(
      makeEvent({
        name: "test-action",
        body: { conversationId: "c1" },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { result: typeof declineResult };
    expect(json.result.kind).toBe("decline");
  });
});
