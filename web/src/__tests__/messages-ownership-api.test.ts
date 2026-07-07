/**
 * PHASE 2 — Per-message endpoints adopt resolveRootConversationForOwnership.
 *
 * The win this file pins: a NON-ADMIN user who owns the ROOT of a
 * conversation chain can now GET / PATCH / POST per-message on a
 * `userId=null` SUB-conversation under that root (Copy / Retry /
 * Regenerate / Edit parity in the agent sub-chat). Pre-Phase-2 the
 * inline `conv.userId !== user.id` check made sub-convs admin-only.
 *
 * Contract pinned here:
 *   - non-admin ROOT owner → 200 on GET / PATCH / POST of a sub-conv
 *   - non-owner non-admin  → still 404 (no access leaked)
 *   - admin                → 200 (unchanged)
 *   - active-run 409 STILL fires (after ownership passes) on a sub-conv
 *   - budget 429 STILL fires (after ownership passes) on a sub-conv POST
 *   - 2-deep team-member sub-conv: root owner authorized
 *
 * The Phase-0 `messages-ownership-baseline-api.test.ts` pins the
 * top-level matrix and MUST still pass UNCHANGED (root === self for
 * parentless convs) — together the two files prove the helper swap
 * widened access for sub-convs WITHOUT changing top-level behaviour
 * (plan risk-register row #4).
 *
 * `bun test` with the query/runtime modules mocked at the import
 * boundary — same pattern as agent-chat-api.test.ts. No PGlite.
 */

import { test, expect, describe, beforeEach, mock } from "bun:test";

// ── Conversation graph ─────────────────────────────────────────────────
//
//   root-conv  (userId = rootOwner.id, parent = null)
//     └─ sub-conv (userId = null, parent = root-conv)        [1-deep]
//   main-conv  (userId = rootOwner.id, parent = null)
//     └─ orch    (userId = null, parent = main-conv)
//          └─ member (userId = null, parent = orch)          [2-deep]

type Conv = {
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

const rootOwner = { id: "root-owner", email: "r@x", name: "R", role: "member" };
const adminUser = { id: "admin-1", email: "a@x", name: "A", role: "admin" };
const stranger = { id: "stranger", email: "s@x", name: "S", role: "member" };

const GRAPH: Record<string, Conv> = {
  "root-conv": {
    id: "root-conv",
    userId: rootOwner.id,
    projectId: "proj-1",
    parentConversationId: null,
    agentConfigId: null,
    modeId: null,
    systemPrompt: null,
    model: null,
    provider: null,
  },
  "sub-conv": {
    id: "sub-conv",
    userId: null, // unowned — admin-only before Phase 2
    projectId: "proj-1",
    parentConversationId: "root-conv",
    agentConfigId: "agent-cfg",
    modeId: null,
    systemPrompt: null,
    model: null,
    provider: null,
  },
  "main-conv": {
    id: "main-conv",
    userId: rootOwner.id,
    projectId: "proj-1",
    parentConversationId: null,
    agentConfigId: null,
    modeId: null,
    systemPrompt: null,
  },
  orch: {
    id: "orch",
    userId: null,
    projectId: "proj-1",
    parentConversationId: "main-conv",
    agentConfigId: null,
    modeId: null,
    systemPrompt: null,
  },
  member: {
    id: "member",
    userId: null,
    projectId: "proj-1",
    parentConversationId: "orch",
    agentConfigId: "member-cfg",
    modeId: null,
    systemPrompt: null,
  },
};

let mockActiveRun: unknown = null;
let mockBudget: { allowed: boolean; resetsAt?: string } = { allowed: true };

const mockGetConversation = mock(async (id: string) => GRAPH[id] ?? null);
const mockGetLatestLeaf = mock(async (_id: string) => null as { id: string } | null);
const mockGetConversationPath = mock(async () => [] as unknown[]);
const mockGetMessages = mock(async () => [] as unknown[]);
const mockCreateMessage = mock(async (_cid: string, opts: { role: string; content: string; parentMessageId?: string }) => ({
  id: "msg-new",
  role: opts.role,
  content: opts.content,
  parentMessageId: opts.parentMessageId,
  createdAt: new Date(),
}));
const mockUpdateMessageContent = mock(async (_cid: string, mid: string, content: string) => ({ id: mid, content }));
const mockSetMessageExcluded = mock(async (_cid: string, mid: string, excluded: boolean) => ({ id: mid, excluded }));

mock.module("$server/db/queries/conversations", () => ({
  getConversation: mockGetConversation,
  getLatestLeaf: mockGetLatestLeaf,
  getConversationPath: mockGetConversationPath,
  getMessages: mockGetMessages,
  getMessagesWithToolCalls: mock(async () => ({ messages: [] })),
  getSubConversationToolCalls: mock(async () => ({})),
  createMessage: mockCreateMessage,
  updateMessageContent: mockUpdateMessageContent,
  setMessageExcluded: mockSetMessageExcluded,
}));

const mockGetActiveRun = mock(async (_cid: string) => mockActiveRun);
mock.module("$server/db/queries/active-runs", () => ({ getActiveRun: mockGetActiveRun }));

mock.module("$server/db/queries/attachments", () => ({
  insertAttachment: mock(async () => ({ id: "att-1" })),
  deleteAttachmentsForMessage: mock(async () => undefined),
}));
mock.module("$server/db/queries/projects", () => ({ getProject: mock(async () => null) }));

mock.module("$server/auth/middleware", () => ({
  requireAuth: (locals: { user?: unknown }) => {
    const u = locals?.user;
    if (!u) throw Response.json({ error: "Unauthorized" }, { status: 401 });
    return u;
  },
}));
mock.module("$lib/server/security/api-keys", () => ({ requireScope: () => null }));
mock.module("$lib/server/security/resource-quotas", () => ({
  checkTokenBudget: mock(async () => mockBudget),
}));

// Captured at the module boundary so the self-scope test below can
// assert exactly which { model, provider } reached the executor. The
// promise needs `.then`/`.catch`/`.finally` because the POST handler
// chains lifecycle handlers onto it.
const settled = Promise.resolve();
const mockStreamChat = mock(
  (_cid: string, _content: string, _opts: { model?: string; provider?: string }) => settled,
);
mock.module("$lib/server/context", () => ({
  getExecutor: () => ({ streamChat: mockStreamChat }),
  getBus: () => ({ emit: mock(() => {}) }),
  // The messages POST handler now imports `getGoalHost` and calls it to
  // rehydrate a conversation's `/goal` record before streaming. Returning
  // `null` matches the "goal feature off / not initialized" path (see
  // context.ts:getGoalHost), so the optional rehydrate block is skipped and
  // ownership/streamChat behaviour under test is unchanged.
  getGoalHost: () => null,
}));
mock.module("$lib/server/command-resolver", () => ({ buildCommandResolver: () => async () => null }));
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
  deleteForMessage: async () => undefined,
}));
mock.module("$server/runtime/mention-wiring", () => ({
  stripEzActionTokens: (c: string) => ({ stripped: c, actions: [] }),
}));
mock.module("$server/runtime/ez-actions/registry", () => ({ getEzAction: () => null }));

const { GET, POST } = await import(
  "../routes/api/conversations/[id]/messages/+server"
);
const { PATCH } = await import(
  "../routes/api/conversations/[id]/messages/[mid]/+server"
);

function getEvent(cid: string, user: unknown) {
  return {
    url: new URL(`http://localhost/api/conversations/${cid}/messages`),
    params: { id: cid },
    locals: { user },
    request: new Request(`http://localhost/api/conversations/${cid}/messages`, { method: "GET" }),
  } as never;
}
function postEvent(cid: string, user: unknown, body: Record<string, unknown> = { content: "hi" }) {
  return {
    url: new URL(`http://localhost/api/conversations/${cid}/messages`),
    params: { id: cid },
    locals: { user },
    request: new Request(`http://localhost/api/conversations/${cid}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  } as never;
}
function patchEvent(cid: string, user: unknown, body: Record<string, unknown> = { content: "edited" }) {
  return {
    url: new URL(`http://localhost/api/conversations/${cid}/messages/m1`),
    params: { id: cid, mid: "m1" },
    locals: { user },
    request: new Request(`http://localhost/api/conversations/${cid}/messages/m1`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  } as never;
}

beforeEach(() => {
  mockActiveRun = null;
  mockBudget = { allowed: true };
  mockGetConversation.mockReset();
  mockGetConversation.mockImplementation(async (id: string) => GRAPH[id] ?? null);
  mockGetLatestLeaf.mockReset();
  mockGetLatestLeaf.mockImplementation(async () => null);
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
  mockStreamChat.mockImplementation(() => settled);
});

// ── The widened access: non-admin ROOT owner on a userId=null sub ────

describe("non-admin ROOT owner CAN act on a userId=null 1-deep sub-conv", () => {
  test("GET sub-conv → 200 (was admin-only before Phase 2)", async () => {
    const res = await GET(getEvent("sub-conv", rootOwner));
    expect(res.status).toBe(200);
  });

  test("POST sub-conv → 200, creates the user message", async () => {
    const res = await POST(postEvent("sub-conv", rootOwner));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userMessage: { id: string }; runId: string };
    expect(body.userMessage.id).toBe("msg-new");
    expect(typeof body.runId).toBe("string");
  });

  test("PATCH sub-conv content edit → 200", async () => {
    const res = await PATCH(patchEvent("sub-conv", rootOwner, { content: "new" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { content?: string }).content).toBe("new");
  });

  test("PATCH sub-conv excluded toggle → 200", async () => {
    const res = await PATCH(patchEvent("sub-conv", rootOwner, { excluded: true }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { excluded?: boolean }).excluded).toBe(true);
  });
});

// ── Non-owner still locked out (no access leaked) ───────────────────

describe("non-owner non-admin still 404 on the sub-conv", () => {
  test("GET → 404", async () => {
    const res = await GET(getEvent("sub-conv", stranger));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error?: string }).error).toBe("Not found");
  });
  test("POST → 404", async () => {
    const res = await POST(postEvent("sub-conv", stranger));
    expect(res.status).toBe(404);
  });
  test("PATCH → 404", async () => {
    const res = await PATCH(patchEvent("sub-conv", stranger, { content: "x" }));
    expect(res.status).toBe(404);
  });
  test("non-owner POST is rejected BEFORE the budget gate", async () => {
    mockBudget = { allowed: false };
    const res = await POST(postEvent("sub-conv", stranger));
    expect(res.status).toBe(404); // ownership precedence preserved
  });
});

// ── Admin unchanged ─────────────────────────────────────────────────

describe("admin still authorized on the sub-conv (unchanged)", () => {
  test("GET → 200", async () => {
    const res = await GET(getEvent("sub-conv", adminUser));
    expect(res.status).toBe(200);
  });
  test("PATCH → 200", async () => {
    const res = await PATCH(patchEvent("sub-conv", adminUser, { content: "x" }));
    expect(res.status).toBe(200);
  });
});

// ── Side-gates STILL fire after ownership passes ────────────────────

describe("409 / 429 side-gates preserved on the sub-conv (post-ownership)", () => {
  test("active-run on sub-conv → PATCH 409 for the root owner", async () => {
    mockActiveRun = { id: "run-active", status: "running" };
    const res = await PATCH(patchEvent("sub-conv", rootOwner, { content: "x" }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error?: string }).error).toContain("active run");
  });

  test("active-run gate is reached ONLY after ownership: non-owner gets 404 not 409", async () => {
    mockActiveRun = { id: "run-active" };
    const res = await PATCH(patchEvent("sub-conv", stranger, { content: "x" }));
    expect(res.status).toBe(404);
  });

  test("budget exceeded on sub-conv POST → 429 for the root owner", async () => {
    mockBudget = { allowed: false, resetsAt: "2026-06-01T00:00:00Z" };
    const res = await POST(postEvent("sub-conv", rootOwner));
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error?: string }).error).toBe("Daily token budget exceeded");
  });
});

// ── 2-deep team-member sub-conversation ─────────────────────────────

describe("2-deep team-member sub-conv (member → orch → main)", () => {
  test("GET member → 200 for the root (main) owner", async () => {
    const res = await GET(getEvent("member", rootOwner));
    expect(res.status).toBe(200);
  });
  test("POST member → 200 for the root owner", async () => {
    const res = await POST(postEvent("member", rootOwner));
    expect(res.status).toBe(200);
  });
  test("PATCH member → 200 for the root owner", async () => {
    const res = await PATCH(patchEvent("member", rootOwner, { content: "x" }));
    expect(res.status).toBe(200);
  });
  test("non-owner → 404 on the 2-deep member", async () => {
    const res = await GET(getEvent("member", stranger));
    expect(res.status).toBe(404);
  });
  test("admin → 200 on the 2-deep member", async () => {
    const res = await GET(getEvent("member", adminUser));
    expect(res.status).toBe(200);
  });
});

// ── Self-scope: sub-conv POST uses the SUB's model, NOT the root's ──
//
// `messages/+server.ts` POST resolves `model`/`provider` from
// `ownership.conv` (SELF), never `ownership.root` — documented at
// `messages/+server.ts:116–123` ("`ownership.conv` (self) drives all
// conversation-scoped reads … the root only gates access"). Before
// this test that contract was only TRANSITIVELY covered (the POST
// sub-conv tests assert status 200, with both rows' model = null, so a
// hypothetical root-scope regression would still 200 and stream the
// wrong model silently). This pins the asymmetry directly so Phase 4
// (ChatThread extraction) can't regress sub-conv runs onto the root's
// model/provider without a red test. The coverage auditor flagged this
// as "do before Phase 4".
describe("sub-conv POST self-scopes model/provider (not the root's)", () => {
  test("streamChat receives the SUB-conv's model/provider, not the root's", async () => {
    // Distinct graph: root carries m-root/p-root, the userId=null sub
    // it owns carries its OWN m-sub/p-sub. The root owner POSTs into
    // the sub. If the handler scoped to the root we'd see m-root.
    const scopedGraph: Record<string, Conv> = {
      "scoped-root": {
        id: "scoped-root",
        userId: rootOwner.id,
        projectId: "proj-1",
        parentConversationId: null,
        agentConfigId: null,
        modeId: null,
        systemPrompt: null,
        model: "m-root",
        provider: "p-root",
      },
      "scoped-sub": {
        id: "scoped-sub",
        userId: null,
        projectId: "proj-1",
        parentConversationId: "scoped-root",
        agentConfigId: "agent-cfg",
        modeId: null,
        systemPrompt: null,
        model: "m-sub",
        provider: "p-sub",
      },
    };
    mockGetConversation.mockImplementation(async (id: string) => scopedGraph[id] ?? null);

    const res = await POST(postEvent("scoped-sub", rootOwner, { content: "hi" }));
    expect(res.status).toBe(200);

    expect(mockStreamChat).toHaveBeenCalledTimes(1);
    const call = mockStreamChat.mock.calls[0] as unknown as [
      string,
      string,
      { model?: string; provider?: string },
    ];
    expect(call[0]).toBe("scoped-sub"); // streamed on the sub itself
    expect(call[2].model).toBe("m-sub"); // SELF scope — NOT "m-root"
    expect(call[2].provider).toBe("p-sub"); // SELF scope — NOT "p-root"
  });
});

// ── Missing conversation still 404 ──────────────────────────────────

describe("missing conversation still 404 (fail-closed)", () => {
  test("GET nonexistent → 404", async () => {
    const res = await GET(getEvent("nope", rootOwner));
    expect(res.status).toBe(404);
  });
  test("PATCH nonexistent → 404", async () => {
    const res = await PATCH(patchEvent("nope", rootOwner, { content: "x" }));
    expect(res.status).toBe(404);
  });
});
