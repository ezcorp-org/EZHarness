/**
 * Server-handler unit tests for
 * /api/conversations/[id]/messages (+server.ts).
 *
 * Covers GET/POST auth gate (401), ownership 404, token-budget 429,
 * validation 400 (JSON schema + multipart content length), and the
 * 500 "Project path not resolvable" path when attachments require
 * a project but the project row has no path.
 *
 * Mocks every persistence + runtime dependency — the handler is
 * WIP-adjacent (calls into conversations + attachments) so the real
 * modules are off-limits.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

const getConversation = vi.fn();
const getLatestLeaf = vi.fn();
const getConversationPath = vi.fn();
const getMessages = vi.fn();
const getMessagesWithToolCalls = vi.fn();
const getSubConversationToolCalls = vi.fn();
const createMessage = vi.fn();
const updateConversation = vi.fn();
const insertAttachment = vi.fn();
const deleteAttachmentsForMessage = vi.fn();
const getProject = vi.fn();
const streamChat = vi.fn(() => ({ catch: () => Promise.resolve() }));
const checkTokenBudget = vi.fn();
const cloneAttachmentsForFork = vi.fn();

vi.mock("$server/db/queries/conversations", () => ({
  getConversation,
  getLatestLeaf,
  getConversationPath,
  getMessages,
  getMessagesWithToolCalls,
  getSubConversationToolCalls,
  createMessage,
  updateConversation,
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
  getGoalHost: () => null,
}));

vi.mock("$lib/server/security/resource-quotas", () => ({
  checkTokenBudget,
}));

vi.mock("$lib/server/command-resolver", () => ({
  buildCommandResolver: () => async () => null,
}));

vi.mock("$server/providers/model-capabilities", () => ({
  getCapabilities: () => ({ maxFilesPerMessage: 0 }),
  classifyMime: () => null,
}));

vi.mock("$server/chat/attachments/validator", () => ({
  validateAttachment: async () => ({ ok: true, canonicalMime: "text/plain" }),
}));

vi.mock("$server/chat/attachments/storage", () => ({
  writeAttachment: async () => ({ storagePath: "p", sizeBytes: 1 }),
  deleteForMessage: async () => undefined,
}));

vi.mock("$server/chat/attachments/clone", () => ({
  cloneAttachmentsForFork,
}));

const { GET, POST } = await import(
  "../routes/api/conversations/[id]/messages/+server.ts"
);

function makeEvent(opts: {
  method?: string;
  locals?: Record<string, unknown>;
  body?: unknown;
  query?: string;
  contentType?: string;
}) {
  const method = opts.method ?? "GET";
  const href = `http://localhost/api/conversations/c1/messages${
    opts.query ? `?${opts.query}` : ""
  }`;
  const hasBody = opts.body !== undefined;
  return makeRequestEvent(href, {
    locals: opts.locals ?? {},
    params: { id: "c1" },
    request: {
      method,
      headers: hasBody
        ? { "content-type": opts.contentType ?? "application/json" }
        : undefined,
      body: hasBody ? JSON.stringify(opts.body) : undefined,
    },
  });
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

describe("GET /api/conversations/[id]/messages", () => {
  beforeEach(() => {
    getConversation.mockReset();
    getMessages.mockReset();
    getLatestLeaf.mockReset();
    getConversationPath.mockReset();
  });

  test("rejects 401 when unauthenticated", async () => {
    let res: Response | undefined;
    try {
      await GET(makeEvent({}));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("returns 404 when conversation missing", async () => {
    getConversation.mockResolvedValue(null);
    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(404);
  });

  test("returns 404 on ownership mismatch", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "other" });
    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(404);
  });

  test("happy path: returns empty array when no leaf exists", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    getLatestLeaf.mockResolvedValue(null);
    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(0);
  });
});

describe("POST /api/conversations/[id]/messages", () => {
  beforeEach(() => {
    getConversation.mockReset();
    createMessage.mockReset();
    vi.mocked(checkTokenBudget).mockReset();
    vi.mocked(checkTokenBudget).mockResolvedValue({ allowed: true } as any);
    streamChat.mockReset();
    streamChat.mockReturnValue({ catch: () => Promise.resolve() } as any);
  });

  test("rejects 401 when unauthenticated", async () => {
    let res: Response | undefined;
    try {
      await POST(
        makeEvent({ method: "POST", body: { content: "hi" } }),
      );
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("returns 404 when conversation missing", async () => {
    getConversation.mockResolvedValue(null);
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: { user },
        body: { content: "hi" },
      }),
    );
    expect(res.status).toBe(404);
  });

  test("returns 429 when token budget is exceeded", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    vi.mocked(checkTokenBudget).mockResolvedValue({
      allowed: false,
      resetsAt: "2026-04-24T00:00:00Z",
    } as any);
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: { user },
        body: { content: "hi" },
      }),
    );
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Daily token budget exceeded");
  });

  test("rejects 400 on JSON schema validation failure (empty content)", async () => {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1" });
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: { user },
        body: { content: "" },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("happy path: creates user message and returns runId", async () => {
    getConversation.mockResolvedValue({
      id: "c1",
      userId: "u1",
      projectId: "p1",
      agentConfigId: null,
      modeId: null,
      provider: null,
      model: null,
    });
    createMessage.mockResolvedValue({ id: "m1", role: "user", content: "hi" });

    const res = await POST(
      makeEvent({
        method: "POST",
        locals: { user },
        body: { content: "hi" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      userMessage: { id: string };
      runId: string;
    };
    expect(body.userMessage.id).toBe("m1");
    expect(typeof body.runId).toBe("string");
  });
});

describe("POST /api/conversations/[id]/messages — parent resolution", () => {
  beforeEach(() => {
    getConversation.mockReset();
    getConversation.mockResolvedValue({
      id: "c1",
      userId: "u1",
      projectId: "p1",
      agentConfigId: null,
      modeId: null,
      provider: null,
      model: null,
    });
    createMessage.mockReset();
    createMessage.mockResolvedValue({ id: "m1", role: "user", content: "hi" });
    getMessages.mockReset();
    getLatestLeaf.mockReset();
    vi.mocked(checkTokenBudget).mockReset();
    vi.mocked(checkTokenBudget).mockResolvedValue({ allowed: true } as any);
    streamChat.mockReset();
    streamChat.mockReturnValue({ catch: () => Promise.resolve() } as any);
  });

  test("no explicit parent + not an edit → anchors to the latest real leaf", async () => {
    getLatestLeaf.mockResolvedValue({ id: "assistant-leaf", role: "assistant" });
    const res = await POST(
      makeEvent({ method: "POST", locals: { user }, body: { content: "hi" } }),
    );
    expect(res.status).toBe(200);
    // Latest-leaf lookup must skip capability-event annotation rows so a
    // trailing auto-allow event can't become the parent.
    expect(getLatestLeaf).toHaveBeenCalledWith("c1", {
      excludeCapabilityEvents: true,
    });
    expect(createMessage.mock.calls[0]![1].parentMessageId).toBe(
      "assistant-leaf",
    );
  });

  test("first message in a conversation (no leaf) stays root", async () => {
    getLatestLeaf.mockResolvedValue(null);
    const res = await POST(
      makeEvent({ method: "POST", locals: { user }, body: { content: "hi" } }),
    );
    expect(res.status).toBe(200);
    expect(createMessage.mock.calls[0]![1].parentMessageId).toBeUndefined();
  });

  test("explicit parentMessageId is used verbatim (no leaf lookup)", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: { user },
        body: {
          content: "hi",
          parentMessageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(getLatestLeaf).not.toHaveBeenCalled();
    expect(createMessage.mock.calls[0]![1].parentMessageId).toBe(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    );
  });

  test("editOf resolves parent from the edited message — latest-leaf default is skipped", async () => {
    // Editing the very first user message (null parent) must fork a root
    // sibling, NOT attach to the latest leaf.
    getMessages.mockResolvedValue([
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", parentMessageId: null },
    ]);
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: { user },
        body: {
          content: "edited",
          editOf: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(getLatestLeaf).not.toHaveBeenCalled();
    expect(createMessage.mock.calls[0]![1].parentMessageId).toBeUndefined();
  });
});

describe("POST /api/conversations/[id]/messages — Auto sentinel + route-once", () => {
  /** Flush the fire-and-forget route-once `.then` chain (2 awaits inside). */
  const flushRouteOnce = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };

  beforeEach(() => {
    getConversation.mockReset();
    getConversation.mockResolvedValue({
      id: "c1",
      userId: "u1",
      projectId: "p1",
      agentConfigId: null,
      modeId: null,
      // A STORED conversation pin — the exact state that used to defeat
      // Auto via the `body.model ?? conv.model` fallback.
      provider: "openai",
      model: "gpt-4o",
    });
    createMessage.mockReset();
    createMessage.mockResolvedValue({ id: "m1", role: "user", content: "hi" });
    getMessages.mockReset();
    getMessages.mockResolvedValue([]);
    getLatestLeaf.mockReset();
    getLatestLeaf.mockResolvedValue(null);
    updateConversation.mockReset();
    vi.mocked(checkTokenBudget).mockReset();
    vi.mocked(checkTokenBudget).mockResolvedValue({ allowed: true } as any);
    streamChat.mockReset();
    // Real resolved promise — the route-once path chains `.then` on it.
    streamChat.mockReturnValue(Promise.resolve({ id: "run-x" }) as any);
  });

  test("explicit `model: null` bypasses the conv.model fallback → routing fires", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: { user },
        body: { content: "hi", provider: null, model: null },
      }),
    );
    expect(res.status).toBe(200);
    expect(streamChat).toHaveBeenCalledTimes(1);
    const opts = (streamChat.mock.calls[0] as unknown as [string, string, { provider?: string; model?: string }])[2];
    expect(opts.provider).toBeUndefined();
    expect(opts.model).toBeUndefined();
  });

  test("absent field keeps today's behavior exactly: falls back to conv.model", async () => {
    const res = await POST(
      makeEvent({ method: "POST", locals: { user }, body: { content: "hi" } }),
    );
    expect(res.status).toBe(200);
    const opts = (streamChat.mock.calls[0] as unknown as [string, string, { provider?: string; model?: string }])[2];
    expect(opts.provider).toBe("openai");
    expect(opts.model).toBe("gpt-4o");
    // Absent-field turns never trigger the route-once pin.
    await flushRouteOnce();
    expect(updateConversation).not.toHaveBeenCalled();
  });

  test("an explicit model string still wins over the conv pin", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: { user },
        body: { content: "hi", provider: "anthropic", model: "claude-opus" },
      }),
    );
    expect(res.status).toBe(200);
    const opts = (streamChat.mock.calls[0] as unknown as [string, string, { provider?: string; model?: string }])[2];
    expect(opts.provider).toBe("anthropic");
    expect(opts.model).toBe("claude-opus");
    await flushRouteOnce();
    expect(updateConversation).not.toHaveBeenCalled();
  });

  test("route-once: after an Auto turn, the SERVED model is pinned onto the conversation", async () => {
    let seenRunId: string | undefined;
    streamChat.mockImplementation(((_conv: string, _content: string, opts: { runId?: string }) => {
      seenRunId = opts.runId;
      return Promise.resolve({ id: opts.runId });
    }) as any);
    getMessages.mockImplementation(async () => [
      { id: "u-row", role: "user", runId: null, provider: null, model: null },
      // Served assistant row persisted by the runtime for THIS run.
      { id: "a-row", role: "assistant", runId: seenRunId, provider: "anthropic", model: "claude-sonnet" },
      // A later row from another run must not win.
      { id: "a-other", role: "assistant", runId: "other-run", provider: "openai", model: "gpt-4o" },
    ]);

    const res = await POST(
      makeEvent({
        method: "POST",
        locals: { user },
        body: { content: "route me", provider: null, model: null },
      }),
    );
    expect(res.status).toBe(200);
    const { runId } = (await res.json()) as { runId: string };
    expect(seenRunId).toBe(runId);

    await flushRouteOnce();
    expect(updateConversation).toHaveBeenCalledTimes(1);
    expect(updateConversation).toHaveBeenCalledWith("c1", {
      provider: "anthropic",
      model: "claude-sonnet",
    });
  });

  test("route-once: no pin when the turn produced no served assistant row", async () => {
    getMessages.mockResolvedValue([
      { id: "u-row", role: "user", runId: null, provider: null, model: null },
    ]);
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: { user },
        body: { content: "route me", provider: null, model: null },
      }),
    );
    expect(res.status).toBe(200);
    await flushRouteOnce();
    expect(updateConversation).not.toHaveBeenCalled();
  });

  test("route-once: a failing pin read is swallowed (response already sent)", async () => {
    getMessages.mockRejectedValue(new Error("db gone"));
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: { user },
        body: { content: "route me", provider: null, model: null },
      }),
    );
    expect(res.status).toBe(200);
    await flushRouteOnce();
    expect(updateConversation).not.toHaveBeenCalled();
  });

  test("rejects 400 when model is a non-string, non-null value", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: { user },
        body: { content: "hi", model: 42 },
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /api/conversations/[id]/messages — fork attachment inheritance", () => {
  const stagedAtt = {
    id: "att-1",
    filename: "cow.png",
    mimeType: "image/png",
    storagePath: "/proj/.ezcorp/attachments/c1/m-new/x.png",
  };
  const summaryAtt = {
    id: "att-1",
    filename: "cow.png",
    mimeType: "image/png",
    sizeBytes: 5,
    kind: "image",
  };

  beforeEach(() => {
    getConversation.mockReset();
    getConversation.mockResolvedValue({
      id: "c1",
      userId: "u1",
      projectId: "p1",
      agentConfigId: null,
      modeId: null,
      provider: null,
      model: null,
    });
    createMessage.mockReset();
    createMessage.mockResolvedValue({ id: "m-new", role: "user", content: "hi" });
    getMessages.mockReset();
    getLatestLeaf.mockReset();
    getProject.mockReset();
    getProject.mockResolvedValue({ id: "p1", path: "/proj" });
    cloneAttachmentsForFork.mockReset();
    cloneAttachmentsForFork.mockResolvedValue({ staged: [], summaries: [] });
    vi.mocked(checkTokenBudget).mockReset();
    vi.mocked(checkTokenBudget).mockResolvedValue({ allowed: true } as any);
    streamChat.mockReset();
    streamChat.mockReturnValue({ catch: () => Promise.resolve() } as any);
  });

  test("editOf a USER row copies the source attachments onto the forked row", async () => {
    getMessages.mockResolvedValue([
      { id: "a1a1a1a1-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "user", parentMessageId: null },
    ]);
    cloneAttachmentsForFork.mockResolvedValue({
      staged: [stagedAtt],
      summaries: [summaryAtt],
    });

    const res = await POST(
      makeEvent({
        method: "POST",
        locals: { user },
        body: { content: "hi", editOf: "a1a1a1a1-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      }),
    );
    expect(res.status).toBe(200);

    // Cloned from the edited USER row onto the freshly-created fork.
    expect(cloneAttachmentsForFork).toHaveBeenCalledTimes(1);
    expect(cloneAttachmentsForFork).toHaveBeenCalledWith({
      projectRoot: "/proj",
      conversationId: "c1",
      sourceMessageId: "a1a1a1a1-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      targetMessageId: "m-new",
    });

    // Inherited attachments ride back on userMessage + the top-level field…
    const body = (await res.json()) as {
      userMessage: { id: string; attachments?: unknown[] };
      attachments: unknown[];
    };
    expect(body.userMessage.attachments).toEqual([summaryAtt]);
    expect(body.attachments).toEqual([summaryAtt]);

    // …and the staged copies are replayed to the model this turn.
    const opts = (streamChat.mock.calls[0] as any)[2];
    expect(opts.attachments).toEqual([stagedAtt]);
  });

  test("editOf an ASSISTANT row (regenerate) does NOT inherit — original stays on-path", async () => {
    getMessages.mockResolvedValue([
      { id: "b2b2b2b2-bbbb-4bbb-8bbb-bbbbbbbbbbbb", role: "assistant", parentMessageId: "u1" },
    ]);

    const res = await POST(
      makeEvent({
        method: "POST",
        locals: { user },
        body: { content: "hi", editOf: "b2b2b2b2-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      }),
    );
    expect(res.status).toBe(200);
    expect(cloneAttachmentsForFork).not.toHaveBeenCalled();

    const body = (await res.json()) as {
      userMessage: { attachments?: unknown[] };
      attachments: unknown[];
    };
    expect(body.userMessage.attachments).toBeUndefined();
    expect(body.attachments).toEqual([]);
    const opts = (streamChat.mock.calls[0] as any)[2];
    expect(opts.attachments).toBeUndefined();
  });

  test("editOf a USER row with no source attachments is a 200 no-op", async () => {
    getMessages.mockResolvedValue([
      { id: "a1a1a1a1-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "user", parentMessageId: null },
    ]);
    cloneAttachmentsForFork.mockResolvedValue({ staged: [], summaries: [] });

    const res = await POST(
      makeEvent({
        method: "POST",
        locals: { user },
        body: { content: "hi", editOf: "a1a1a1a1-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      }),
    );
    expect(res.status).toBe(200);
    expect(cloneAttachmentsForFork).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as { attachments: unknown[] };
    expect(body.attachments).toEqual([]);
  });

  test("missing project path degrades — no clone, turn still succeeds", async () => {
    getMessages.mockResolvedValue([
      { id: "a1a1a1a1-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "user", parentMessageId: null },
    ]);
    getProject.mockResolvedValue({ id: "p1", path: null });

    const res = await POST(
      makeEvent({
        method: "POST",
        locals: { user },
        body: { content: "hi", editOf: "a1a1a1a1-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      }),
    );
    expect(res.status).toBe(200);
    expect(cloneAttachmentsForFork).not.toHaveBeenCalled();
  });

  test("a clone failure is swallowed — best-effort, turn still succeeds", async () => {
    getMessages.mockResolvedValue([
      { id: "a1a1a1a1-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "user", parentMessageId: null },
    ]);
    cloneAttachmentsForFork.mockRejectedValue(new Error("disk gone"));

    const res = await POST(
      makeEvent({
        method: "POST",
        locals: { user },
        body: { content: "hi", editOf: "a1a1a1a1-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attachments: unknown[] };
    expect(body.attachments).toEqual([]);
  });

  test("editOf a non-existent message does not clone and still succeeds", async () => {
    // editedMsg not found → editInheritSourceId stays undefined (the
    // `if (editedMsg)` false branch) → no clone, no crash.
    getMessages.mockResolvedValue([]);

    const res = await POST(
      makeEvent({
        method: "POST",
        locals: { user },
        body: { content: "hi", editOf: "c3c3c3c3-cccc-4ccc-8ccc-cccccccccccc" },
      }),
    );
    expect(res.status).toBe(200);
    expect(cloneAttachmentsForFork).not.toHaveBeenCalled();
  });
});

// ── Boundary 2: per-API-key mode lock + autopilot refusal ───────────────
//
// FOUR ARMS PER GUARD, and the last two are the whole back-compat contract:
// a policied key refused with the right field, a policied key allowed in
// policy, an UNPOLICIED key unchanged, and a COOKIE SESSION unchanged.
// Policy binds the key, never the human.
describe("POST … messages — per-API-key tool policy", () => {
  const MODE = "mode-locked";
  /** A policied bearer principal. `apiKeyScopes` is what makes it a key
   *  rather than a cookie; `apiKeyToolPolicy` is what confines it. */
  const policied = (policy: Record<string, unknown>) => ({
    user,
    apiKeyScopes: ["read", "write", "chat"],
    apiKeyToolPolicy: policy,
  });
  /** Same key, no policy — the "nothing changed" arm. */
  const unpolicied = { user, apiKeyScopes: ["read", "write", "chat"] };
  /** A browser session: no scopes, no policy, never confined. */
  const cookie = { user };

  function conv(over: Record<string, unknown> = {}) {
    getConversation.mockResolvedValue({ id: "c1", userId: "u1", modeId: MODE, ...over });
  }

  beforeEach(() => {
    getConversation.mockReset();
    createMessage.mockReset();
    createMessage.mockResolvedValue({ id: "m1", role: "user", content: "hi" });
    getLatestLeaf.mockReset();
    getLatestLeaf.mockResolvedValue(null);
    getMessages.mockReset();
    getMessages.mockResolvedValue([]);
    vi.mocked(checkTokenBudget).mockReset();
    vi.mocked(checkTokenBudget).mockResolvedValue({ allowed: true } as any);
    streamChat.mockReset();
    streamChat.mockReturnValue({ catch: () => Promise.resolve() } as any);
  });

  const send = (locals: Record<string, unknown>, content = "hi") =>
    POST(makeEvent({ method: "POST", locals, body: { content } })) as Promise<Response>;

  describe("locked mode", () => {
    test("in-policy send is allowed and starts the run", async () => {
      conv();
      const res = await send(policied({ lockedModeId: MODE }));
      expect(res.status).toBe(200);
      expect(streamChat).toHaveBeenCalledTimes(1);
    });

    test("a conversation under a DIFFERENT mode is 403 lockedModeId", async () => {
      conv({ modeId: "mode-other" });
      const res = await send(policied({ lockedModeId: MODE }));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ field: "lockedModeId" });
      // Refused before the user row is persisted — a rejected turn leaves no
      // trace in the thread.
      expect(createMessage).not.toHaveBeenCalled();
      expect(streamChat).not.toHaveBeenCalled();
    });

    test("a DELETED locked mode (modeId null) BRICKS the key — it does not free it", async () => {
      // `conversations.mode_id` is ON DELETE SET NULL, so the one action the
      // key cannot perform must not be the action that unconfines it.
      conv({ modeId: null });
      const res = await send(policied({ lockedModeId: MODE }));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ field: "lockedModeId" });
    });

    test("an UNPOLICIED key is unchanged by a null mode", async () => {
      conv({ modeId: null });
      expect((await send(unpolicied)).status).toBe(200);
    });

    test("a COOKIE SESSION is unchanged by a null mode", async () => {
      conv({ modeId: null });
      expect((await send(cookie)).status).toBe(200);
    });
  });

  describe("autopilot", () => {
    test("a policied key may not ARM a goal", async () => {
      conv();
      const res = await send(policied({ lockedModeId: MODE }), "/goal ship it");
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ field: "goal" });
      expect(createMessage).not.toHaveBeenCalled();
    });

    test("`/goalpost` is not a goal command (the canonical predicate, not a prefix match)", async () => {
      conv();
      expect((await send(policied({ lockedModeId: MODE }), "/goalpost")).status).toBe(200);
    });

    test("a policied key may not send to an ARMED conversation (drive or resume)", async () => {
      conv({ metadata: { goal: { condition: "ship it", lastReason: null, createdAt: "" } } });
      const res = await send(policied({ lockedModeId: MODE }));
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ field: "goal" });
    });

    test("a policy with no lock still refuses autopilot — the refusal binds on POLICY, not on the mode", async () => {
      conv({ modeId: null });
      const res = await send(policied({ maxCallerTools: 1 }), "/goal ship it");
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ field: "goal" });
    });

    test("an UNPOLICIED key may still arm and drive a goal", async () => {
      conv({ metadata: { goal: { condition: "ship it", lastReason: null, createdAt: "" } } });
      expect((await send(unpolicied)).status).toBe(200);
      expect((await send(unpolicied, "/goal ship it")).status).toBe(200);
    });

    test("a COOKIE SESSION may still arm and drive a goal", async () => {
      conv({ metadata: { goal: { condition: "ship it", lastReason: null, createdAt: "" } } });
      expect((await send(cookie)).status).toBe(200);
      expect((await send(cookie, "/goal ship it")).status).toBe(200);
    });
  });

  // ── Boundary 3: the run inherits the credential's confinement ─────────
  //
  // THIS IS THE ASSERTION THAT WAS MISSING, and its absence is why Boundary 3
  // shipped inert. The boundary's own suite injected both options straight
  // into `streamChat`, so it passed while no route ever set either one — a
  // policied key's spawn-deny did nothing mid-turn, which is the exact gap
  // Boundary 3 exists to close. Assert from the ROUTE.
  describe("Boundary 3 — what reaches streamChat", () => {
    /** The options bag the route handed the executor. `streamChat` is mocked
     *  with a zero-arg factory, so its recorded call tuple needs naming. */
    const optsOf = () =>
      (streamChat.mock.calls[0] as unknown as [string, string, Record<string, unknown>])[2];

    test("a policied key's run denies the LLM's spawn primitives", async () => {
      conv();
      expect((await send(policied({ lockedModeId: MODE }))).status).toBe(200);
      expect(optsOf().forceDenyOrchestration).toBe(true);
    });

    test("allowedCallerTools becomes the run's caller-tool cap", async () => {
      conv();
      const res = await send(
        policied({ lockedModeId: MODE, allowedCallerTools: ["open_app"] }),
      );
      expect(res.status).toBe(200);
      expect(optsOf().callerToolAllowlist).toEqual(["open_app"]);
    });

    test("an EMPTY allowedCallerTools reaches the run as empty — the hardest lock", async () => {
      // Nullish means "no constraint" downstream, so dropping the empty array
      // anywhere on this path would invert the policy at exactly the value an
      // operator uses to permit NO caller tools at all.
      conv();
      const res = await send(policied({ lockedModeId: MODE, allowedCallerTools: [] }));
      expect(res.status).toBe(200);
      expect(optsOf().callerToolAllowlist).toEqual([]);
    });

    test("a policy that names no caller tools leaves the cap absent", async () => {
      conv();
      expect((await send(policied({ lockedModeId: MODE }))).status).toBe(200);
      expect(Object.keys(optsOf())).not.toContain("callerToolAllowlist");
    });

    test("an UNPOLICIED key gets the pre-policy surface — neither option", async () => {
      conv();
      expect((await send(unpolicied)).status).toBe(200);
      expect(Object.keys(optsOf())).not.toContain("forceDenyOrchestration");
      expect(Object.keys(optsOf())).not.toContain("callerToolAllowlist");
    });

    test("a COOKIE SESSION gets the pre-policy surface — neither option", async () => {
      conv();
      expect((await send(cookie)).status).toBe(200);
      expect(Object.keys(optsOf())).not.toContain("forceDenyOrchestration");
      expect(Object.keys(optsOf())).not.toContain("callerToolAllowlist");
    });
  });
});
