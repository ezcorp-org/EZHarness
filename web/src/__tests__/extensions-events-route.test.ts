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
mock.module("$lib/server/context", () => ({
  getBus: () => mockBus,
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
    mockRegisteredEvents.clear();
    mockConv = null;
    mockToolCall = null;
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
        toolCallId: "x".repeat(65),
        conversationId: "c",
      }) as never,
    );
    expect(res.status).toBe(400);
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
    expect(await res.json()).toEqual({ ok: true });

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
});
