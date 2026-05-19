/**
 * Phase 48 Wave 2 — POST /api/conversations/[id]/messages on an Ez convo.
 *
 * The must-have: "tool calls outside the Ez allowlist are rejected end-to-end."
 * The actual allowlist filtering lives in `applyToolFilters` (verified
 * by src/__tests__/runtime-tool-filter-allowlist.test.ts) and the
 * executor's mode-lookup plumbing (verified by
 * src/__tests__/executor-allowed-tools-plumbing.test.ts). What this
 * test pins down is the BOUNDARY: that the messages handler hands the
 * conversation's modeId straight through to executor.streamChat, so
 * the filter sees `modeId='builtin-ez'` for an Ez conversation and
 * cannot be tricked into seeing some other mode.
 *
 * Specifically:
 *  - On a `kind='ez'` conversation, executor.streamChat is invoked
 *    with `options.modeId = 'builtin-ez'` (the seeded Ez mode id).
 *  - The body has no `modeId` input — the schema doesn't expose one
 *    (we verify this by attempting to set one and confirming it does
 *    NOT propagate; the conversation's mode is always authoritative).
 *  - The Ez tool names are exactly the seven the seeded mode allows
 *    (sanity check of the `EZ_TOOL_NAMES` constant against the literal
 *    list — the seed and the runtime registration must agree, or the
 *    allowlist filter would silently drop legit tools).
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
// streamChat is variadic in production (conversationId, content, options);
// declare the signature so streamChat.mock.calls[N] is a 3-tuple in tests.
const streamChat = vi.fn(
  (_conversationId: string, _content: string, _options: Record<string, unknown>) => ({
    catch: () => Promise.resolve(),
  }),
);
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

const { POST } = await import("../routes/api/conversations/[id]/messages/+server.ts");
const { EZ_TOOL_NAMES } = await import("$server/runtime/tools/ez/index");

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
}) {
  const href = "http://localhost/api/conversations/ez-conv/messages";
  return {
    url: new URL(href),
    locals: opts.locals ?? {},
    params: { id: "ez-conv" },
    request: new Request(href, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  } as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

const ezConversation = {
  id: "ez-conv",
  userId: "u1",
  kind: "ez",
  modeId: "builtin-ez",
  projectId: "global",
  agentConfigId: null,
  provider: null,
  model: null,
  title: "Ez",
};

describe("POST /api/conversations/[id]/messages — Ez allowlist plumbing", () => {
  beforeEach(() => {
    getConversation.mockReset();
    createMessage.mockReset();
    streamChat.mockReset();
    streamChat.mockReturnValue({ catch: () => Promise.resolve() } as ReturnType<typeof streamChat>);
    checkTokenBudget.mockResolvedValue({ allowed: true });
    createMessage.mockResolvedValue({ id: "msg-1", parentMessageId: null });
  });

  test("Ez conversation: streamChat is invoked with modeId='builtin-ez' so the allowlist filter applies", async () => {
    getConversation.mockResolvedValue(ezConversation);
    const res = (await POST(
      makeEvent({ locals: { user }, body: { content: "make a project" } }),
    )) as Response;
    expect(res.status).toBe(200);

    expect(streamChat).toHaveBeenCalledTimes(1);
    const args = streamChat.mock.calls[0]!;
    // Signature: streamChat(conversationId, content, options)
    expect(args[0]).toBe("ez-conv");
    expect(args[1]).toBe("make a project");
    const options = args[2] as { modeId?: string; projectId?: string };
    expect(options.modeId).toBe("builtin-ez");
    expect(options.projectId).toBe("global");
  });

  test("body cannot override the conversation's modeId — the conversation's row is authoritative", async () => {
    getConversation.mockResolvedValue(ezConversation);
    const res = (await POST(
      makeEvent({
        locals: { user },
        // The createMessageSchema does not accept a modeId field; even if a
        // client tries to inject one, the handler reads modeId off conv.
        body: { content: "x", modeId: "some-other-mode" },
      }),
    )) as Response;
    expect(res.status).toBe(200);
    const options = streamChat.mock.calls[0]![2] as { modeId?: string };
    expect(options.modeId).toBe("builtin-ez");
  });

  test("EZ_TOOL_NAMES exposes the exact seven names the seeded Ez mode allows", () => {
    // This is the contract between the runtime registration (Wave 2) and
    // the migration seed (Wave 1). If they ever drift, the runtime would
    // register a tool whose name isn't in `mode.allowedTools` and the
    // filter would drop it on every Ez turn.
    expect([...EZ_TOOL_NAMES]).toEqual([
      "propose_create_project",
      "propose_create_agent",
      "propose_install_extension",
      "summarize_conversation",
      "find_agents",
      "fill_form",
      "navigate_to",
    ]);
  });

  test("regular conversation: streamChat sees the conversation's own modeId (no Ez coupling)", async () => {
    getConversation.mockResolvedValue({
      ...ezConversation,
      kind: "regular",
      modeId: null, // regular conversations may have no mode
    });
    const res = (await POST(
      makeEvent({ locals: { user }, body: { content: "regular message" } })
    )) as Response;
    expect(res.status).toBe(200);
    const options = streamChat.mock.calls[0]![2] as { modeId?: string };
    expect(options.modeId).toBeUndefined();
  });
});
