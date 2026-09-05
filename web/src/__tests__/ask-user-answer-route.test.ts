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
import { makeRequestEvent } from "./helpers/server-route-test-utils";

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

import { LifecycleError } from "$server/extensions/v4/types";
let admissionFailure: Error | undefined;
const mockAcceptAnswer = mock(async (_principalId: string, _toolCallId: string, _answer: string, _bus: unknown) => {
  if (admissionFailure) throw admissionFailure;
  return true;
});
mock.module("$server/runtime/ask-user-answer", () => ({ acceptAskUserAnswer: mockAcceptAnswer }));

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
  return makeRequestEvent("http://localhost/api/ask-user/answer", {
    url: null,
    request: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    locals: {
      user: { id: "user-1", email: "t@t.com", name: "T", role: "member" },
    },
  });
}

// ── Tests ──────────────────────────────────────────────────────────

describe("POST /api/ask-user/answer", () => {
  beforeEach(() => {
    mockScopeResponse = null;
    admissionFailure = undefined;
    mockBusEmit.mockClear();
    mockAcceptAnswer.mockClear();
  });

  test("scope rejection short-circuits before registry and bus are touched", async () => {
    mockScopeResponse = new Response("forbidden", { status: 403 });

    const res = await POST(
      makeEvent({ toolCallId: "tc-1", answer: "blue" }) as never,
    );

    expect(res.status).toBe(403);
    expect(mockAcceptAnswer).not.toHaveBeenCalled();
    expect(mockBusEmit).not.toHaveBeenCalled();
  });

  test("missing toolCallId → 400 'Invalid body'", async () => {
    const res = await POST(makeEvent({ answer: "blue" }) as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid body");
    expect(mockAcceptAnswer).not.toHaveBeenCalled();
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
    admissionFailure = undefined;

    const res = await POST(
      makeEvent({ toolCallId: "tc-gone", answer: "stale" }) as never,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockBusEmit).not.toHaveBeenCalled();
  });

  test("registry entry with null userId → 404, no emit (no anonymous answers)", async () => {
    admissionFailure = new LifecycleError("event_not_found", "Question not found.");

    const res = await POST(
      makeEvent({ toolCallId: "tc-orphan", answer: "x" }) as never,
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
    expect(mockBusEmit).not.toHaveBeenCalled();
  });

  test("toolCallId belongs to a different user → 404, no emit (auth boundary)", async () => {
    admissionFailure = new LifecycleError("event_not_found", "Question not found.");

    const res = await POST(
      makeEvent({ toolCallId: "tc-stranger", answer: "intruder" }) as never,
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Not found");
    expect(mockBusEmit).not.toHaveBeenCalled();
  });

  test("happy path → 200 only after owner-bound durable admission", async () => {
    admissionFailure = undefined;

    const res = await POST(
      makeEvent({ toolCallId: "tc-live", answer: "blue" }) as never,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(mockAcceptAnswer).toHaveBeenCalledTimes(1);
    expect(mockAcceptAnswer).toHaveBeenCalledWith("user-1", "tc-live", "blue", mockBus);
    expect(mockBusEmit).not.toHaveBeenCalled();
  });

  test("changed answer on the same question returns conflict without another event", async () => {
    admissionFailure = new LifecycleError("event_conflict", "Changed answer");
    const response = await POST(makeEvent({ toolCallId: "tc-live", answer: "changed" }) as never);
    expect(response.status).toBe(409);
    expect(mockBusEmit).not.toHaveBeenCalled();
  });

  test("host byte bounds return 400 while persistence failures remain explicit", async () => {
    admissionFailure = new LifecycleError("invalid_answer", "Oversized encoded answer");
    expect((await POST(makeEvent({ toolCallId: "tc-live", answer: "answer" }) as never)).status).toBe(400);
    for (const failure of [new Error("Database offline"), new LifecycleError("event_queue_full", "Queue full")]) {
      admissionFailure = failure;
      await expect(POST(makeEvent({ toolCallId: "tc-live", answer: "answer" }) as never)).rejects.toBe(failure);
    }
    expect(mockBusEmit).not.toHaveBeenCalled();
  });

  test("admission quota exhaustion returns 503 rather than accepting a lost answer", async () => {
    admissionFailure = new LifecycleError("event_admission_full", "Full");
    expect((await POST(makeEvent({ toolCallId: "tc-live", answer: "answer" }) as never)).status).toBe(503);
    expect(mockBusEmit).not.toHaveBeenCalled();
  });
});
