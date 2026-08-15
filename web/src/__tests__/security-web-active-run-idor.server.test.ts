/**
 * IDOR regression for /api/conversations/[id]/active-run (+server.ts).
 *
 * Pre-fix GET/POST called requireAuth but never checked conversation
 * ownership, so a member with `read` scope could read another tenant's
 * in-flight assistant text (partialResponse) + pending permission/ask-user
 * payloads via GET, and with `chat` scope kill their run via POST.
 *
 * The fix routes both handlers through resolveRootConversationForOwnership
 * and returns a fail-closed 404 when it yields null. These tests pin that:
 *   - a non-owner (ownership → null) gets 404 and the executor is NEVER
 *     touched (no leak, no cancellation),
 *   - the owner path still reaches the run logic.
 */

import { test, expect, describe, vi, beforeEach, afterEach } from "vitest";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

const cancelRun = vi.fn();
const getActiveRunForConversation = vi.fn();
const getPendingPermissions = vi.fn(() => []);
const busEmit = vi.fn();

vi.mock("$lib/server/context", () => ({
  getExecutor: () => ({
    cancelRun,
    getActiveRunForConversation,
    getPendingPermissions,
  }),
  getBus: () => ({ emit: busEmit }),
}));

vi.mock("$server/db/queries/active-runs", () => ({
  getActiveRun: vi.fn(),
  markInterrupted: vi.fn(),
}));

vi.mock("$server/runtime/ask-user-registry", () => ({
  getPendingAskUserForConversation: vi.fn(() => []),
}));

vi.mock("$lib/server/conversation-ownership", () => ({
  resolveRootConversationForOwnership: vi.fn(),
}));

const { getActiveRun } = await import("$server/db/queries/active-runs");
const { resolveRootConversationForOwnership } = await import(
  "$lib/server/conversation-ownership"
);
// The REAL registry — it is stateless, in-process, server-local code the route
// imports directly, and a mock of it would prove only that the route calls
// something.
const { registerPendingRemoteTool, _resetPendingRemoteToolsForTests } = await import(
  "$server/runtime/remote-tool-registry"
);
const { GET, POST } = await import(
  "../routes/api/conversations/[id]/active-run/+server.ts"
);

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
  method?: string;
}) {
  const method = opts.method ?? "GET";
  return makeRequestEvent("http://localhost/api/conversations/c1/active-run", {
    locals: opts.locals ?? {},
    params: { id: "c1" },
    request: {
      method,
      headers: { "content-type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    },
  });
}

const attacker = { id: "u-attacker", email: "b@x", name: "b", role: "member" };
const owner = { id: "u-owner", email: "a@x", name: "a", role: "member" };

describe("IDOR: GET /api/conversations/[id]/active-run", () => {
  beforeEach(() => {
    cancelRun.mockReset();
    getActiveRunForConversation.mockReset();
    vi.mocked(getActiveRun).mockReset();
    vi.mocked(resolveRootConversationForOwnership).mockReset();
  });

  test("non-owner → 404 and the executor is never queried (no partialResponse leak)", async () => {
    vi.mocked(resolveRootConversationForOwnership).mockResolvedValue(null);
    // If ownership were skipped this would be returned to the attacker.
    getActiveRunForConversation.mockReturnValue({ id: "run-secret", startedAt: Date.now() });

    const res = await GET(makeEvent({ locals: { user: attacker } }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Not found");
    expect(getActiveRunForConversation).not.toHaveBeenCalled();
    expect(vi.mocked(resolveRootConversationForOwnership)).toHaveBeenCalledWith(
      "c1",
      attacker,
    );
  });

  test("owner → ownership passes and run logic runs (200)", async () => {
    vi.mocked(resolveRootConversationForOwnership).mockResolvedValue({
      conv: {},
      root: {},
    } as any);
    getActiveRunForConversation.mockReturnValue(null);
    vi.mocked(getActiveRun).mockResolvedValue(null as any);

    const res = await GET(makeEvent({ locals: { user: owner } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: null };
    expect(body.runId).toBeNull();
    expect(getActiveRunForConversation).toHaveBeenCalledWith("c1");
  });
});

describe("IDOR: POST /api/conversations/[id]/active-run", () => {
  beforeEach(() => {
    cancelRun.mockReset();
    getActiveRunForConversation.mockReset();
    vi.mocked(getActiveRun).mockReset();
    vi.mocked(resolveRootConversationForOwnership).mockReset();
  });

  test("non-owner cancel → 404 and no run is cancelled", async () => {
    vi.mocked(resolveRootConversationForOwnership).mockResolvedValue(null);
    getActiveRunForConversation.mockReturnValue({ id: "run-victim", startedAt: Date.now() });
    cancelRun.mockReturnValue(true);

    const res = await POST(
      makeEvent({ method: "POST", locals: { user: attacker }, body: { action: "cancel" } }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Not found");
    expect(getActiveRunForConversation).not.toHaveBeenCalled();
    expect(cancelRun).not.toHaveBeenCalled();
  });

  test("owner cancel with in-memory run → 200 path=memory", async () => {
    vi.mocked(resolveRootConversationForOwnership).mockResolvedValue({
      conv: {},
      root: {},
    } as any);
    getActiveRunForConversation.mockReturnValue({ id: "run-1", startedAt: Date.now() });
    cancelRun.mockReturnValue(true);

    const res = await POST(
      makeEvent({ method: "POST", locals: { user: owner }, body: { action: "cancel" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cancelled: boolean; path: string };
    expect(body.cancelled).toBe(true);
    expect(body.path).toBe("memory");
    expect(cancelRun).toHaveBeenCalledWith("run-1");
  });
});

/**
 * `pendingCallerTools` — the recovery drain a caller-tools client reads on
 * every (re)connect before it consumes a single event.
 *
 * It has to exist HERE rather than being recovered from the stream: the SSE
 * resume ring holds 500 GLOBAL entries including every `run:token`, so a busy
 * instance turns it over in seconds and a `caller:tool-call` from before a
 * five-second blip is simply gone. Without this field the client's drain read
 * `undefined` on every connect and a dropped call was never recovered — it sat
 * until its 120 s gate expired.
 *
 * The payload is the LLM's raw arguments for something about to execute on the
 * owner's own machine, so it carries two narrowings the ownership walk cannot
 * supply on its own — caller origin, and the exact user.
 */
describe("GET /api/conversations/[id]/active-run — caller-tool recovery drain", () => {
  const OWNED = { conv: {}, root: {} } as never;

  /** Suspend a call on `c1` the way the caller-tool wire does. */
  function pend(opts: {
    toolCallId: string;
    userId: string | null;
    origin?: "caller" | "ez";
    toolName?: string;
  }): void {
    void registerPendingRemoteTool({
      toolCallId: opts.toolCallId,
      conversationId: "c1",
      userId: opts.userId,
      toolName: opts.toolName ?? "open_app",
      input: { app: "Notes" },
      runId: "run-1",
      origin: opts.origin ?? "caller",
      timeoutMs: 120_000,
      timeoutMessage: "Timed out waiting for the caller tool result",
      // The rejection is never awaited here; the reset in afterEach clears the
      // entry without settling it, so nothing is left unhandled.
    }).catch(() => {});
  }

  beforeEach(() => {
    cancelRun.mockReset();
    getActiveRunForConversation.mockReset();
    vi.mocked(getActiveRun).mockReset();
    vi.mocked(resolveRootConversationForOwnership).mockReset();
    vi.mocked(resolveRootConversationForOwnership).mockResolvedValue(OWNED);
    _resetPendingRemoteToolsForTests();
  });

  afterEach(() => {
    _resetPendingRemoteToolsForTests();
  });

  test("a live run reports the suspended call with enough to RE-DISPATCH it", async () => {
    // A client that missed the event has the toolCallId and nothing to run, so
    // reporting that something is outstanding is not recovery — the arguments
    // have to come back too.
    pend({ toolCallId: "tc-live", userId: "u-owner" });
    getActiveRunForConversation.mockReturnValue({ id: "run-1", startedAt: Date.now() });
    vi.mocked(getActiveRun).mockResolvedValue({
      id: "run-1",
      status: "running",
      startedAt: new Date(),
      lastHeartbeat: null,
      partialResponse: null,
    } as never);

    const res = await GET(makeEvent({ locals: { user: owner } }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).pendingCallerTools).toEqual([
      {
        conversationId: "c1",
        runId: "run-1",
        toolCallId: "tc-live",
        toolName: "open_app",
        input: { app: "Notes" },
      },
    ]);
  });

  test("reported on the no-run branch too, so a drain needs no run to ask about", async () => {
    // The client drains on reconnect without first knowing whether a run is
    // live. A field present on only some response shapes would make recovery
    // depend on which branch answered.
    pend({ toolCallId: "tc-norun", userId: "u-owner" });
    getActiveRunForConversation.mockReturnValue(null);
    vi.mocked(getActiveRun).mockResolvedValue(null as never);

    const body = (await (await GET(makeEvent({ locals: { user: owner } }))).json()) as {
      runId: null;
      pendingCallerTools: Array<{ toolCallId: string }>;
    };
    expect(body.runId).toBeNull();
    expect(body.pendingCallerTools.map((c) => c.toolCallId)).toEqual(["tc-norun"]);
  });

  test("reported on the restart branch, where a DB row survived the process", async () => {
    pend({ toolCallId: "tc-dbrun", userId: "u-owner" });
    getActiveRunForConversation.mockReturnValue(null);
    vi.mocked(getActiveRun).mockResolvedValue({
      id: "run-db",
      status: "running",
      startedAt: new Date(),
      lastHeartbeat: null,
      partialResponse: "partial",
    } as never);

    const body = (await (await GET(makeEvent({ locals: { user: owner } }))).json()) as {
      runId: string;
      pendingCallerTools: Array<{ toolCallId: string }>;
    };
    expect(body.runId).toBe("run-db");
    expect(body.pendingCallerTools.map((c) => c.toolCallId)).toEqual(["tc-dbrun"]);
  });

  test("reported when an orphaned in-memory run is cancelled mid-request", async () => {
    pend({ toolCallId: "tc-orphan", userId: "u-owner" });
    getActiveRunForConversation.mockReturnValue({ id: "run-mem", startedAt: Date.now() });
    vi.mocked(getActiveRun).mockResolvedValue({
      id: "run-db",
      status: "interrupted",
      startedAt: new Date(),
      lastHeartbeat: null,
      partialResponse: null,
    } as never);

    const body = (await (await GET(makeEvent({ locals: { user: owner } }))).json()) as {
      status: string;
      pendingCallerTools: Array<{ toolCallId: string }>;
    };
    expect(body.status).toBe("interrupted");
    expect(cancelRun).toHaveBeenCalledWith("run-mem");
    expect(body.pendingCallerTools.map((c) => c.toolCallId)).toEqual(["tc-orphan"]);
  });

  test("the Ez panel's pending DOM operations never appear in it", async () => {
    // A different family, answered by a different client. Handing an external
    // application the selectors and values the LLM wants typed into the
    // owner's live page is exactly what moving `ez:client-tool` out of the
    // extension-subscribable set was for.
    pend({ toolCallId: "tc-ez", userId: "u-owner", origin: "ez", toolName: "read_page" });
    pend({ toolCallId: "tc-caller", userId: "u-owner" });
    getActiveRunForConversation.mockReturnValue(null);
    vi.mocked(getActiveRun).mockResolvedValue(null as never);

    const body = (await (await GET(makeEvent({ locals: { user: owner } }))).json()) as {
      pendingCallerTools: Array<{ toolCallId: string }>;
    };
    expect(body.pendingCallerTools.map((c) => c.toolCallId)).toEqual(["tc-caller"]);
  });

  test("an ADMIN passes the ownership walk but is handed no arguments", async () => {
    // `resolveRootConversationForOwnership` admits an admin on anyone's
    // conversation. That is right for run status; it is not right for the raw
    // arguments of a call about to run on the owner's own machine, which the
    // owner's device — and nobody else — receives over SSE.
    pend({ toolCallId: "tc-owner-only", userId: "u-owner" });
    getActiveRunForConversation.mockReturnValue(null);
    vi.mocked(getActiveRun).mockResolvedValue(null as never);

    const adminUser = { id: "u-admin", email: "adm@x", name: "adm", role: "admin" };
    const body = (await (await GET(makeEvent({ locals: { user: adminUser } }))).json()) as {
      pendingCallerTools: unknown[];
    };
    expect(body.pendingCallerTools).toEqual([]);

    // …and the owner still gets it, so the narrowing is by identity, not by a
    // drain that reports nothing to anyone.
    const ownerBody = (await (await GET(makeEvent({ locals: { user: owner } }))).json()) as {
      pendingCallerTools: Array<{ toolCallId: string }>;
    };
    expect(ownerBody.pendingCallerTools.map((c) => c.toolCallId)).toEqual(["tc-owner-only"]);
  });

  test("a non-owner is still 404 — the drain is inside the ownership gate", async () => {
    pend({ toolCallId: "tc-secret", userId: "u-owner" });
    vi.mocked(resolveRootConversationForOwnership).mockResolvedValue(null);

    const res = await GET(makeEvent({ locals: { user: attacker } }));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("tc-secret");
  });
});
