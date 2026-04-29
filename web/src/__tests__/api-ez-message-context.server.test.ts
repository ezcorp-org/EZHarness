/**
 * Phase 48 — Gap #2 fix verification.
 *
 * The verification report flagged that the messages POST endpoint
 * silently dropped `body.ezContext` because the schema was strict and
 * the handler never read the field. This test pins the new contract:
 *
 *   - The schema accepts a well-formed `ezContext` payload
 *     (route + optional data + optional formIds) and propagates it.
 *   - The handler forwards `body.ezContext` to `executor.streamChat`
 *     as the `ezContext` option (server-side wiring lands in setup-tools).
 *   - A regular conversation that posts `ezContext` still passes the
 *     schema (the field is permissive at the route layer; setup-tools
 *     gates `<page_context>` emission on `convRecord.kind === 'ez'`).
 *
 * This is a BOUNDARY test (route → executor) — it does not exercise
 * the actual `<page_context>` text appended to the system prompt.
 * That branch is covered by ez-tools-wired-into-setup.test.ts's static
 * regression guard against setup-tools.ts.
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

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
  conversationId?: string;
}) {
  const id = opts.conversationId ?? "ez-conv";
  const href = `http://localhost/api/conversations/${id}/messages`;
  return {
    url: new URL(href),
    locals: opts.locals ?? {},
    params: { id },
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

const regularConversation = {
  ...ezConversation,
  id: "regular-conv",
  kind: "regular",
  modeId: null,
};

const ezContextPayload = {
  route: {
    url: "/agents/new",
    routeId: "/(app)/agents/new",
    params: {},
    projectId: null,
    conversationId: null,
    agentId: null,
  },
  data: { existingAgentNames: ["alpha", "beta"] },
  formIds: ["agent-new"],
};

describe("POST /api/conversations/[id]/messages — Ez ezContext ingestion (Gap #2)", () => {
  beforeEach(() => {
    getConversation.mockReset();
    createMessage.mockReset();
    streamChat.mockReset();
    streamChat.mockReturnValue({ catch: () => Promise.resolve() } as ReturnType<typeof streamChat>);
    checkTokenBudget.mockResolvedValue({ allowed: true });
    createMessage.mockResolvedValue({ id: "msg-1", parentMessageId: null });
  });

  test("forwards body.ezContext to executor.streamChat as the ezContext option", async () => {
    getConversation.mockResolvedValue(ezConversation);
    const res = (await POST(
      makeEvent({
        locals: { user },
        body: { content: "fill it in", ezContext: ezContextPayload },
      }),
    )) as Response;
    expect(res.status).toBe(200);

    expect(streamChat).toHaveBeenCalledTimes(1);
    const args = streamChat.mock.calls[0]!;
    const options = args[2] as { ezContext?: typeof ezContextPayload; modeId?: string };
    // The executor option carries the full payload through unchanged —
    // setup-tools.ts is what serializes it into <page_context>.
    expect(options.ezContext).toBeDefined();
    expect(options.ezContext!.route.url).toBe("/agents/new");
    expect(options.ezContext!.route.routeId).toBe("/(app)/agents/new");
    expect(options.ezContext!.data).toEqual({ existingAgentNames: ["alpha", "beta"] });
    expect(options.ezContext!.formIds).toEqual(["agent-new"]);
    // Sanity: the modeId still threads through (unchanged from the
    // existing api-ez-message test).
    expect(options.modeId).toBe("builtin-ez");
  });

  test("a missing ezContext field is fine — the executor option is undefined", async () => {
    getConversation.mockResolvedValue(ezConversation);
    const res = (await POST(
      makeEvent({ locals: { user }, body: { content: "no context" } }),
    )) as Response;
    expect(res.status).toBe(200);
    const options = streamChat.mock.calls[0]![2] as { ezContext?: unknown };
    expect(options.ezContext).toBeUndefined();
  });

  test("a malformed ezContext (route is not an object) is rejected at the schema layer", async () => {
    getConversation.mockResolvedValue(ezConversation);
    const res = (await POST(
      makeEvent({
        locals: { user },
        // route must be an object — sending a string should trip the
        // zod refinement before the handler reaches streamChat.
        body: { content: "x", ezContext: { route: "not-an-object" } },
      }),
    )) as Response;
    expect(res.status).toBe(400);
    expect(streamChat).not.toHaveBeenCalled();
  });

  test("regular conversation: the ezContext flows through (the gate is downstream in setup-tools)", async () => {
    // The endpoint is intentionally permissive: it does NOT validate
    // that the conversation is `kind='ez'` before accepting an
    // ezContext. setup-tools.ts is the single gate that ignores the
    // payload on non-Ez turns. That layering keeps the endpoint pure
    // (one schema for both kinds) and the security check in one place.
    getConversation.mockResolvedValue(regularConversation);
    const res = (await POST(
      makeEvent({
        conversationId: "regular-conv",
        locals: { user },
        body: { content: "x", ezContext: ezContextPayload },
      }),
    )) as Response;
    expect(res.status).toBe(200);
    const options = streamChat.mock.calls[0]![2] as { ezContext?: unknown };
    expect(options.ezContext).toBeDefined();
  });
});
