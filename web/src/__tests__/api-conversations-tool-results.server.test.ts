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
 *   - Late POST: when no entry exists, returns
 *     `{ ok: true, resolved: false, reason: "already-resolved" }` without
 *     rejecting (mirrors `/api/ask-user/answer`'s optimistic-dismissal
 *     contract).
 *   - Happy path: resolves the registered Promise via
 *     `resolveRemoteTool` so the suspended tool body wakes.
 *   - Caller-executed tools share this endpoint, which makes two devices
 *     answering one call ordinary rather than pathological: the loser must
 *     learn its bytes were discarded, hence `resolved` + `reason` in place
 *     of the old `late` flag.
 *   - 256 KiB body cap and a 20/s per-user budget, because the payload now
 *     arrives from an arbitrary external machine.
 *
 * The registry side is exercised here with the real module — it's
 * stateless server-local code that the endpoint imports directly.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";
import { makeRequestEvent, expectThrownResponse } from "./helpers/server-route-test-utils";

const getConversation = vi.fn();

vi.mock("$server/db/queries/conversations", () => ({
  getConversation,
}));

const { POST } = await import(
  "../routes/api/conversations/[id]/tool-results/+server.ts"
);
const {
  registerPendingRemoteTool,
  getPendingRemoteTool,
  _resetPendingRemoteToolsForTests,
} = await import("$server/runtime/remote-tool-registry");

/**
 * Register a pending entry the way the Ez client-tool adapter does. The
 * generalized registry serves two families, so the family-specific fields
 * (origin, gate budget, timeout sentence) are explicit at every call site —
 * this helper supplies the Ez ones so the endpoint tests below stay about the
 * HTTP boundary.
 */
function registerEzPending(opts: {
  toolCallId: string;
  conversationId: string;
  userId: string | null;
}): Promise<unknown> {
  return registerPendingRemoteTool({
    ...opts,
    toolName: "fill_form",
    input: { formId: "agent-new", values: {} },
    runId: null,
    origin: "ez",
    timeoutMs: 5 * 60_000,
    timeoutMessage: "Timed out waiting for Ez client tool result",
  });
}

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
  conversationId?: string;
}) {
  const id = opts.conversationId ?? "ez-conv";
  const href = `http://localhost/api/conversations/${id}/tool-results`;
  return makeRequestEvent(href, {
    locals: opts.locals ?? {},
    params: { id },
    request: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    },
  });
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

describe("POST /api/conversations/[id]/tool-results — Gap #3 endpoint", () => {
  beforeEach(() => {
    getConversation.mockReset();
    _resetPendingRemoteToolsForTests();
  });

  test("happy path: resolves the registered Promise with the panel's payload", async () => {
    getConversation.mockResolvedValue({ id: "ez-conv", userId: "u1", kind: "ez" });

    // Register a pending entry as if a fill_form had just suspended.
    let resolved: unknown = null;
    const pending = registerEzPending({
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
    // returned (resolveRemoteTool calls resolve synchronously).
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(resolved).toMatchObject({ ok: true, detail: { formId: "agent-new" } });

    // Registry entry cleared.
    expect(getPendingRemoteTool("call-fill-1")).toBeUndefined();
  });

  test("late POST: no pending entry → { ok: true, resolved: false, reason } without erroring", async () => {
    // No registration; no DB hop expected before the late branch.
    const res = (await POST(
      makeEvent({
        locals: { user },
        body: { toolCallId: "never-registered", result: { ok: true } },
      }),
    )) as Response;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, resolved: false, reason: "already-resolved" });
    expect(getConversation).not.toHaveBeenCalled();
  });

  test("two devices, one call: the first POST wins and the second is told so", async () => {
    getConversation.mockResolvedValue({ id: "ez-conv", userId: "u1", kind: "ez" });
    const settled: unknown[] = [];
    registerEzPending({
      toolCallId: "call-race",
      conversationId: "ez-conv",
      userId: "u1",
    }).then((v) => settled.push(v));

    const body = (device: string) => ({
      toolCallId: "call-race",
      result: { ok: true, toolName: "_caller__open_app", detail: { device } },
    });
    const first = (await POST(makeEvent({ locals: { user }, body: body("A") }))) as Response;
    const second = (await POST(makeEvent({ locals: { user }, body: body("B") }))) as Response;

    // Both requests were ACCEPTED — device B did nothing wrong. Only one
    // result reached the waiting tool, and B is told which outcome it got.
    expect(await first.json()).toEqual({ ok: true, resolved: true });
    expect(await second.json()).toEqual({ ok: true, resolved: false, reason: "already-resolved" });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(settled).toEqual([{ ok: true, toolName: "_caller__open_app", detail: { device: "A" } }]);
  });

  test("a body over 256 KiB is 413 — on the declared length AND on the real bytes", async () => {
    registerEzPending({
      toolCallId: "call-fat",
      conversationId: "ez-conv",
      userId: "u1",
    });
    const declared = (await POST(
      makeRequestEvent("http://localhost/api/conversations/ez-conv/tool-results", {
        locals: { user },
        params: { id: "ez-conv" },
        request: {
          method: "POST",
          headers: { "content-type": "application/json", "content-length": String(256 * 1024 + 1) },
          body: JSON.stringify({ toolCallId: "call-fat", result: {} }),
        },
      }),
    )) as Response;
    expect(declared.status).toBe(413);

    // A chunked request declares no length at all; the cap must still bite.
    const chunked = makeRequestEvent("http://localhost/api/conversations/ez-conv/tool-results", {
      locals: { user },
      params: { id: "ez-conv" },
      request: null,
    });
    chunked.request = {
      headers: new Headers(),
      arrayBuffer: async () => new TextEncoder().encode("x".repeat(256 * 1024 + 1)).buffer,
    };
    expect(((await POST(chunked)) as Response).status).toBe(413);

    // Neither attempt touched the pending gate.
    expect(getPendingRemoteTool("call-fat")).toBeDefined();
  });

  test("a body that is not JSON at all is a 400, not a crash", async () => {
    const ev = makeRequestEvent("http://localhost/api/conversations/ez-conv/tool-results", {
      locals: { user },
      params: { id: "ez-conv" },
      request: null,
    });
    ev.request = {
      headers: new Headers(),
      arrayBuffer: async () => new TextEncoder().encode("{not json").buffer,
    };
    const res = (await POST(ev)) as Response;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Invalid body" });
  });

  test("the 21st result in one second is 429 — the budget is per user", async () => {
    // Frozen clock: the bucket refills against `Date.now()`, so an unfrozen
    // run would be asserting on how fast the host executed 21 calls rather
    // than on the limiter. A dedicated user id keeps the burst from
    // spending the budget the rest of this file relies on.
    const burstUser = { id: "u-burst", email: "b@x", name: "b", role: "user" };
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 21; i++) {
        const res = (await POST(
          makeEvent({ locals: { user: burstUser }, body: { toolCallId: `burst-${i}`, result: {} } }),
        )) as Response;
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 20)).toEqual(Array(20).fill(200));
      expect(statuses[20]).toBe(429);
    } finally {
      clock.mockRestore();
    }
  });

  test("conversation mismatch: URL [id] != pending.conversationId → 404, Promise NOT resolved", async () => {
    let resolved = false;
    const pending = registerEzPending({
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
    expect(getPendingRemoteTool("call-mismatch")).toBeDefined();
  });

  test("user mismatch: pending.userId != acting user → 404, Promise NOT resolved", async () => {
    getConversation.mockResolvedValue({ id: "ez-conv", userId: "OTHER", kind: "ez" });
    let resolved = false;
    const pending = registerEzPending({
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

  test("a registration that outlived its conversation is 404, Promise NOT resolved", async () => {
    // Defense in depth: the registry captured the owner server-side, but a
    // stale entry can survive a crash that took the conversation with it.
    getConversation.mockResolvedValue(null);
    let resolved = false;
    registerEzPending({
      toolCallId: "call-orphan",
      conversationId: "ez-conv",
      userId: "u1",
    }).then(() => {
      resolved = true;
    });

    const res = (await POST(
      makeEvent({ locals: { user }, body: { toolCallId: "call-orphan", result: { ok: true } } }),
    )) as Response;
    expect(res.status).toBe(404);
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(resolved).toBe(false);
  });

  test("malformed body → 400 (extra unknown key under strict() schema)", async () => {
    registerEzPending({
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

  test("unauthenticated request: 401 and the pending Promise is untouched", async () => {
    let resolved = false;
    registerEzPending({
      toolCallId: "call-no-auth",
      conversationId: "ez-conv",
      userId: "u1",
    }).then(() => {
      resolved = true;
    });

    // No `user` in locals → `requireAuth` THROWS a 401 Response, which
    // SvelteKit's hooks surface. Asserted concretely: the previous version
    // of this test ended in `expect(threw || true).toBe(true)`, which is
    // true for every possible outcome and so asserted nothing at all.
    const res = await expectThrownResponse(
      () =>
        POST(
          makeEvent({ locals: {}, body: { toolCallId: "call-no-auth", result: { ok: true } } }),
        ) as Promise<Response>,
      401,
    );
    expect(await res.json()).toEqual({ error: "Authentication required" });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(resolved).toBe(false);
    expect(getPendingRemoteTool("call-no-auth")).toBeDefined();
  });
});
