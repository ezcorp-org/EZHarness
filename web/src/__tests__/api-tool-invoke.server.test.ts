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

vi.mock("$server/runtime/task-tracking-host", () => ({
  ensureTaskTrackingWired: vi.fn(async () => undefined),
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
}) {
  const init: RequestInit = { method: "POST" };
  if (opts.bodyRaw !== undefined) {
    init.body = opts.bodyRaw;
    init.headers = { "content-type": "application/json" };
  } else if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    init.headers = { "content-type": "application/json" };
  }
  return {
    url: new URL("http://localhost/api/tool-invoke"),
    locals: opts.locals ?? {},
    request: new Request("http://localhost/api/tool-invoke", init),
  } as any;
}

const authedUser = { user: { id: "u1", email: "u@x", name: "u", role: "user" } };

async function expectThrown(
  fn: () => Promise<Response> | Response,
  status: number,
): Promise<Response> {
  let res: Response | undefined;
  try {
    res = await fn();
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(Response);
    res = thrown as Response;
  }
  expect(res!.status).toBe(status);
  return res!;
}

describe("POST /api/tool-invoke", () => {
  beforeEach(() => {
    registryGetTool.mockReset();
    registryLoadFromDb.mockClear();
    executeToolCall.mockReset();
    setCurrentUserId.mockClear();
    getPermissionEngineSpy.mockClear();
  });

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
