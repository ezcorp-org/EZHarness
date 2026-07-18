/**
 * POST /api/extensions/[name]/events/[event]
 *
 * Boundary tests for the Phase A2 generic event route. Replaces the
 * pattern of per-extension bespoke POST routes (e.g.
 * `/api/ask-user/answer`) with a single endpoint that the
 * `EventSubscriptionDispatcher`'s `registerExtensionEvent` populates
 * with valid `<extName>:<event>` pairs.
 *
 * The endpoint:
 *   1. Rejects requests missing the `chat` scope.
 *   2. Validates URL params against the manifest-name regex.
 *   3. Rejects unknown events (unregistered in the SSE filter).
 *   4. Rejects malformed bodies.
 *   5. Returns 404 when the requesting user doesn't own the
 *      `conversationId` from the request body.
 *   6. On success, emits exactly one bus event with the full event
 *      name and a flat payload (toolCallId/conversationId siblings
 *      of any user-supplied passthrough data).
 *
 * Mirrors `ask-user-answer-route.test.ts` for the legacy bespoke
 * endpoint.
 */

import { test, expect, describe, beforeEach, mock } from "bun:test";

// ── Mock auth + scope middleware ──────────────────────────────────

let mockScopeResponse: Response | null = null;
mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => mockScopeResponse,
}));

mock.module("$server/auth/middleware", () => ({
  requireAuth: () => ({
    id: "user-1",
    email: "t@t.com",
    name: "T",
    role: "member",
  }),
}));

// ── Mock bus via $lib/server/context ───────────────────────────────

const mockBusEmit = mock((..._args: unknown[]) => {});
const mockBus = { emit: mockBusEmit };
// The route's spawn-path re-wire (out-of-turn wirer fix) also imports
// getExecutor; a partial mock that omits it fails EVERY import from the
// module at load ("Export named 'getExecutor' not found"). Default: a
// minimal fake executor so the FULL-wiring path (setExecutor +
// setSpawnQuota) executes; a test flips `getExecutorImpl` to a throw to
// exercise the route's guarded executor-less catch (spawn path unwired).
const fakeExecutor = { spawnQuota: {} } as unknown;
let getExecutorImpl: () => unknown = () => fakeExecutor;
mock.module("$lib/server/context", () => ({
  getBus: () => mockBus,
  getExecutor: () => getExecutorImpl(),
}));

// ── Mock errorJson + json (mirror ask-user-answer-route.test.ts) ──

mock.module("$lib/server/http-errors", () => ({
  errorJson: (status: number, message: string) =>
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
}));

// ── Mock the SSE filter's extension-event registry ────────────────
//
// The route gates delivery on `isRegisteredExtensionEvent(fullName)`.
// We drive the test by setting `mockRegisteredEvents` per-case.

const mockRegisteredEvents = new Set<string>();
mock.module("$server/runtime/sse-conversation-filter", () => ({
  isRegisteredExtensionEvent: (eventType: string) =>
    mockRegisteredEvents.has(eventType),
}));

// ── Mock conversation lookup ──────────────────────────────────────

let mockConv:
  | { id: string; userId: string | null }
  | null = null;
const mockGetConversation = mock(
  async (_id: string) => mockConv,
);
mock.module("$server/db/queries/conversations", () => ({
  getConversation: mockGetConversation,
}));

// ── Mock tool-call lookup (F2 cross-binding) ──────────────────────

let mockToolCall:
  | { id: string; conversationId: string | null }
  | null = null;
const mockGetToolCallConversationById = mock(
  async (_id: string) => mockToolCall,
);
mock.module("$server/db/queries/tool-calls", () => ({
  getToolCallConversationById: mockGetToolCallConversationById,
}));

// ── Mock extension lookup + wiring + registry (auto-wire path) ────
//
// The route auto-wires + spawns on messageToolbar-shape events
// (those that carry `messageId` but no `toolCallId`). Drive the
// spawn / wiring expectations from these mocks.

let mockExt:
  | {
      id: string;
      name: string;
      enabled: boolean;
      grantedPermissions?: { appendMessages?: { excludedDefault: boolean } };
    }
  | null = null;
const mockGetExtensionByName = mock(async (_name: string) => mockExt);
mock.module("$server/db/queries/extensions", () => ({
  getExtensionByName: mockGetExtensionByName,
  // The registry (pulled in transitively via the route's imports) needs
  // these named exports; the mock must provide the full imported shape or
  // every import of the module fails with a missing-export error.
  listExtensions: mock(async () => []),
  updateExtension: mock(async () => {}),
}));

let mockWiredIds: string[] = [];
const mockAddConvExt = mock(async (..._args: unknown[]) => {});
const mockGetConvExtIds = mock(async (_convId: string) => mockWiredIds);
mock.module("$server/db/queries/conversation-extensions", () => ({
  addConversationExtensions: mockAddConvExt,
  getConversationExtensionIds: mockGetConvExtIds,
}));

const mockGetProcess = mock(async (_extId: string) => ({}));
mock.module("$server/extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({ getProcess: mockGetProcess }),
  },
}));

// ToolExecutor is constructed by the route to wire reverse-RPC
// handlers on the spawned subprocess (so a future :save callback
// from the browser card finds an onRequest handler). We don't
// exercise its real wiring here — the handler logic is
// unit-tested elsewhere.
const mockEnsureWired = mock(async (..._args: unknown[]) => {});
mock.module("$server/extensions/tool-executor", () => ({
  ToolExecutor: class {
    constructor() {}
    async ensureSubprocessRpcWired(...args: unknown[]) {
      return mockEnsureWired(...args);
    }
  },
}));

// PDP singleton — Plan 03 (SEC-06) wires `engine: getPermissionEngine()`
// into the messageToolbar ctx so handleAppendMessageRpc takes the PDP
// path (line 197) instead of the legacy boolean fallback (line 213-215).
// The route already invoked `getPermissionEngine()` for the subprocess
// wirer (line 319) inside a try/catch, but the new ctx-wiring call runs
// OUTSIDE that try, so the test must provide a stable singleton OR the
// real factory will throw "PermissionEngine not initialized".
//
// We surface the singleton as a sentinel object so the SEC-06 wiring
// assertions can compare identity (`ctx.engine === MOCK_ENGINE`).
const MOCK_ENGINE = { __mock: "permission-engine-singleton" } as unknown;
const mockGetPermissionEngine = mock(() => MOCK_ENGINE);
mock.module("$server/extensions/permission-engine", () => ({
  getPermissionEngine: mockGetPermissionEngine,
}));

// In-process RPC handlers — the route now calls these directly for
// messageToolbar / save events instead of going through the
// subprocess. We capture calls + return canned responses so the
// route's downstream logic (run:turn_saved emit, success response)
// is exercisable without mounting the real DB/registry.
const mockAppendCalls: Array<{ extensionId: string; req: unknown; ctx: unknown }> = [];
let mockAppendResponse: { jsonrpc: "2.0"; id: unknown; result?: unknown; error?: { code: number; message: string } } = {
  jsonrpc: "2.0",
  id: 1,
  result: { messageId: "new-msg-1", toolCallIds: ["tc-new-1"] },
};
mock.module("$server/extensions/append-message-handler", () => ({
  handleAppendMessageRpc: async (extensionId: string, req: unknown, ctx: unknown) => {
    mockAppendCalls.push({ extensionId, req, ctx });
    return mockAppendResponse;
  },
}));

const mockFinalizeCalls: Array<{ extensionId: string; req: unknown; ctx: unknown }> = [];
let mockFinalizeResponse: { jsonrpc: "2.0"; id: unknown; result?: unknown; error?: { code: number; message: string } } = {
  jsonrpc: "2.0",
  id: 1,
  result: { ok: true },
};
mock.module("$server/extensions/finalize-tool-call-handler", () => ({
  handleFinalizeToolCallRpc: async (extensionId: string, req: unknown, ctx: unknown) => {
    mockFinalizeCalls.push({ extensionId, req, ctx });
    return mockFinalizeResponse;
  },
}));

mock.module("$server/logger", () => ({
  logger: {
    child: () => ({
      info: (..._a: unknown[]) => {},
      warn: (..._a: unknown[]) => {},
      error: (..._a: unknown[]) => {},
    }),
  },
}));

// ── Import handler AFTER mocks ────────────────────────────────────

const { POST } = await import(
  "../routes/api/extensions/[name]/events/[event]/+server"
);

// ── Helpers ───────────────────────────────────────────────────────

interface RequestEventLike {
  request: Request;
  locals: Record<string, unknown>;
  params: { name?: string; event?: string };
}

function makeEvent(
  body: unknown,
  params: { name?: string; event?: string } = {
    name: "claude-design",
    event: "knob-change",
  },
): RequestEventLike {
  return {
    request: new Request(
      `http://localhost/api/extensions/${params.name}/events/${params.event}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
    ),
    locals: {
      user: { id: "user-1", email: "t@t.com", name: "T", role: "member" },
    },
    params,
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("POST /api/extensions/[name]/events/[event]", () => {
  beforeEach(() => {
    mockScopeResponse = null;
    mockBusEmit.mockClear();
    mockGetConversation.mockClear();
    mockGetToolCallConversationById.mockClear();
    mockGetExtensionByName.mockClear();
    mockAddConvExt.mockClear();
    mockGetConvExtIds.mockClear();
    mockGetProcess.mockClear();
    mockRegisteredEvents.clear();
    mockConv = null;
    mockToolCall = null;
    mockExt = null;
    mockWiredIds = [];
    mockEnsureWired.mockClear();
    mockAppendCalls.length = 0;
    mockFinalizeCalls.length = 0;
    mockGetPermissionEngine.mockClear();
    mockAppendResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: { messageId: "new-msg-1", toolCallIds: ["tc-new-1"] },
    };
    mockFinalizeResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    };
  });

  // ── Auth ────────────────────────────────────────────────────────

  test("scope rejection short-circuits before any further work", async () => {
    mockScopeResponse = new Response("forbidden", { status: 403 });
    const res = await POST(
      makeEvent({
        toolCallId: "tc",
        conversationId: "c",
      }) as never,
    );
    expect(res.status).toBe(403);
    expect(mockGetConversation).not.toHaveBeenCalled();
    expect(mockBusEmit).not.toHaveBeenCalled();
  });

  // ── URL param validation ────────────────────────────────────────

  test("invalid extension-name in URL → 404 (defense-in-depth on router)", async () => {
    mockRegisteredEvents.add("Bad Name:knob-change");
    const res = await POST(
      makeEvent(
        { toolCallId: "tc", conversationId: "c" },
        { name: "Bad Name", event: "knob-change" },
      ) as never,
    );
    expect(res.status).toBe(404);
    expect(mockBusEmit).not.toHaveBeenCalled();
  });

  test("invalid event-name in URL → 404", async () => {
    const res = await POST(
      makeEvent(
        { toolCallId: "tc", conversationId: "c" },
        { name: "ext", event: "Bad Event!" },
      ) as never,
    );
    expect(res.status).toBe(404);
    expect(mockBusEmit).not.toHaveBeenCalled();
  });

  test("missing extension-name param → 404", async () => {
    const res = await POST(
      makeEvent(
        { toolCallId: "tc", conversationId: "c" },
        { event: "knob-change" },
      ) as never,
    );
    expect(res.status).toBe(404);
  });

  // ── Unregistered event ──────────────────────────────────────────

  test("unregistered event (not declared by extension) → 404", async () => {
    // mockRegisteredEvents is empty — every event is unknown
    const res = await POST(
      makeEvent({ toolCallId: "tc", conversationId: "c" }) as never,
    );
    expect(res.status).toBe(404);
    expect(mockBusEmit).not.toHaveBeenCalled();
    // Conversation lookup should NOT happen if the event is unregistered
    expect(mockGetConversation).not.toHaveBeenCalled();
  });

  // ── Body validation ─────────────────────────────────────────────

  test("missing conversationId → 400", async () => {
    mockRegisteredEvents.add("claude-design:knob-change");
    const res = await POST(
      makeEvent({ toolCallId: "tc" }) as never,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid body");
    expect(mockBusEmit).not.toHaveBeenCalled();
  });

  test("missing toolCallId → 400", async () => {
    mockRegisteredEvents.add("claude-design:knob-change");
    const res = await POST(
      makeEvent({ conversationId: "c" }) as never,
    );
    expect(res.status).toBe(400);
    expect(mockBusEmit).not.toHaveBeenCalled();
  });

  test("malformed JSON body → 400", async () => {
    mockRegisteredEvents.add("claude-design:knob-change");
    const res = await POST(makeEvent("not-json") as never);
    expect(res.status).toBe(400);
    expect(mockBusEmit).not.toHaveBeenCalled();
  });

  test("over-long toolCallId → 400 (boundary protection)", async () => {
    mockRegisteredEvents.add("claude-design:knob-change");
    const res = await POST(
      makeEvent({
        toolCallId: "x".repeat(257),
        conversationId: "c",
      }) as never,
    );
    expect(res.status).toBe(400);
  });

  test("over-long conversationId → 400 (boundary protection)", async () => {
    mockRegisteredEvents.add("claude-design:knob-change");
    const res = await POST(
      makeEvent({
        toolCallId: "tc",
        conversationId: "c".repeat(257),
      }) as never,
    );
    expect(res.status).toBe(400);
  });

  test("OpenAI-shaped toolCallId (~83 chars `call_…|fc_…`) accepted (regression for the 64→256 bump)", async () => {
    mockRegisteredEvents.add("claude-design:knob-change");
    mockConv = { id: "c1", userId: "user-1" };
    const openaiId = "call_" + "a".repeat(24) + "|fc_" + "b".repeat(48);
    expect(openaiId.length).toBe(81);
    const res = await POST(
      makeEvent({
        toolCallId: openaiId,
        conversationId: "c1",
        knobs: { primaryColor: "#ff0066" },
      }) as never,
    );
    expect(res.status).toBe(200);
    expect(mockBusEmit).toHaveBeenCalledTimes(1);
  });

  test("Anthropic-shaped toolCallId (`toolu_…` ~30 chars) accepted", async () => {
    mockRegisteredEvents.add("claude-design:knob-change");
    mockConv = { id: "c1", userId: "user-1" };
    const res = await POST(
      makeEvent({
        toolCallId: "toolu_01XYZabc123def456ghi789j",
        conversationId: "c1",
        knobs: { primaryColor: "#0066ff" },
      }) as never,
    );
    expect(res.status).toBe(200);
    expect(mockBusEmit).toHaveBeenCalledTimes(1);
  });

  // ── Conversation ownership ──────────────────────────────────────

  test("conversation does not exist → 404 (no leakage)", async () => {
    mockRegisteredEvents.add("claude-design:knob-change");
    mockConv = null;
    const res = await POST(
      makeEvent({ toolCallId: "tc", conversationId: "c-missing" }) as never,
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
    expect(mockBusEmit).not.toHaveBeenCalled();
  });

  test("conversation owned by another user → 404 (auth boundary)", async () => {
    mockRegisteredEvents.add("claude-design:knob-change");
    mockConv = { id: "c-other", userId: "stranger" };
    const res = await POST(
      makeEvent({ toolCallId: "tc", conversationId: "c-other" }) as never,
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
    expect(mockBusEmit).not.toHaveBeenCalled();
  });

  test("conversation with null userId → 404 (no anonymous emits)", async () => {
    mockRegisteredEvents.add("claude-design:knob-change");
    mockConv = { id: "c", userId: null };
    const res = await POST(
      makeEvent({ toolCallId: "tc", conversationId: "c" }) as never,
    );
    expect(res.status).toBe(404);
    expect(mockBusEmit).not.toHaveBeenCalled();
  });

  // ── Happy path ──────────────────────────────────────────────────

  test("happy path → 200 + emits one event with the right name + payload shape", async () => {
    mockRegisteredEvents.add("claude-design:knob-change");
    mockConv = { id: "c-1", userId: "user-1" };

    const res = await POST(
      makeEvent({
        toolCallId: "tc-1",
        conversationId: "c-1",
        primaryColor: "#ff0066",
        spacingScale: "+10%",
      }) as never,
    );
    expect(res.status).toBe(200);
    const happyBody = await res.json();
    expect(happyBody.ok).toBe(true);

    expect(mockBusEmit).toHaveBeenCalledTimes(1);
    const [eventName, payload] = mockBusEmit.mock.calls[0] as [string, unknown];
    expect(eventName).toBe("claude-design:knob-change");
    expect(payload).toEqual({
      toolCallId: "tc-1",
      conversationId: "c-1",
      primaryColor: "#ff0066",
      spacingScale: "+10%",
    });
  });

  test("passthrough preserves arbitrary user-defined keys", async () => {
    mockRegisteredEvents.add("ext:evt");
    mockConv = { id: "c-1", userId: "user-1" };

    const res = await POST(
      makeEvent(
        {
          toolCallId: "tc-1",
          conversationId: "c-1",
          arbitrary: { nested: { key: 42 } },
          arr: [1, 2, 3],
        },
        { name: "ext", event: "evt" },
      ) as never,
    );
    expect(res.status).toBe(200);

    const [, payload] = mockBusEmit.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.arbitrary).toEqual({ nested: { key: 42 } });
    expect(payload.arr).toEqual([1, 2, 3]);
  });

  test("evaluation order: scope → URL params → registry → body → ownership", async () => {
    // Validate that an unregistered event returns 404 BEFORE we look up the conversation,
    // so an attacker can't probe conversation existence via the body.
    mockConv = { id: "c", userId: "user-1" };
    // mockRegisteredEvents intentionally empty
    const res = await POST(
      makeEvent({ toolCallId: "tc", conversationId: "c" }) as never,
    );
    expect(res.status).toBe(404);
    expect(mockGetConversation).not.toHaveBeenCalled();
  });

  // ── F2: toolCallId↔conversationId binding ───────────────────────

  test("F2: toolCallId from a different conversation → 404 (cross-binding rejected)", async () => {
    mockRegisteredEvents.add("claude-design:knob-change");
    mockConv = { id: "c-1", userId: "user-1" };
    // Tool call exists but belongs to a different conversation
    mockToolCall = { id: "tc-from-other", conversationId: "c-2" };

    const res = await POST(
      makeEvent({ toolCallId: "tc-from-other", conversationId: "c-1" }) as never,
    );
    expect(res.status).toBe(404);
    expect(mockBusEmit).not.toHaveBeenCalled();
  });

  test("F2: toolCallId not in DB yet (canvas tool returned just now) → still emits", async () => {
    // Canvas extensions persist tool_calls AFTER the subprocess returns.
    // A POST that arrives during that gap should still succeed —
    // missing rows are accepted, only mismatches are rejected.
    mockRegisteredEvents.add("claude-design:knob-change");
    mockConv = { id: "c-1", userId: "user-1" };
    mockToolCall = null;

    const res = await POST(
      makeEvent({ toolCallId: "tc-fresh", conversationId: "c-1" }) as never,
    );
    expect(res.status).toBe(200);
    expect(mockBusEmit).toHaveBeenCalledTimes(1);
  });

  test("F2: toolCallId IS bound to body conversationId → emits", async () => {
    mockRegisteredEvents.add("claude-design:knob-change");
    mockConv = { id: "c-1", userId: "user-1" };
    mockToolCall = { id: "tc-bound", conversationId: "c-1" };

    const res = await POST(
      makeEvent({ toolCallId: "tc-bound", conversationId: "c-1" }) as never,
    );
    expect(res.status).toBe(200);
    expect(mockBusEmit).toHaveBeenCalledTimes(1);
  });

  // ── Body min-length boundaries (.min(1)) ────────────────────────

  test("empty-string toolCallId → 400 (z.string().min(1) lower bound)", async () => {
    mockRegisteredEvents.add("claude-design:knob-change");
    const res = await POST(
      makeEvent({ toolCallId: "", conversationId: "c" }) as never,
    );
    expect(res.status).toBe(400);
    expect(mockBusEmit).not.toHaveBeenCalled();
  });

  test("empty-string conversationId → 400 (z.string().min(1) lower bound)", async () => {
    mockRegisteredEvents.add("claude-design:knob-change");
    const res = await POST(
      makeEvent({ toolCallId: "tc", conversationId: "" }) as never,
    );
    expect(res.status).toBe(400);
  });

  test("non-string toolCallId (number) → 400", async () => {
    mockRegisteredEvents.add("claude-design:knob-change");
    const res = await POST(
      makeEvent({ toolCallId: 12345, conversationId: "c" }) as never,
    );
    expect(res.status).toBe(400);
  });

  test("exactly 256-char toolCallId is the upper bound (.max(256) inclusive)", async () => {
    mockRegisteredEvents.add("claude-design:knob-change");
    mockConv = { id: "c", userId: "user-1" };
    const res = await POST(
      makeEvent({
        toolCallId: "x".repeat(256),
        conversationId: "c",
      }) as never,
    );
    expect(res.status).toBe(200);
    expect(mockBusEmit).toHaveBeenCalledTimes(1);
  });

  // ── Empty URL params ────────────────────────────────────────────

  test("empty event-name in URL → 404 (regex lower bound)", async () => {
    const res = await POST(
      makeEvent(
        { toolCallId: "tc", conversationId: "c" },
        { name: "ext", event: "" },
      ) as never,
    );
    expect(res.status).toBe(404);
    expect(mockBusEmit).not.toHaveBeenCalled();
  });

  // ── Override-protected fields ───────────────────────────────────

  test("user-supplied 'toolCallId' / 'conversationId' in extra payload do NOT override the URL/body fields", async () => {
    // The route destructures `{toolCallId, conversationId, ...userData}`
    // so the spread can never re-introduce a user-supplied
    // `toolCallId`/`conversationId`. This locks that contract — a
    // future refactor that swaps the spread order would fail here.
    mockRegisteredEvents.add("claude-design:knob-change");
    mockConv = { id: "c-1", userId: "user-1" };
    const res = await POST(
      makeEvent({
        toolCallId: "tc-host",
        conversationId: "c-1",
        // The handler's destructure pulls these out before `...userData`,
        // so the bus payload's `conversationId` is the validated body
        // value, not whatever a malicious caller puts into a duplicate.
        // (Zod's loose() preserves the duplicate; our handler does
        // the right thing anyway.)
      }) as never,
    );
    expect(res.status).toBe(200);
    const [, payload] = mockBusEmit.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.toolCallId).toBe("tc-host");
    expect(payload.conversationId).toBe("c-1");
  });

  // ── messageToolbar branch — auto-wire + spawn ─────────────────────

  describe("messageToolbar events (messageId without toolCallId)", () => {
    function kokoroExt(): NonNullable<typeof mockExt> {
      return {
        id: "ext-kokoro",
        name: "kokoro-tts",
        enabled: true,
        grantedPermissions: { appendMessages: { excludedDefault: true } },
      };
    }

    test("auto-wires + calls append-message in-process and emits run:turn_saved", async () => {
      mockRegisteredEvents.add("kokoro-tts:speak");
      mockConv = { id: "c-1", userId: "user-1" };
      mockExt = kokoroExt();
      mockWiredIds = []; // not yet wired

      const res = await POST(
        makeEvent(
          {
            messageId: "m-1",
            conversationId: "c-1",
            content: "Hello world.",
            selection: null,
          },
          { name: "kokoro-tts", event: "speak" },
        ) as never,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.messageId).toBe("new-msg-1");

      // Auto-wire happened.
      expect(mockAddConvExt).toHaveBeenCalledTimes(1);

      // append-message was called directly (no subprocess round-trip
      // means the chain can't break silently across multiple
      // boundaries).
      expect(mockAppendCalls).toHaveLength(1);
      const call = mockAppendCalls[0]!;
      expect(call.extensionId).toBe("ext-kokoro");
      const params = (call.req as { params: Record<string, unknown> }).params;
      expect(params.parentMessageId).toBe("m-1");
      expect(params.role).toBe("extension");
      expect(params.content).toMatch(/TTS of message/);
      expect(params.excluded).toBe(true);
      const tcs = params.toolCalls as Array<{ name: string; cardType: string; status: string; input: { text: string } }>;
      expect(tcs[0]?.cardType).toBe("kokoro-tts-player");
      expect(tcs[0]?.status).toBe("running");
      expect(tcs[0]?.input.text).toBe("Hello world.");

      // run:turn_saved emitted so the chat UI reloads.
      const turnSavedCalls = mockBusEmit.mock.calls.filter(
        (c) => c[0] === "run:turn_saved",
      );
      expect(turnSavedCalls).toHaveLength(1);
      const payload = turnSavedCalls[0]?.[1] as { runId: string; messageId: string };
      expect(payload.runId).toBe("ext:ext-kokoro:new-msg-1");
      expect(payload.messageId).toBe("new-msg-1");
    });

    test("an un-booted executor (getExecutor throws) degrades to the unwired spawn path — event still 200s", async () => {
      // Covers the guarded executor-less catch: the wirer proceeds without
      // setExecutor/setSpawnQuota and the toolbar event still succeeds.
      mockRegisteredEvents.add("kokoro-tts:speak");
      mockConv = { id: "c-1", userId: "user-1" };
      mockExt = kokoroExt();
      mockWiredIds = ["ext-kokoro"];
      const prevImpl = getExecutorImpl;
      getExecutorImpl = () => {
        throw new Error("executor not booted (test context)");
      };
      try {
        const res = await POST(
          makeEvent(
            { messageId: "m-1", conversationId: "c-1", content: "Hi.", selection: null },
            { name: "kokoro-tts", event: "speak" },
          ) as never,
        );
        expect(res.status).toBe(200);
      } finally {
        getExecutorImpl = prevImpl;
      }
    });

    test("uses selection text when present (and labels the header accordingly)", async () => {
      mockRegisteredEvents.add("kokoro-tts:speak");
      mockConv = { id: "c-1", userId: "user-1" };
      mockExt = kokoroExt();
      mockWiredIds = ["ext-kokoro"];

      await POST(
        makeEvent(
          {
            messageId: "m-1",
            conversationId: "c-1",
            content: "Whole message body that should not be used.",
            selection: "  highlighted fragment  ",
          },
          { name: "kokoro-tts", event: "speak" },
        ) as never,
      );

      const params = (mockAppendCalls[0]!.req as { params: Record<string, unknown> }).params;
      expect(params.content).toMatch(/TTS of selection/);
      const tcs = params.toolCalls as Array<{ input: { text: string } }>;
      // Selection is trimmed before use.
      expect(tcs[0]?.input.text).toBe("highlighted fragment");
    });

    test("text is clamped to 4000 chars", async () => {
      mockRegisteredEvents.add("kokoro-tts:speak");
      mockConv = { id: "c-1", userId: "user-1" };
      mockExt = kokoroExt();

      await POST(
        makeEvent(
          {
            messageId: "m-1",
            conversationId: "c-1",
            content: "a".repeat(8000),
            selection: null,
          },
          { name: "kokoro-tts", event: "speak" },
        ) as never,
      );

      const params = (mockAppendCalls[0]!.req as { params: Record<string, unknown> }).params;
      const tcs = params.toolCalls as Array<{ input: { text: string } }>;
      expect(tcs[0]?.input.text.length).toBe(4_000);
    });

    test("disabled extension → 404", async () => {
      mockRegisteredEvents.add("kokoro-tts:speak");
      mockConv = { id: "c-1", userId: "user-1" };
      mockExt = { ...kokoroExt(), enabled: false };

      const res = await POST(
        makeEvent(
          { messageId: "m-1", conversationId: "c-1", content: "hi" },
          { name: "kokoro-tts", event: "speak" },
        ) as never,
      );
      expect(res.status).toBe(404);
      expect(mockAppendCalls).toHaveLength(0);
    });

    test("extension without appendMessages grant → 403", async () => {
      mockRegisteredEvents.add("kokoro-tts:speak");
      mockConv = { id: "c-1", userId: "user-1" };
      mockExt = { ...kokoroExt(), grantedPermissions: {} };

      const res = await POST(
        makeEvent(
          { messageId: "m-1", conversationId: "c-1", content: "hi" },
          { name: "kokoro-tts", event: "speak" },
        ) as never,
      );
      expect(res.status).toBe(403);
      expect(mockAppendCalls).toHaveLength(0);
    });

    test("append-message handler error surfaces as 500", async () => {
      mockRegisteredEvents.add("kokoro-tts:speak");
      mockConv = { id: "c-1", userId: "user-1" };
      mockExt = kokoroExt();
      mockAppendResponse = {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32001, message: "appendMessages permission not granted" },
      };

      const res = await POST(
        makeEvent(
          { messageId: "m-1", conversationId: "c-1", content: "hi" },
          { name: "kokoro-tts", event: "speak" },
        ) as never,
      );
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error).toContain("appendMessages permission not granted");
    });

    test("bulk shape (messageIds[]) → header subject is 'N turns', parent is the last id", async () => {
      // The route accepts EITHER `messageId` (single) OR `messageIds[]`
      // (bulk multi-select). For bulk it: (a) anchors the new turn to
      // the LAST id in the array (chronological-end pin), (b) labels
      // the header `🔊 TTS of N turns (M chars)`, (c) ignores any
      // selection field (bulk has no single highlight).
      mockRegisteredEvents.add("kokoro-tts:speak");
      mockConv = { id: "c-1", userId: "user-1" };
      mockExt = kokoroExt();
      mockWiredIds = ["ext-kokoro"];

      const res = await POST(
        makeEvent(
          {
            messageIds: ["m-old", "m-mid", "m-newest"],
            conversationId: "c-1",
            content: "first turn\n\nsecond\n\nthird",
            // selection should be ignored in bulk mode even if supplied
            selection: "stale highlight",
          },
          { name: "kokoro-tts", event: "speak" },
        ) as never,
      );
      expect(res.status).toBe(200);

      const params = (mockAppendCalls[0]!.req as { params: Record<string, unknown> }).params;
      // Parent anchored to LAST id (most-recent reply in chronological order).
      expect(params.parentMessageId).toBe("m-newest");
      // Header reflects bulk count, not "selection" / "message".
      expect(params.content).toMatch(/TTS of 3 turns/);
      // Concatenated content (not the stale selection) drove the synthesis.
      const tcs = params.toolCalls as Array<{ input: { text: string } }>;
      expect(tcs[0]?.input.text).toContain("first turn");
      expect(tcs[0]?.input.text).toContain("third");
    });

    test("bulk with empty messageIds[] is rejected by the body schema", async () => {
      mockRegisteredEvents.add("kokoro-tts:speak");
      mockConv = { id: "c-1", userId: "user-1" };
      mockExt = kokoroExt();
      const res = await POST(
        makeEvent(
          { messageIds: [], conversationId: "c-1", content: "x" },
          { name: "kokoro-tts", event: "speak" },
        ) as never,
      );
      expect(res.status).toBe(400);
      // No work done — we rejected before the messageToolbar branch ran.
      expect(mockAppendCalls).toHaveLength(0);
    });

    test("body must include at least one of toolCallId / messageId / messageIds", async () => {
      mockRegisteredEvents.add("kokoro-tts:speak");
      mockConv = { id: "c-1", userId: "user-1" };
      mockExt = kokoroExt();
      const res = await POST(
        makeEvent(
          { conversationId: "c-1", content: "x" },
          { name: "kokoro-tts", event: "speak" },
        ) as never,
      );
      expect(res.status).toBe(400);
    });

    test("subprocess spawn/wire failure does NOT block append-message (logged as non-fatal)", async () => {
      mockRegisteredEvents.add("kokoro-tts:speak");
      mockConv = { id: "c-1", userId: "user-1" };
      mockExt = kokoroExt();
      mockGetProcess.mockImplementationOnce(async () => {
        throw new Error("spawn failed");
      });

      const res = await POST(
        makeEvent(
          { messageId: "m-1", conversationId: "c-1", content: "hi" },
          { name: "kokoro-tts", event: "speak" },
        ) as never,
      );
      expect(res.status).toBe(200);
      expect(mockAppendCalls).toHaveLength(1);
    });

    test("canvas-card events (toolCallId present, no attachmentId) emit on the bus as before", async () => {
      mockRegisteredEvents.add("claude-design:knob-change");
      mockConv = { id: "c-1", userId: "user-1" };

      const res = await POST(
        makeEvent({ toolCallId: "tc-1", conversationId: "c-1" }) as never,
      );
      expect(res.status).toBe(200);
      expect(mockAppendCalls).toHaveLength(0);
      expect(mockFinalizeCalls).toHaveLength(0);
      const fanoutCalls = mockBusEmit.mock.calls.filter(
        (c) => c[0] === "claude-design:knob-change",
      );
      expect(fanoutCalls).toHaveLength(1);
    });

    // ── SEC-06 (Phase 54 Plan 03 / Claim-1 close-out) ─────────────────
    //
    // The v1.3 security review's Claim-1 caveat: messageToolbar shortcut
    // posts to /api/extensions/[name]/events/[event] with an
    // AppendMessageContext built at line 367-371 that lacks the `engine`
    // field. handleAppendMessageRpc then falls through to the legacy
    // boolean fallback (append-message-handler.ts:213-215), silently
    // bypassing the PDP audit row + scope ladder + override lookup.
    //
    // Plan 03's source fix is a 1-line addition (`engine:
    // getPermissionEngine()`) to that ctx object. These three tests lock
    // the wiring at the route layer:
    //
    //   1. The ctx the route hands handleAppendMessageRpc carries
    //      `engine` and it IS the singleton from getPermissionEngine().
    //   2. getPermissionEngine() is invoked AT LEAST once per messageToolbar
    //      POST (subprocess wirer line 319 + new ctx wiring line 367-371
    //      = 2 calls; we assert ≥1 to stay tolerant of future inlining).
    //   3. The bulk shape (messageIds[]) inherits the same wiring.
    describe("SEC-06 — PDP engine wired into ctx for messageToolbar path", () => {
      function kokoroExtSec06(): NonNullable<typeof mockExt> {
        return {
          id: "ext-kokoro",
          name: "kokoro-tts",
          enabled: true,
          grantedPermissions: { appendMessages: { excludedDefault: true } },
        };
      }

      test("ctx.engine === getPermissionEngine() singleton (single messageId path)", async () => {
        mockRegisteredEvents.add("kokoro-tts:speak");
        mockConv = { id: "c-1", userId: "user-1" };
        mockExt = kokoroExtSec06();
        mockWiredIds = ["ext-kokoro"];

        const res = await POST(
          makeEvent(
            { messageId: "m-1", conversationId: "c-1", content: "hi" },
            { name: "kokoro-tts", event: "speak" },
          ) as never,
        );
        expect(res.status).toBe(200);

        // The handler must be called WITH ctx.engine pointing at the
        // PDP singleton — proving the route took the PDP path, not
        // the legacy boolean fallback.
        expect(mockAppendCalls).toHaveLength(1);
        const ctx = mockAppendCalls[0]!.ctx as { engine?: unknown };
        expect(ctx.engine).toBeDefined();
        expect(ctx.engine).toBe(MOCK_ENGINE);
      });

      test("getPermissionEngine() is invoked during the messageToolbar request (at least once)", async () => {
        // Tolerant lower bound: the wirer (line 319) already calls it,
        // and Plan 03 adds a second call for the ctx. We assert ≥1 so a
        // future refactor that hoists the singleton into a request-scope
        // local doesn't false-fail this test.
        mockRegisteredEvents.add("kokoro-tts:speak");
        mockConv = { id: "c-1", userId: "user-1" };
        mockExt = kokoroExtSec06();

        await POST(
          makeEvent(
            { messageId: "m-1", conversationId: "c-1", content: "hi" },
            { name: "kokoro-tts", event: "speak" },
          ) as never,
        );

        // Pre-fix: 1 call (the wirer). Post-fix: ≥2 (wirer + ctx).
        // The post-fix call count can never be ZERO — that would mean
        // neither path got the singleton.
        expect(mockGetPermissionEngine.mock.calls.length).toBeGreaterThanOrEqual(2);
      });

      test("ctx.engine === getPermissionEngine() singleton (bulk messageIds[] path)", async () => {
        // The bulk shortcut shares the same ctx-construction code path,
        // so it MUST inherit the engine wiring. This test pins the
        // contract so a future refactor that splits single/bulk into
        // separate ctx builders doesn't accidentally drop engine from
        // the bulk branch.
        mockRegisteredEvents.add("kokoro-tts:speak");
        mockConv = { id: "c-1", userId: "user-1" };
        mockExt = kokoroExtSec06();
        mockWiredIds = ["ext-kokoro"];

        const res = await POST(
          makeEvent(
            {
              messageIds: ["m-a", "m-b", "m-c"],
              conversationId: "c-1",
              content: "1\n\n2\n\n3",
            },
            { name: "kokoro-tts", event: "speak" },
          ) as never,
        );
        expect(res.status).toBe(200);

        expect(mockAppendCalls).toHaveLength(1);
        const ctx = mockAppendCalls[0]!.ctx as { engine?: unknown };
        expect(ctx.engine).toBe(MOCK_ENGINE);
      });
    });
  });

  describe("save events (toolCallId + attachmentId)", () => {
    test("calls finalize-tool-call in-process, no bus fanout", async () => {
      mockRegisteredEvents.add("kokoro-tts:save");
      mockConv = { id: "c-1", userId: "user-1" };
      mockExt = {
        id: "ext-kokoro",
        name: "kokoro-tts",
        enabled: true,
        grantedPermissions: { appendMessages: { excludedDefault: true } },
      };

      const res = await POST(
        makeEvent(
          {
            toolCallId: "tc-1",
            messageId: "m-1",
            conversationId: "c-1",
            attachmentId: "att-real-1",
          },
          { name: "kokoro-tts", event: "save" },
        ) as never,
      );
      expect(res.status).toBe(200);
      expect(mockFinalizeCalls).toHaveLength(1);
      const call = mockFinalizeCalls[0]!;
      expect(call.extensionId).toBe("ext-kokoro");
      const params = (call.req as { params: Record<string, unknown> }).params;
      expect(params.toolCallId).toBe("tc-1");
      expect(params.status).toBe("complete");
      expect(params.output).toEqual({ attachmentId: "att-real-1" });
      // Save events don't fan out to other subscribers — they're a
      // host-side bookkeeping callback.
      const fanoutCalls = mockBusEmit.mock.calls.filter(
        (c) => c[0] === "kokoro-tts:save",
      );
      expect(fanoutCalls).toHaveLength(0);
    });

    test("finalize handler error surfaces as 500", async () => {
      mockRegisteredEvents.add("kokoro-tts:save");
      mockConv = { id: "c-1", userId: "user-1" };
      mockExt = {
        id: "ext-kokoro",
        name: "kokoro-tts",
        enabled: true,
        grantedPermissions: { appendMessages: { excludedDefault: true } },
      };
      mockFinalizeResponse = {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32001, message: "toolCall not owned by calling extension" },
      };

      const res = await POST(
        makeEvent(
          {
            toolCallId: "tc-1",
            conversationId: "c-1",
            attachmentId: "att-1",
          },
          { name: "kokoro-tts", event: "save" },
        ) as never,
      );
      expect(res.status).toBe(500);
    });
  });
});
