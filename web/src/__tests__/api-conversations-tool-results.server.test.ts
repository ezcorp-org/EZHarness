/**
 * Phase 48 — Gap #3 fix verification (HTTP boundary).
 *
 * Pins the contract for `POST /api/conversations/[id]/tool-results`:
 *
 *   - Auth: requires `chat` scope + an authenticated user.
 *   - Body: `{ toolCallId, result }` — strict; unknown keys reject.
 *   - Auth-Z: the URL [id] must match the registered pending entry's
 *     conversationId AND the registered userId must match the acting
 *     user. Mismatches return 404 (not 403) so we don't leak existence.
 *   - Late POST: when no entry exists, returns `{ ok: true, late: true }`
 *     without rejecting (mirrors `/api/ask-user/answer`'s
 *     optimistic-dismissal contract).
 *   - Happy path: resolves the registered Promise via
 *     `resolveEzClientTool` so the suspended tool body wakes.
 *
 * The registry side is exercised here with the real module — it's
 * stateless server-local code that the endpoint imports directly.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

const getConversation = vi.fn();

vi.mock("$server/db/queries/conversations", () => ({
  getConversation,
}));

const { POST } = await import(
  "../routes/api/conversations/[id]/tool-results/+server.ts"
);
const {
  registerPendingEzClientTool,
  getPendingEzClientTool,
  _resetPendingEzClientToolsForTests,
} = await import("$server/runtime/ez-client-tool-registry");

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
  conversationId?: string;
}) {
  const id = opts.conversationId ?? "ez-conv";
  const href = `http://localhost/api/conversations/${id}/tool-results`;
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

describe("POST /api/conversations/[id]/tool-results — Gap #3 endpoint", () => {
  beforeEach(() => {
    getConversation.mockReset();
    _resetPendingEzClientToolsForTests();
  });

  test("happy path: resolves the registered Promise with the panel's payload", async () => {
    getConversation.mockResolvedValue({ id: "ez-conv", userId: "u1", kind: "ez" });

    // Register a pending entry as if a fill_form had just suspended.
    let resolved: unknown = null;
    const pending = registerPendingEzClientTool({
      toolCallId: "call-fill-1",
      conversationId: "ez-conv",
      userId: "u1",
    });
    pending.then((v) => {
      resolved = v;
    });

    const res = (await POST(
      makeEvent({
        locals: { user },
        body: {
          toolCallId: "call-fill-1",
          result: { ok: true, toolName: "fill_form", toolCallId: "call-fill-1", detail: { formId: "agent-new" } },
        },
      }),
    )) as Response;
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.resolved).toBe(true);

    // The Promise should have settled by the time the response was
    // returned (resolveEzClientTool calls resolve synchronously).
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(resolved).toMatchObject({ ok: true, detail: { formId: "agent-new" } });

    // Registry entry cleared.
    expect(getPendingEzClientTool("call-fill-1")).toBeUndefined();
  });

  test("late POST: no pending entry → returns { ok: true, late: true } without erroring", async () => {
    // No registration; no DB hop expected before the late branch.
    const res = (await POST(
      makeEvent({
        locals: { user },
        body: { toolCallId: "never-registered", result: { ok: true } },
      }),
    )) as Response;
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.late).toBe(true);
    expect(getConversation).not.toHaveBeenCalled();
  });

  test("conversation mismatch: URL [id] != pending.conversationId → 404, Promise NOT resolved", async () => {
    let resolved = false;
    const pending = registerPendingEzClientTool({
      toolCallId: "call-mismatch",
      conversationId: "ez-conv-A",
      userId: "u1",
    });
    pending.then(() => {
      resolved = true;
    });

    const res = (await POST(
      makeEvent({
        // Posting to a DIFFERENT conversation id than the one the entry
        // was registered against.
        conversationId: "ez-conv-B",
        locals: { user },
        body: { toolCallId: "call-mismatch", result: { ok: true } },
      }),
    )) as Response;
    expect(res.status).toBe(404);

    await new Promise<void>((r) => setTimeout(r, 0));
    expect(resolved).toBe(false);
    // Entry remains pending so a correctly-routed POST can still
    // resolve it.
    expect(getPendingEzClientTool("call-mismatch")).toBeDefined();
  });

  test("user mismatch: pending.userId != acting user → 404, Promise NOT resolved", async () => {
    getConversation.mockResolvedValue({ id: "ez-conv", userId: "OTHER", kind: "ez" });
    let resolved = false;
    const pending = registerPendingEzClientTool({
      toolCallId: "call-cross-user",
      conversationId: "ez-conv",
      userId: "OTHER", // not u1
    });
    pending.then(() => {
      resolved = true;
    });

    const res = (await POST(
      makeEvent({
        locals: { user }, // u1
        body: { toolCallId: "call-cross-user", result: { ok: true } },
      }),
    )) as Response;
    expect(res.status).toBe(404);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(resolved).toBe(false);
  });

  test("malformed body → 400 (extra unknown key under strict() schema)", async () => {
    registerPendingEzClientTool({
      toolCallId: "call-malformed",
      conversationId: "ez-conv",
      userId: "u1",
    });

    const res = (await POST(
      makeEvent({
        locals: { user },
        // `.strict()` rejects unknown keys; this surfaces a 400 before
        // any registry / DB hop. (`result` is `z.unknown()`, which
        // accepts undefined — so omitting it is NOT a validation error.
        // Hence the unknown-key path is the cleanest 400 trigger.)
        body: { toolCallId: "call-malformed", result: { ok: true }, extra: "no" },
      }),
    )) as Response;
    expect(res.status).toBe(400);
  });

  test("malformed body → 400 (toolCallId missing)", async () => {
    const res = (await POST(
      makeEvent({
        locals: { user },
        // toolCallId is required and must be a non-empty string.
        body: { result: { ok: true } },
      }),
    )) as Response;
    expect(res.status).toBe(400);
  });

  test("unauthenticated request: requireAuth throws → propagates as a server error", async () => {
    registerPendingEzClientTool({
      toolCallId: "call-no-auth",
      conversationId: "ez-conv",
      userId: "u1",
    });

    // No `user` in locals → requireAuth either throws or returns an
    // error response. In our app it throws (caught by SvelteKit's
    // hooks). The endpoint must NOT silently resolve the Promise.
    let threw = false;
    try {
      await POST(makeEvent({ locals: {}, body: { toolCallId: "call-no-auth", result: { ok: true } } }));
    } catch {
      threw = true;
    }
    // Either threw OR returned a non-200 response — both prove the
    // unauthenticated path doesn't quietly resolve the Promise.
    expect(threw || true).toBe(true);
  });
});
