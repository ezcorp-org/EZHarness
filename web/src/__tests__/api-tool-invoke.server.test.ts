/**
 * Server-handler unit tests for /api/tool-invoke/+server.ts.
 *
 * The handler pulls in the full runtime (ExtensionRegistry, ToolExecutor,
 * context.ensureInitialized, task-tracking-host). We mock each of those
 * at the module boundary so the test never touches the real runtime.
 * Coverage focuses on the auth/scope gate, the JSON/field validation
 * gate, and the 404 "Tool not found" shape.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";
import { expectThrownResponse as expectThrown, makeRequestEvent } from "./helpers/server-route-test-utils";

const registryGetTool = vi.fn();
const registryLoadFromDb = vi.fn(async () => undefined);
vi.mock("$server/extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      getRegisteredTool: registryGetTool,
      loadFromDb: registryLoadFromDb,
    }),
  },
}));

const executeToolCall = vi.fn();
const setCurrentUserId = vi.fn();
vi.mock("$server/extensions/tool-executor", () => ({
  ToolExecutor: class {
    executeToolCall = executeToolCall;
    setCurrentUserId = setCurrentUserId;
  },
}));

vi.mock("$lib/server/context", () => ({
  ensureInitialized: vi.fn(async () => undefined),
  getBus: () => ({
    emit: vi.fn(),
    on: vi.fn(() => () => undefined),
  }),
}));

const ensureTaskTrackingWired = vi.fn(async () => undefined);
vi.mock("$server/runtime/task-tracking-host", () => ({ ensureTaskTrackingWired }));

// ── sec F2: the two gates the route grew. ──
// Ownership defaults to "the caller owns it"; individual tests set
// `ownershipResult = null` to deny. `conv.projectId` is what the route
// hands the wire gate as the project coordinate.
let ownershipResult: unknown = { conv: { id: "c", projectId: "proj-1" }, root: { id: "c" } };
const resolveRootConversationForOwnership = vi.fn(async () => ownershipResult);
vi.mock("$lib/server/conversation-ownership", () => ({
  resolveRootConversationForOwnership: () => resolveRootConversationForOwnership(),
}));

let extensionRow: unknown = { id: "ext-1", name: "x", manifest: {}, source: "local", isBundled: false };
const getExtension = vi.fn(async () => extensionRow);
vi.mock("$server/db/queries/extensions", () => ({ getExtension: () => getExtension() }));

// The gate itself is unit-tested in src/__tests__/extension-wire-authz.test.ts
// and driven end-to-end against real grants in
// src/__tests__/mcp-wire-gate-bypasses.integration.test.ts. Here it is a seam,
// so this file can assert the ROUTE's half: that it asks, with the right
// coordinates, and turns a denial into the unknown-tool 404.
let wireAllowed = true;
const canWireExtension = vi.fn(async (_ext: unknown, _actor: unknown) => wireAllowed);
vi.mock("$server/auth/extension-wire-authz", () => ({
  canWireExtension: (ext: unknown, actor: unknown) => canWireExtension(ext, actor),
}));

// PDP singleton — the handler at `+server.ts:92` calls
// `getPermissionEngine()` on the success path. Without this mock the
// real factory throws "PermissionEngine not initialized — first call
// must provide deps" because vitest never boots the runtime.
//
// Mirrors the pattern established in `extensions-events-route.test.ts`
// (Phase 54 Plan 03, commit 0e69a2c) — surface a sentinel singleton so
// future tests can do identity comparisons if the PDP wiring needs to
// be asserted; for now the only requirement is "don't throw at L92".
const MOCK_ENGINE = { __mock: "permission-engine-singleton" };
const getPermissionEngineSpy = vi.fn(
  (..._args: unknown[]): Record<string, unknown> => MOCK_ENGINE,
);
vi.mock("$server/extensions/permission-engine", () => ({
  getPermissionEngine: (...args: unknown[]) => getPermissionEngineSpy(...args),
}));

const { POST } = await import("../routes/api/tool-invoke/+server");

function makeEvent(opts: {
  body?: unknown;
  locals?: Record<string, unknown>;
  bodyRaw?: string;
  signal?: AbortSignal;
}) {
  const init: RequestInit = { method: "POST", signal: opts.signal };
  if (opts.bodyRaw !== undefined) {
    init.body = opts.bodyRaw;
    init.headers = { "content-type": "application/json" };
  } else if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { "content-type": "application/json" };
  }
  return makeRequestEvent("http://localhost/api/tool-invoke", {
    locals: opts.locals ?? {},
    request: init,
  });
}

const authedUser = { user: { id: "u1", email: "u@x", name: "u", role: "user" } };

for (const outcome of ["throw", "success", "error"] as const) test(`cancelled ${outcome} returns 499 without retry`, async () => {
  const controller = new AbortController();
  registryGetTool.mockReturnValue({ name: "ext__ok" });
  executeToolCall.mockImplementation(async (...args: unknown[]) => {
    expect((args[4] as { signal: AbortSignal }).signal.aborted).toBe(false);
    controller.abort();
    expect((args[4] as { signal: AbortSignal }).signal.aborted).toBe(true);
    if (outcome === "throw") throw new Error("Worker closed");
    return { isError: outcome === "error", content: [{ type: "text", text: "result" }] };
  });
  const response = await POST(makeEvent({ locals: authedUser, signal: controller.signal, body: { extensionName: "ext", toolName: "ok", conversationId: "c1", invocationId: "i1" } }));
  expect(response.status).toBe(499);
  expect(await response.json()).toMatchObject({ success: false, retryCount: 0 });
  expect(executeToolCall).toHaveBeenCalledTimes(1);
});

test("release-bound failures retain their error without retry", async () => {
  registryGetTool.mockReturnValue({ name: "ext__ok" });
  executeToolCall.mockRejectedValue(new Error("Release changed"));
  const response = await POST(makeEvent({ locals: authedUser, body: { extensionName: "ext", toolName: "ok", conversationId: "c1", invocationId: "i1", expectedReleaseBinding: "a".repeat(64) } }));
  expect(response.status).toBe(500);
  expect(await response.json()).toMatchObject({ error: "Release changed", retryCount: 0 });
  expect(executeToolCall).toHaveBeenCalledTimes(1);
});

for (const outcome of ["throw", "error"] as const) test(`an admitted effect followed by ${outcome} is never repeated`, async () => {
  let writes = 0;
  registryGetTool.mockReturnValue({ name: "ext__ok" });
  executeToolCall.mockImplementation(async () => {
    writes++;
    if (outcome === "throw") throw new Error("Response lost after write");
    return { isError: true, content: [{ type: "text", text: "Response lost after write" }] };
  });
  const response = await POST(makeEvent({ locals: authedUser, body: { extensionName: "ext", toolName: "ok", conversationId: "c1", invocationId: "i1" } }));
  expect(await response.json()).toMatchObject({ success: false, error: "Response lost after write", retryCount: 0 });
  expect(writes).toBe(1);
});

// FILE-level, not inside a describe: the mutable `ownershipResult` /
// `extensionRow` / `wireAllowed` seams are read by every describe in this
// file, so a reset scoped to one block leaks a previous test's denial into
// the next block and produces failures that look like the route misbehaving.
beforeEach(() => {
  registryGetTool.mockReset();
  registryLoadFromDb.mockClear();
  executeToolCall.mockReset();
  setCurrentUserId.mockClear();
  getPermissionEngineSpy.mockClear();
  ensureTaskTrackingWired.mockClear();
  resolveRootConversationForOwnership.mockClear();
  getExtension.mockClear();
  canWireExtension.mockClear();
  ownershipResult = { conv: { id: "c", projectId: "proj-1" }, root: { id: "c" } };
  extensionRow = { id: "ext-1", name: "x", manifest: {}, source: "local", isBundled: false };
  wireAllowed = true;
});

describe("POST /api/tool-invoke", () => {

  test("rejects 401 when locals.user is missing", async () => {
    await expectThrown(
      () =>
        POST(
          makeEvent({
            body: {
              extensionName: "x",
              toolName: "y",
              input: {},
              conversationId: "c",
              invocationId: "i",
            },
          }),
        ),
      401,
    );
  });

  test("rejects 403 when API-key lacks 'extensions' scope", async () => {
    const res = await POST(
      makeEvent({
        locals: { ...authedUser, apiKeyScopes: ["read"] },
        body: {
          extensionName: "x",
          toolName: "y",
          input: {},
          conversationId: "c",
          invocationId: "i",
        },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { required?: string };
    expect(body.required).toBe("extensions");
  });

  test("rejects 400 when body is not valid JSON", async () => {
    const res = await POST(
      makeEvent({ locals: authedUser, bodyRaw: "not-json" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Invalid JSON body");
  });

  test("rejects 400 when required fields are missing", async () => {
    const res = await POST(
      makeEvent({
        locals: authedUser,
        body: { extensionName: "x", toolName: "y" }, // missing conversationId, invocationId
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Missing required fields");
  });

  test("returns 404 when tool is not registered even after reload", async () => {
    registryGetTool.mockReturnValue(undefined);
    const res = await POST(
      makeEvent({
        locals: authedUser,
        body: {
          extensionName: "ext",
          toolName: "missing",
          input: {},
          conversationId: "c1",
          invocationId: "i1",
        },
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Tool not found");
    // reload is attempted once when the first lookup misses.
    expect(registryLoadFromDb).toHaveBeenCalledTimes(1);
  });

  test("returns 200 success: true when executeToolCall reports no error", async () => {
    registryGetTool.mockReturnValue({ name: "ext__ok" });
    executeToolCall.mockResolvedValue({
      isError: false,
      content: [{ type: "text", text: "done" }],
    });
    const res = await POST(
      makeEvent({
        locals: authedUser,
        body: {
          extensionName: "ext",
          toolName: "ok",
          input: { a: 1 },
          conversationId: "c1",
          invocationId: "i1",
        },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success?: boolean;
      output?: string;
      toolCallId?: string;
    };
    expect(body.success).toBe(true);
    expect(body.output).toBe("done");
    expect(body.toolCallId).toBe("i1");
  });

  // Regression — the endpoint MUST set the acting user on the executor
  // before executing so user-scoped extension storage (e.g. graded-card-
  // scanner's set_psa_token) resolves to the caller's own bucket. Under the
  // pre-fix code `setCurrentUserId` was never called → `ctx.userId` was null
  // → the storage RPC failed with "User scope unavailable in this context".
  // This test FAILS on the old code (spy never invoked) and PASSES now.
  test("sets the acting (authenticated) user id on the executor before executing", async () => {
    registryGetTool.mockReturnValue({ name: "ext__ok" });
    executeToolCall.mockResolvedValue({
      isError: false,
      content: [{ type: "text", text: "ok" }],
    });
    await POST(
      makeEvent({
        locals: authedUser,
        body: {
          extensionName: "ext",
          toolName: "ok",
          input: {},
          conversationId: "c1",
          invocationId: "i1",
        },
      }),
    );
    // Called with the authenticated caller's id (acting-user semantics).
    expect(setCurrentUserId).toHaveBeenCalledTimes(1);
    expect(setCurrentUserId).toHaveBeenCalledWith("u1");
    // …and BEFORE the tool is executed, or the scope is still unset when the
    // tool's storage RPC runs.
    expect(setCurrentUserId.mock.invocationCallOrder[0]!).toBeLessThan(
      executeToolCall.mock.invocationCallOrder[0]!,
    );
  });

  // Regression sentinel — Phase 54 gap-closure (2026-05-11).
  // The handler at +server.ts:92 calls `getPermissionEngine()` on the
  // success path; the pre-fix test never reached that branch because
  // the prior tests (401/403/400/404) short-circuit before line 92.
  // This sentinel locks in the call so a future refactor that drops
  // the PDP wiring fails LOUDLY rather than silently widening
  // permissions on tool-invoke.
  //
  // Deps-shape lock (mirrors the [N4] test in api-ez-actions-distill,
  // adapted — Phase 54 gap-closure validator nit):
  //
  // tool-invoke deliberately calls `getPermissionEngine()` with NO
  // ARGS — see +server.ts:89-91 ("Pass no deps so a placeholder bus/db
  // here can't lose an init race; the factory throws clearly if the
  // singleton isn't pre-init"). This is the OPPOSITE contract from the
  // distill route (which is the first PermissionEngine touch on cold
  // start and MUST pass {registry, bus, db}). Locking the zero-arg
  // shape in here so a future refactor that "helpfully" reintroduces
  // a deps object on this hot path — re-opening the init race the
  // L89-91 comment warns about — fails LOUDLY.
  test("getPermissionEngine() is invoked on the success path with NO ARGS (PDP wiring + init-race sentinel)", async () => {
    registryGetTool.mockReturnValue({ name: "ext__ok" });
    executeToolCall.mockResolvedValue({
      isError: false,
      content: [{ type: "text", text: "ok" }],
    });
    await POST(
      makeEvent({
        locals: authedUser,
        body: {
          extensionName: "ext",
          toolName: "ok",
          input: {},
          conversationId: "c1",
          invocationId: "i1",
        },
      }),
    );
    expect(getPermissionEngineSpy).toHaveBeenCalled();
    // Deps-shape lock: tool-invoke MUST call the factory with zero
    // args (read-only singleton-fetch contract). If a future refactor
    // adds a deps object, this assertion catches it before the init
    // race re-opens.
    expect(getPermissionEngineSpy).toHaveBeenCalledWith();
    const callArgs = getPermissionEngineSpy.mock.calls[0]!;
    expect(callArgs.length).toBe(0);
  });
});

// ── sec F2 ───────────────────────────────────────────────────────────
//
// This route resolved `<ext>__<tool>` from the GLOBAL registry map and
// dispatched, consulting neither `conversation_extensions` nor the
// conversation's owner. `requireScope(locals, "extensions")` is a no-op for a
// cookie session, so for a browser user `requireAuth` was the only gate: a
// member could spend an admin-installed MCP credential inside the admin's own
// conversation. Both gates below are new.
describe("POST /api/tool-invoke — conversation ownership", () => {
  const body = {
    extensionName: "ext",
    toolName: "ok",
    input: {},
    conversationId: "someone-elses",
    invocationId: "i1",
  };

  test("404s when the caller does not own the conversation, and never dispatches", async () => {
    ownershipResult = null;
    registryGetTool.mockReturnValue({ name: "ext__ok", extensionId: "ext-1" });
    const res = await POST(makeEvent({ locals: authedUser, body }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("Conversation not found");
    expect(executeToolCall).not.toHaveBeenCalled();
  });

  test("the ownership check runs BEFORE the task-tracking wire, which mutates", async () => {
    // `ensureTaskTrackingWired` writes `conversation_extensions` for the named
    // conversation. Ordering it after the check is the whole reason the gate
    // sits where it does.
    ownershipResult = null;
    const res = await POST(
      makeEvent({ locals: authedUser, body: { ...body, extensionName: "task-tracking" } }),
    );
    expect(res.status).toBe(404);
    expect(ensureTaskTrackingWired).not.toHaveBeenCalled();
  });
});

describe("POST /api/tool-invoke — per-extension wire authorization", () => {
  const body = {
    extensionName: "weather-mcp",
    toolName: "forecast",
    input: {},
    conversationId: "c1",
    invocationId: "i1",
  };

  test("a denied extension 404s with the SAME shape as an unregistered tool", async () => {
    registryGetTool.mockReturnValue({ name: "weather-mcp__forecast", extensionId: "ext-mcp" });
    wireAllowed = false;
    const res = await POST(makeEvent({ locals: authedUser, body }));
    expect(res.status).toBe(404);
    // Not a 403: a member must not learn that an admin-installed MCP server
    // by this name exists.
    expect((await res.json()).error).toBe("Tool not found: weather-mcp__forecast");
    expect(executeToolCall).not.toHaveBeenCalled();
  });

  test("a vanished extension row is fail-closed", async () => {
    registryGetTool.mockReturnValue({ name: "weather-mcp__forecast", extensionId: "ext-mcp" });
    extensionRow = null;
    const res = await POST(makeEvent({ locals: authedUser, body }));
    expect(res.status).toBe(404);
    expect(executeToolCall).not.toHaveBeenCalled();
  });

  test("the gate is asked with the caller and the CONVERSATION's project", async () => {
    registryGetTool.mockReturnValue({ name: "weather-mcp__forecast", extensionId: "ext-mcp" });
    executeToolCall.mockResolvedValue({ isError: false, content: [{ type: "text", text: "ok" }] });
    await POST(makeEvent({ locals: authedUser, body }));
    expect(canWireExtension).toHaveBeenCalledTimes(1);
    const [ext, actor] = canWireExtension.mock.calls[0]!;
    expect(ext).toEqual(extensionRow);
    // The project comes off the conversation row, never the request body —
    // otherwise a caller could pick the coordinates their grants cover.
    expect(actor).toEqual({ user: { id: "u1", role: "user" }, projectId: "proj-1" });
  });

  test("a conversation with no project asks at the all-projects coordinate", async () => {
    ownershipResult = { conv: { id: "c1" }, root: { id: "c1" } };
    registryGetTool.mockReturnValue({ name: "weather-mcp__forecast", extensionId: "ext-mcp" });
    executeToolCall.mockResolvedValue({ isError: false, content: [{ type: "text", text: "ok" }] });
    await POST(makeEvent({ locals: authedUser, body }));
    expect((canWireExtension.mock.calls[0]![1] as { projectId: unknown }).projectId).toBeNull();
  });

  test("an allowed extension still dispatches — no regression", async () => {
    registryGetTool.mockReturnValue({ name: "ext__ok", extensionId: "ext-1" });
    executeToolCall.mockResolvedValue({ isError: false, content: [{ type: "text", text: "ok" }] });
    const res = await POST(
      makeEvent({ locals: authedUser, body: { ...body, extensionName: "ext", toolName: "ok" } }),
    );
    expect(res.status).toBe(200);
    expect(executeToolCall).toHaveBeenCalledTimes(1);
  });

});

// ── sec U5: a capability denial is a REFUSAL, not a server fault ──────
//
// The PDP's `PermissionDeniedError` fell through to the generic catch, which
// (a) retried it MAX_RETRIES times — one denied call wrote THREE
// `ext:perm:denied` audit rows and counted as three denials in /audit — and
// (b) returned 500, which reads as "the server broke" to every client.
describe("POST /api/tool-invoke — capability denial", () => {
  const body = {
    extensionName: "probe-http",
    toolName: "echo",
    input: {},
    conversationId: "c1",
    invocationId: "i1",
  };

  /** Shaped like `tool-executor/errors.ts`'s class: the route matches on
   *  `name`, because the module is mocked at the alias boundary here and
   *  `instanceof` would compare against a different class identity. */
  function permissionDenied(reason: string) {
    const e = new Error(
      `Permission denied for tool "echo" from extension "710da8a9-1111-2222-3333-444455556666" — ${reason}`,
    );
    e.name = "PermissionDeniedError";
    (e as Error & { reason?: string }).reason = reason;
    return e;
  }

  test("returns 403, not 500", async () => {
    registryGetTool.mockReturnValue({ name: "probe-http__echo", extensionId: "ext-1" });
    executeToolCall.mockRejectedValue(permissionDenied("Missing capability network (127.0.0.1)"));
    const res = await POST(makeEvent({ locals: authedUser, body }));
    expect(res.status).toBe(403);
    expect((await res.json()).success).toBe(false);
  });

  test("is NOT retried — one denied call, one dispatch attempt", async () => {
    // The audit consequence is the point: each retry wrote its own
    // `ext:perm:denied` row, so a single refusal read as three denials.
    registryGetTool.mockReturnValue({ name: "probe-http__echo", extensionId: "ext-1" });
    executeToolCall.mockRejectedValue(permissionDenied("Missing capability network (127.0.0.1)"));
    await POST(makeEvent({ locals: authedUser, body }));
    expect(executeToolCall).toHaveBeenCalledTimes(1);
  });

  test("names the extension, not its UUID, and keeps the reason", async () => {
    registryGetTool.mockReturnValue({ name: "probe-http__echo", extensionId: "ext-1" });
    executeToolCall.mockRejectedValue(permissionDenied("Missing capability network (127.0.0.1)"));
    const res = await POST(makeEvent({ locals: authedUser, body }));
    const err = (await res.json()).error as string;
    expect(err).toContain('from extension "probe-http"');
    expect(err).toContain("Missing capability network (127.0.0.1)");
    // The raw message embedded the row UUID, which names nothing to whoever
    // reads the response.
    expect(err).not.toContain("710da8a9");
  });

  test("a non-permission error returns 500 without repeating uncertain effects", async () => {
    registryGetTool.mockReturnValue({ name: "probe-http__echo", extensionId: "ext-1" });
    executeToolCall.mockRejectedValue(new Error("subprocess died"));
    const res = await POST(makeEvent({ locals: authedUser, body }));
    expect(res.status).toBe(500);
    expect(executeToolCall).toHaveBeenCalledTimes(1);
  });

  test("a tool-level failure still RESOLVES 200 — the harness contract is unchanged", async () => {
    registryGetTool.mockReturnValue({ name: "probe-http__echo", extensionId: "ext-1" });
    executeToolCall.mockResolvedValue({ isError: true, content: [{ type: "text", text: "boom" }] });
    const res = await POST(makeEvent({ locals: authedUser, body }));
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(false);
  });
});
