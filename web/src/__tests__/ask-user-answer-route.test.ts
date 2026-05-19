/**
 * POST /api/ask-user/answer
 *
 * Boundary tests for the endpoint that resolves a pending
 * `ask_user_question` gate by emitting `ask-user:answer` on the host
 * bus. The endpoint:
 *
 *   1. Rejects requests missing the `chat` scope.
 *   2. Rejects malformed bodies (zod-strict).
 *   3. Returns `{ ok: true }` without emitting when the toolCallId
 *      doesn't resolve to a row (gate already collapsed — late POST).
 *   4. Returns 404 when the toolCall belongs to a conversation NOT
 *      owned by the acting user (auth boundary — `Not found`, not
 *      `Forbidden`, to avoid leaking existence of others' tool calls).
 *   5. Returns 200 + emits exactly one `ask-user:answer` with the
 *      correct shape on the happy path, then clears.
 *
 * Mirrors `human-input-route.test.ts` for the legacy endpoint.
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

// ── Mock the host-side ask-user-registry ──────────────────────────
//
// The endpoint reads pending entries via `getPendingAskUser(id)`; we
// drive the test by setting `mockPending` per-case. This replaces the
// previous DB-lookup mock, matching the production change that moved
// off `tool_calls` SELECT (the row doesn't exist while the gate is
// open — see ask-user-registry.ts).

let mockPending:
  | { conversationId: string; userId: string | null }
  | undefined = undefined;
const mockGetPendingAskUser = mock(
  (_toolCallId: string) => mockPending,
);

mock.module("$server/runtime/ask-user-registry", () => ({
  getPendingAskUser: mockGetPendingAskUser,
  // Provide stubs for the other surface in case any transient import
  // path resolves through the same module under the same alias.
  registerPendingAskUser: mock((_id: string, _conv: string, _user: string | null) => {}),
  clearPendingAskUser: mock((_id: string) => {}),
}));

// ── Mock errorJson + json ─────────────────────────────────────────
//
// Mirror the human-input-route test's posture: pass through SvelteKit
// Response builders so tests can assert on status + body.

mock.module("$lib/server/http-errors", () => ({
  errorJson: (status: number, message: string) =>
    new Response(JSON.stringify({ error: message }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
}));

// SvelteKit's `json()` is normally re-exported from @sveltejs/kit;
// preload.ts already mocks it project-wide. No additional mock needed.

// ── Import handler AFTER mocks ─────────────────────────────────────

const { POST } = await import("../routes/api/ask-user/answer/+server");

// ── Helpers ────────────────────────────────────────────────────────

interface RequestEventLike {
  request: Request;
  locals: Record<string, unknown>;
}

function makeEvent(body: unknown): RequestEventLike {
  return {
    request: new Request("http://localhost/api/ask-user/answer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    locals: {
      user: { id: "user-1", email: "t@t.com", name: "T", role: "member" },
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("POST /api/ask-user/answer", () => {
  beforeEach(() => {
    mockScopeResponse = null;
    mockPending = undefined;
    mockBusEmit.mockClear();
    mockGetPendingAskUser.mockClear();
  });

  test("scope rejection short-circuits before registry and bus are touched", async () => {
    mockScopeResponse = new Response("forbidden", { status: 403 });

    const res = await POST(
      makeEvent({ toolCallId: "tc-1", answer: "blue" }) as never,
    );

    expect(res.status).toBe(403);
    expect(mockGetPendingAskUser).not.toHaveBeenCalled();
    expect(mockBusEmit).not.toHaveBeenCalled();
  });

  test("missing toolCallId → 400 'Invalid body'", async () => {
    const res = await POST(makeEvent({ answer: "blue" }) as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid body");
    expect(mockGetPendingAskUser).not.toHaveBeenCalled();
    expect(mockBusEmit).not.toHaveBeenCalled();
  });

  test("missing answer → 400 'Invalid body'", async () => {
    const res = await POST(makeEvent({ toolCallId: "tc-1" }) as never);
    expect(res.status).toBe(400);
    expect(mockBusEmit).not.toHaveBeenCalled();
  });

  test("empty answer → 400 (zod min(1))", async () => {
    const res = await POST(
      makeEvent({ toolCallId: "tc-1", answer: "" }) as never,
    );
    expect(res.status).toBe(400);
    expect(mockBusEmit).not.toHaveBeenCalled();
  });

  test("unknown extra fields → 400 (zod strict)", async () => {
    const res = await POST(
      makeEvent({ toolCallId: "tc-1", answer: "blue", extra: "field" }) as never,
    );
    expect(res.status).toBe(400);
    expect(mockBusEmit).not.toHaveBeenCalled();
  });

  test("malformed JSON body → 400", async () => {
    const res = await POST(makeEvent("not-json") as never);
    expect(res.status).toBe(400);
    expect(mockBusEmit).not.toHaveBeenCalled();
  });

  test("toolCallId not in registry (late POST) → 200 ok, no emit", async () => {
    mockPending = undefined;

    const res = await POST(
      makeEvent({ toolCallId: "tc-gone", answer: "stale" }) as never,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockBusEmit).not.toHaveBeenCalled();
  });

  test("registry entry with null userId → 404, no emit (no anonymous answers)", async () => {
    mockPending = { conversationId: "conv-A", userId: null };

    const res = await POST(
      makeEvent({ toolCallId: "tc-orphan", answer: "x" }) as never,
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
    expect(mockBusEmit).not.toHaveBeenCalled();
  });

  test("toolCallId belongs to a different user → 404, no emit (auth boundary)", async () => {
    mockPending = { conversationId: "conv-A", userId: "someone-else" };

    const res = await POST(
      makeEvent({ toolCallId: "tc-stranger", answer: "intruder" }) as never,
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
    expect(mockBusEmit).not.toHaveBeenCalled();
  });

  test("happy path → 200 + emits exactly one ask-user:answer with correct shape", async () => {
    mockPending = { conversationId: "conv-A", userId: "user-1" };

    const res = await POST(
      makeEvent({ toolCallId: "tc-live", answer: "blue" }) as never,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(mockBusEmit).toHaveBeenCalledTimes(1);
    const [eventName, payload] = mockBusEmit.mock.calls[0] as [string, unknown];
    expect(eventName).toBe("ask-user:answer");
    expect(payload).toEqual({
      toolCallId: "tc-live",
      conversationId: "conv-A",
      answer: "blue",
    });
  });
});
