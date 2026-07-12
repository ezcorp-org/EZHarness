/**
 * PHASE 0 — Regression-pinning baseline (no src changes).
 *
 * Pins the CURRENT ownership behaviour of the per-message endpoints
 * BEFORE the Phase-1/2 `resolveRootConversationForOwnership` extraction,
 * so the later refactor can be proven non-regressing for top-level
 * conversations.
 *
 * The contract this file freezes (current `main`, unchanged source):
 *
 *   - `GET  /api/conversations/[id]/messages`        (+server.ts)
 *   - `POST /api/conversations/[id]/messages`        (+server.ts)
 *   - `PATCH /api/conversations/[id]/messages/[mid]` ([mid]/+server.ts)
 *
 * Matrix per verb on a PARENTLESS (top-level) conversation:
 *   - owner (conv.userId === user.id)        → 200 / success
 *   - admin (user.role === "admin")          → 200 / success
 *   - non-owner non-admin                    → 404 "Not found"
 *   - conversation missing                   → 404 "Not found"
 *
 * Plus the side-gates that MUST survive the Phase-2 helper swap:
 *   - PATCH active-run → 409 (gate fires AFTER ownership passes)
 *   - POST token-budget → 429 (gate fires AFTER ownership passes)
 *
 * After Phase 2 this exact file must still pass UNCHANGED — top-level
 * conversations are parentless, so `resolveRootConversationForOwnership`
 * returns `root === self` and the matrix is byte-identical (risk #4 in
 * the plan's risk register).
 *
 * `bun test` drives the handlers directly with `mock.module(...)` — same
 * pattern as `agent-chat-api.test.ts`. No PGlite, no real executor.
 */

import { test, expect, describe, beforeEach, mock } from "bun:test";

// ── Shared mutable state the mocks read ────────────────────────────────

type Conversation = {
  id: string;
  userId: string | null;
  projectId: string | null;
  parentConversationId: string | null;
  agentConfigId: string | null;
  modeId: string | null;
  systemPrompt: string | null;
  model?: string | null;
  provider?: string | null;
};

const ownerUser = { id: "owner-1", email: "owner@x", name: "Owner", role: "member" };
const adminUser = { id: "admin-1", email: "admin@x", name: "Admin", role: "admin" };
const strangerUser = { id: "stranger-1", email: "s@x", name: "S", role: "member" };

let mockConv: Conversation | null = null;
let mockLatestLeaf: { id: string } | null = null;
let mockActiveRun: unknown = null;
let mockBudget: { allowed: boolean; resetsAt?: string } = { allowed: true };

// ── db/queries/conversations ───────────────────────────────────────────

const mockGetConversation = mock(async (_id: string) => mockConv);
const mockGetLatestLeaf = mock(async (_id: string) => mockLatestLeaf);
const mockGetConversationPath = mock(async (_leaf: string, _cid: string) => [] as unknown[]);
const mockGetMessages = mock(async (_cid: string) => [] as unknown[]);
const mockGetMessagesWithToolCalls = mock(async (_cid: string) => ({ messages: [] }));
const mockGetSubConversationToolCalls = mock(async (_cid: string) => ({}));
const mockCreateMessage = mock(async (_cid: string, opts: { role: string; content: string; parentMessageId?: string }) => ({
  id: "msg-new",
  role: opts.role,
  content: opts.content,
  parentMessageId: opts.parentMessageId,
  createdAt: new Date(),
}));
const mockUpdateMessageContent = mock(async (_cid: string, mid: string, content: string) => ({
  id: mid,
  content,
}));
const mockSetMessageExcluded = mock(async (_cid: string, mid: string, excluded: boolean) => ({
  id: mid,
  excluded,
}));

mock.module("$server/db/queries/conversations", () => ({
  getConversation: mockGetConversation,
  getLatestLeaf: mockGetLatestLeaf,
  getConversationPath: mockGetConversationPath,
  getMessages: mockGetMessages,
  getMessagesWithToolCalls: mockGetMessagesWithToolCalls,
  getSubConversationToolCalls: mockGetSubConversationToolCalls,
  createMessage: mockCreateMessage,
  updateMessageContent: mockUpdateMessageContent,
  setMessageExcluded: mockSetMessageExcluded,
}));

const mockGetActiveRun = mock(async (_cid: string) => mockActiveRun);
mock.module("$server/db/queries/active-runs", () => ({
  getActiveRun: mockGetActiveRun,
}));

mock.module("$server/db/queries/attachments", () => ({
  insertAttachment: mock(async () => ({ id: "att-1" })),
  listAttachmentsForMessage: mock(async () => []),
  deleteAttachmentsForMessage: mock(async () => undefined),
}));

mock.module("$server/db/queries/projects", () => ({
  getProject: mock(async () => null),
}));

// ── auth + scope ───────────────────────────────────────────────────────

let mockAuthUser: { id: string; email: string; name: string; role: string } | null = ownerUser;
mock.module("$server/auth/middleware", () => ({
  requireAuth: (locals: { user?: unknown }) => {
    const u = locals?.user ?? mockAuthUser;
    if (!u) throw Response.json({ error: "Unauthorized" }, { status: 401 });
    return u;
  },
}));

mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => null,
}));

mock.module("$lib/server/security/resource-quotas", () => ({
  checkTokenBudget: mock(async () => mockBudget),
}));

// ── executor / context / misc ──────────────────────────────────────────

const mockStreamChat = mock(() => ({ catch: () => Promise.resolve(), then: () => Promise.resolve() }));
mock.module("$lib/server/context", () => ({
  getExecutor: () => ({ streamChat: mockStreamChat }),
  getBus: () => ({ emit: mock(() => {}) }),
  // The messages POST handler now imports `getGoalHost` and calls it to
  // rehydrate a conversation's `/goal` record before streaming. Returning
  // `null` matches the "goal feature off / not initialized" path (see
  // context.ts:getGoalHost), so the optional rehydrate block is skipped and
  // the ownership matrix under test is unchanged.
  getGoalHost: () => null,
}));

mock.module("$lib/server/command-resolver", () => ({
  buildCommandResolver: () => async () => null,
}));

mock.module("$server/providers/model-capabilities", () => ({
  getCapabilitiesWithExtensions: () => ({ maxFilesPerMessage: 0 }),
  classifyMimeWithCaps: () => null,
}));

mock.module("$server/db/queries/conversation-extensions", () => ({
  getConversationExtensionMimes: async () => [],
  getExtensionMimesByNames: () => [],
}));

mock.module("$server/chat/attachments/validator", () => ({
  validateAttachment: async () => ({ ok: true, canonicalMime: "text/plain" }),
}));

mock.module("$server/chat/attachments/storage", () => ({
  writeAttachment: async () => ({ storagePath: "p", sizeBytes: 1 }),
  readAttachmentBytes: async () => new Uint8Array(),
  deleteForMessage: async () => undefined,
}));

mock.module("$server/runtime/mention-wiring", () => ({
  stripEzActionTokens: (c: string) => ({ stripped: c, actions: [] }),
}));

mock.module("$server/runtime/ez-actions/registry", () => ({
  getEzAction: () => null,
}));

// ── Import handlers AFTER mocks ────────────────────────────────────────

const { GET, POST } = await import(
  "../routes/api/conversations/[id]/messages/+server"
);
const { PATCH } = await import(
  "../routes/api/conversations/[id]/messages/[mid]/+server"
);

// ── Helpers ────────────────────────────────────────────────────────────

function getEvent(user: unknown) {
  return {
    url: new URL("http://localhost/api/conversations/c1/messages"),
    params: { id: "c1" },
    locals: { user },
    request: new Request("http://localhost/api/conversations/c1/messages", { method: "GET" }),
  } as never;
}

function postEvent(user: unknown, body: Record<string, unknown> = { content: "hi" }) {
  return {
    url: new URL("http://localhost/api/conversations/c1/messages"),
    params: { id: "c1" },
    locals: { user },
    request: new Request("http://localhost/api/conversations/c1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  } as never;
}

function patchEvent(user: unknown, body: Record<string, unknown> = { content: "edited" }) {
  return {
    url: new URL("http://localhost/api/conversations/c1/messages/m1"),
    params: { id: "c1", mid: "m1" },
    locals: { user },
    request: new Request("http://localhost/api/conversations/c1/messages/m1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  } as never;
}

/** A parentless (top-level) conversation owned by `ownerUser`. */
function topLevelConv(): Conversation {
  return {
    id: "c1",
    userId: ownerUser.id,
    projectId: "proj-1",
    parentConversationId: null,
    agentConfigId: null,
    modeId: null,
    systemPrompt: null,
    model: null,
    provider: null,
  };
}

function resetState() {
  mockConv = topLevelConv();
  mockLatestLeaf = null;
  mockActiveRun = null;
  mockBudget = { allowed: true };
  mockAuthUser = ownerUser;

  mockGetConversation.mockReset();
  mockGetConversation.mockImplementation(async () => mockConv);
  mockGetLatestLeaf.mockReset();
  mockGetLatestLeaf.mockImplementation(async () => mockLatestLeaf);
  mockGetConversationPath.mockReset();
  mockGetConversationPath.mockImplementation(async () => []);
  mockGetMessages.mockReset();
  mockGetMessages.mockImplementation(async () => []);
  mockCreateMessage.mockReset();
  mockCreateMessage.mockImplementation(async (_cid: string, opts: { role: string; content: string; parentMessageId?: string }) => ({
    id: "msg-new",
    role: opts.role,
    content: opts.content,
    parentMessageId: opts.parentMessageId,
    createdAt: new Date(),
  }));
  mockUpdateMessageContent.mockReset();
  mockUpdateMessageContent.mockImplementation(async (_cid: string, mid: string, content: string) => ({ id: mid, content }));
  mockSetMessageExcluded.mockReset();
  mockSetMessageExcluded.mockImplementation(async (_cid: string, mid: string, excluded: boolean) => ({ id: mid, excluded }));
  mockGetActiveRun.mockReset();
  mockGetActiveRun.mockImplementation(async () => mockActiveRun);
  mockStreamChat.mockReset();
  mockStreamChat.mockImplementation(() => ({
    catch: () => Promise.resolve(),
    then: () => Promise.resolve(),
  }));
}

// ── GET ────────────────────────────────────────────────────────────────

describe("BASELINE GET /api/conversations/[id]/messages — top-level ownership matrix", () => {
  beforeEach(resetState);

  test("owner: 200, returns path for latest leaf", async () => {
    mockLatestLeaf = { id: "leaf-1" };
    mockGetConversationPath.mockImplementation(async () => [{ id: "leaf-1", role: "user", content: "hi" }]);
    const res = await GET(getEvent(ownerUser));
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(Array.isArray(body)).toBe(true);
  });

  test("owner with no leaf: 200, empty array", async () => {
    mockLatestLeaf = null;
    const res = await GET(getEvent(ownerUser));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("admin (non-owner): 200", async () => {
    mockConv = { ...topLevelConv(), userId: "someone-else" };
    mockLatestLeaf = null;
    const res = await GET(getEvent(adminUser));
    expect(res.status).toBe(200);
  });

  test("non-owner non-admin: 404 Not found", async () => {
    mockConv = { ...topLevelConv(), userId: "someone-else" };
    const res = await GET(getEvent(strangerUser));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error?: string }).error).toBe("Not found");
  });

  test("userId=null top-level conv, non-admin: 404 (sec-H3 fail-closed)", async () => {
    mockConv = { ...topLevelConv(), userId: null };
    const res = await GET(getEvent(strangerUser));
    expect(res.status).toBe(404);
  });

  test("conversation missing: 404 Not found", async () => {
    mockConv = null;
    const res = await GET(getEvent(ownerUser));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error?: string }).error).toBe("Not found");
  });

  test("?all=true returns full message list for owner", async () => {
    mockGetMessages.mockImplementation(async () => [{ id: "m1" }, { id: "m2" }]);
    const ev = getEvent(ownerUser);
    (ev as { url: URL }).url = new URL("http://localhost/api/conversations/c1/messages?all=true");
    const res = await GET(ev);
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown[]).toHaveLength(2);
  });
});

// ── POST ───────────────────────────────────────────────────────────────

describe("BASELINE POST /api/conversations/[id]/messages — top-level ownership matrix", () => {
  beforeEach(resetState);

  test("owner: 200, creates user message + runId", async () => {
    const res = await POST(postEvent(ownerUser));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userMessage: { id: string }; runId: string };
    expect(body.userMessage.id).toBe("msg-new");
    expect(typeof body.runId).toBe("string");
  });

  test("admin (non-owner): 200", async () => {
    mockConv = { ...topLevelConv(), userId: "someone-else" };
    const res = await POST(postEvent(adminUser));
    expect(res.status).toBe(200);
  });

  test("non-owner non-admin: 404 Not found", async () => {
    mockConv = { ...topLevelConv(), userId: "someone-else" };
    const res = await POST(postEvent(strangerUser));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error?: string }).error).toBe("Not found");
  });

  test("conversation missing: 404", async () => {
    mockConv = null;
    const res = await POST(postEvent(ownerUser));
    expect(res.status).toBe(404);
  });

  test("budget-exceeded gate fires AFTER ownership passes → 429", async () => {
    mockBudget = { allowed: false, resetsAt: "2026-06-01T00:00:00Z" };
    const res = await POST(postEvent(ownerUser));
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error?: string }).error).toBe("Daily token budget exceeded");
  });

  test("non-owner is rejected 404 BEFORE the budget gate (ownership precedence)", async () => {
    mockConv = { ...topLevelConv(), userId: "someone-else" };
    mockBudget = { allowed: false };
    const res = await POST(postEvent(strangerUser));
    expect(res.status).toBe(404);
  });

  test("empty content: 400 (schema, after ownership)", async () => {
    const res = await POST(postEvent(ownerUser, { content: "" }));
    expect(res.status).toBe(400);
  });
});

// ── PATCH ──────────────────────────────────────────────────────────────

describe("BASELINE PATCH /api/conversations/[id]/messages/[mid] — top-level ownership matrix", () => {
  beforeEach(resetState);

  test("owner content edit: 200", async () => {
    const res = await PATCH(patchEvent(ownerUser, { content: "edited text" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { content?: string }).content).toBe("edited text");
  });

  test("owner excluded toggle: 200", async () => {
    const res = await PATCH(patchEvent(ownerUser, { excluded: true }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { excluded?: boolean }).excluded).toBe(true);
  });

  test("admin (non-owner): 200", async () => {
    mockConv = { ...topLevelConv(), userId: "someone-else" };
    const res = await PATCH(patchEvent(adminUser, { content: "x" }));
    expect(res.status).toBe(200);
  });

  test("non-owner non-admin: 404 Not found", async () => {
    mockConv = { ...topLevelConv(), userId: "someone-else" };
    const res = await PATCH(patchEvent(strangerUser, { content: "x" }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error?: string }).error).toBe("Not found");
  });

  test("conversation missing: 404", async () => {
    mockConv = null;
    const res = await PATCH(patchEvent(ownerUser, { content: "x" }));
    expect(res.status).toBe(404);
  });

  test("active-run gate fires AFTER ownership passes → 409", async () => {
    mockActiveRun = { id: "run-active", status: "running" };
    const res = await PATCH(patchEvent(ownerUser, { content: "x" }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toContain("active run");
  });

  test("non-owner is rejected 404 BEFORE the active-run gate (ownership precedence)", async () => {
    mockConv = { ...topLevelConv(), userId: "someone-else" };
    mockActiveRun = { id: "run-active" };
    const res = await PATCH(patchEvent(strangerUser, { content: "x" }));
    expect(res.status).toBe(404);
  });

  test("invalid body (both fields) rejected 400 after ownership", async () => {
    const res = await PATCH(patchEvent(ownerUser, { content: "x", excluded: true }));
    expect(res.status).toBe(400);
  });
});
