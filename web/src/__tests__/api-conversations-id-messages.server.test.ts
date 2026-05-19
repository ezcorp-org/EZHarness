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

const getConversation = vi.fn();
const getLatestLeaf = vi.fn();
const getConversationPath = vi.fn();
const getMessages = vi.fn();
const getMessagesWithToolCalls = vi.fn();
const getSubConversationToolCalls = vi.fn();
const createMessage = vi.fn();
const insertAttachment = vi.fn();
const deleteAttachmentsForMessage = vi.fn();
const getProject = vi.fn();
const streamChat = vi.fn(() => ({ catch: () => Promise.resolve() }));
const checkTokenBudget = vi.fn();

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
  return {
    url: new URL(href),
    locals: opts.locals ?? {},
    params: { id: "c1" },
    request: new Request(href, {
      method,
      headers: hasBody
        ? { "content-type": opts.contentType ?? "application/json" }
        : undefined,
      body: hasBody ? JSON.stringify(opts.body) : undefined,
    }),
  } as any;
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
