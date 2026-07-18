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

import { test, expect, describe, vi, beforeEach } from "vitest";

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
const { GET, POST } = await import(
  "../routes/api/conversations/[id]/active-run/+server.ts"
);

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
  method?: string;
}) {
  const method = opts.method ?? "GET";
  return {
    url: new URL("http://localhost/api/conversations/c1/active-run"),
    locals: opts.locals ?? {},
    params: { id: "c1" },
    request: new Request("http://localhost/api/conversations/c1/active-run", {
      method,
      headers: { "content-type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  } as any;
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
