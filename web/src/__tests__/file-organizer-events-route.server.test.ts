// Route-level test for the file-organizer in-process Hub-action branch in
// `api/extensions/[name]/events/[event]/+server.ts`. Proves:
//   - a `file-organizer:*` in-process event is dispatched host-side with
//     the SESSION user's id (not a caller-supplied one),
//   - the page cache is invalidated only when the action changed state,
//   - an event NOT in the in-process set falls through to the subprocess
//     forward (existing behavior preserved),
//   - the manifest-event + page-declaration gates still apply.
//
// Runs under vitest (`.server.test.ts`) — its bun:ffi stub + $server/$lib
// aliases resolve the route's transitive import graph that plain bun test
// can't load (see project_vitest_bun_ffi_stub).
import { test, expect, describe, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const FO_MANIFEST = {
    pages: [{ id: "review" }, { id: "overview" }, { id: "folders" }],
    settings: { quarantine_ttl_days: { default: 30 }, quarantine_cap_gb: { default: 5 } },
  };
  return {
    FO_MANIFEST,
    state: {
      ext: { id: "ext-fo", enabled: true, manifest: FO_MANIFEST } as { id: string; enabled: boolean; manifest: unknown } | null,
      dispatchResult: { handled: true, changed: true, ok: true } as { handled: boolean; changed?: boolean; ok?: boolean; message?: string },
      dispatchCalls: [] as Array<{ event: string; payload: unknown; deps: Record<string, unknown> }>,
      inProcessEvents: new Set<string>(["accept", "select-segment", "reject", "set-mode"]),
    },
    invalidate: vi.fn((..._a: unknown[]) => {}),
    getProcess: vi.fn(async (_id: string) => ({ sendNotification: vi.fn(() => {}) })),
    ensureWired: vi.fn(async (..._a: unknown[]) => {}),
  };
});

vi.mock("$lib/server/security/api-keys", () => ({ requireScope: () => null }));
vi.mock("$server/auth/middleware", () => ({ requireAuth: (l: { user?: unknown }) => l.user }));
vi.mock("$lib/server/context", () => ({ getBus: () => ({ emit: () => {} }) }));
vi.mock("$lib/server/http-errors", () => ({
  errorJson: (status: number, message: string) =>
    new Response(JSON.stringify({ error: message }), { status, headers: { "Content-Type": "application/json" } }),
}));
vi.mock("$server/runtime/sse-conversation-filter", () => ({
  isRegisteredExtensionEvent: (e: string) =>
    new Set([
      "file-organizer:accept",
      "file-organizer:select-segment",
      "file-organizer:teach-rule",
      "file-organizer:classify-move",
    ]).has(e),
}));
vi.mock("$server/db/queries/extensions", () => ({ getExtensionByName: async () => h.state.ext }));
vi.mock("$lib/server/hub-extension-pages", () => ({
  readManifestPages: (m: { pages?: Array<{ id: string }> }) => m.pages ?? [],
}));
vi.mock("$server/extensions/page-cache", () => ({ getPageCache: () => ({ invalidate: h.invalidate }) }));
vi.mock("$server/extensions/permission-engine", () => ({ getPermissionEngine: () => ({ __mock: "engine" }) }));
vi.mock("$server/extensions/bundled", () => ({ getProjectRoot: () => "/proj" }));
// The subprocess-forward branch mints a per-fire reverse-RPC provenance token
// (onBehalfOf = the clicking user) before sending the notification. Stub it so
// the route doesn't touch the real provenance registry under vitest.
vi.mock("$server/extensions/call-provenance", () => ({
  registerFireCallProvenance: () => "ezcall-test",
}));
vi.mock("$server/extensions/file-organizer-events", () => ({
  dispatchFileOrganizerEvent: async (event: string, payload: unknown, deps: Record<string, unknown>) => {
    h.state.dispatchCalls.push({ event, payload, deps });
    return h.state.dispatchResult;
  },
  IN_PROCESS_EVENTS: h.state.inProcessEvents,
}));
vi.mock("$server/extensions/registry", () => ({
  ExtensionRegistry: { getInstance: () => ({ getProcess: h.getProcess }) },
}));
vi.mock("$server/extensions/tool-executor", () => ({
  ToolExecutor: class {
    async ensureSubprocessRpcWired(...a: unknown[]) { return h.ensureWired(...a); }
  },
}));
vi.mock("$server/logger", () => ({
  logger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {} }) },
}));

const { POST } = await import("../routes/api/extensions/[name]/events/[event]/+server");

function hubReq(event: string, payload: Record<string, unknown>, pageId = "review") {
  return {
    request: new Request(`http://localhost/api/extensions/file-organizer/events/${event}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "hub", pageId, payload }),
    }),
    locals: { user: { id: "session-user", email: "t@t.com", name: "T", role: "member" } },
    params: { name: "file-organizer", event },
  };
}

describe("file-organizer hub in-process branch", () => {
  beforeEach(() => {
    h.state.ext = { id: "ext-fo", enabled: true, manifest: h.FO_MANIFEST };
    h.state.dispatchResult = { handled: true, changed: true, ok: true };
    h.state.dispatchCalls.length = 0;
    h.invalidate.mockClear();
    h.getProcess.mockClear();
  });

  test("accept dispatched in-process w/ SESSION userId + cache invalidate", async () => {
    const res = await POST(hubReq("accept", { proposalId: "p1" }) as never);
    expect(res.status).toBe(200);
    expect(h.state.dispatchCalls).toHaveLength(1);
    expect(h.state.dispatchCalls[0]!.event).toBe("accept");
    expect((h.state.dispatchCalls[0]!.deps as { userId: string }).userId).toBe("session-user");
    expect((h.state.dispatchCalls[0]!.deps as { dataDir: string }).dataDir).toBe("/proj/.ezcorp/extension-data/file-organizer");
    expect((h.state.dispatchCalls[0]!.deps as { settings: { quarantineTtlDays: number } }).settings.quarantineTtlDays).toBe(30);
    expect(h.invalidate).toHaveBeenCalledWith("ext-fo", "review");
    expect(h.getProcess).not.toHaveBeenCalled();
  });

  test("caller-supplied userId in payload is ignored (host stamps it)", async () => {
    await POST(hubReq("accept", { proposalId: "p1", userId: "attacker" }) as never);
    expect((h.state.dispatchCalls[0]!.deps as { userId: string }).userId).toBe("session-user");
  });

  test("no cache invalidation when nothing changed", async () => {
    h.state.dispatchResult = { handled: true, changed: false, ok: true };
    await POST(hubReq("accept", { proposalId: "missing" }) as never);
    expect(h.invalidate).not.toHaveBeenCalled();
  });

  test("event NOT in the in-process set falls through to subprocess", async () => {
    const res = await POST(hubReq("teach-rule", { rule: "x" }) as never);
    expect(res.status).toBe(200);
    expect(h.state.dispatchCalls).toHaveLength(0);
    expect(h.getProcess).toHaveBeenCalled();
  });

  test("classify-move forwards to the subprocess (parity with teach-rule)", async () => {
    // classify-move is an agent-driven Hub action — it is NOT in
    // IN_PROCESS_EVENTS, so the route must forward it to the subprocess
    // (prompt → notification), never run it host-side. Same path as
    // teach-rule; this pins the parity so a future refactor can't silently
    // route an agent action through the in-process applier.
    const res = await POST(hubReq("classify-move", { proposalId: "p1" }) as never);
    expect(res.status).toBe(200);
    expect(h.state.dispatchCalls).toHaveLength(0); // never dispatched in-process
    expect(h.getProcess).toHaveBeenCalled(); // spawned + notified instead
  });

  test("undeclared page ⇒ 404 (no dispatch)", async () => {
    const res = await POST(hubReq("accept", { proposalId: "p1" }, "nonexistent") as never);
    expect(res.status).toBe(404);
    expect(h.state.dispatchCalls).toHaveLength(0);
  });

  test("disabled extension ⇒ 404", async () => {
    h.state.ext = { id: "ext-fo", enabled: false, manifest: h.FO_MANIFEST };
    const res = await POST(hubReq("accept", { proposalId: "p1" }) as never);
    expect(res.status).toBe(404);
  });
});
