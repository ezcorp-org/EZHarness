/**
 * v1.4 — generic `!EZ:<extName>:<tool>` forwarder coverage.
 *
 * Sibling to `api-ez-actions-distill.server.test.ts`. The distill
 * test file pins the rich `__ezDistillerOutcome` envelope mapping;
 * THIS file pins:
 *
 *   1. **Backward compat parity**. `!EZ:distill` (legacy alias) and
 *      `!EZ:lessons-distiller:distill_now` (canonical) MUST produce
 *      identical `EzActionResult` shapes for the same tool output.
 *   2. **Minimal-card mapping** for non-distill bundled tools —
 *      `kind: success | error` based on `result.isError`,
 *      `body: <text>` from the result content.
 *   3. **404 paths** for non-bundled extension names + bundled
 *      extension with a missing tool.
 *   4. **Auth gates** — 401 unauthed, 404 cross-conversation.
 *
 * The mock surface mirrors `api-ez-actions-distill.server.test.ts`:
 * ExtensionRegistry, ToolExecutor, PermissionEngine, conversation DB,
 * auth — all stubbed at the import boundary so the route's
 * dispatch flow is exercised without spinning up a real DB.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

// ── ExtensionRegistry mock ────────────────────────────────────────────
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

// ── ToolExecutor mock — captures the arguments each test feeds ────
const executeToolCall = vi.fn();
const setCurrentUserId = vi.fn();
vi.mock("$server/extensions/tool-executor", () => ({
  ToolExecutor: class {
    executeToolCall = executeToolCall;
    setCurrentUserId = setCurrentUserId;
  },
}));

// ── PermissionEngine + bus + ensureInitialized mocks ─────────────────
const getPermissionEngineSpy = vi.fn(
  (..._args: unknown[]): Record<string, unknown> => ({}),
);
vi.mock("$server/extensions/permission-engine", () => ({
  getPermissionEngine: (...args: unknown[]) => getPermissionEngineSpy(...args),
}));

vi.mock("$lib/server/context", () => ({
  ensureInitialized: vi.fn(async () => undefined),
  getBus: () => ({ emit: vi.fn(), on: vi.fn(() => () => undefined) }),
}));

// ── Conversation/message DB mocks ─────────────────────────────────────
const mockGetConversation = vi.fn();
const mockCreateMessage = vi.fn();
const mockGetLatestLeaf = vi.fn();
vi.mock("$server/db/queries/conversations", () => ({
  getConversation: mockGetConversation,
  createMessage: mockCreateMessage,
  getLatestLeaf: mockGetLatestLeaf,
}));

// ── Auth / scope ──────────────────────────────────────────────────────
vi.mock("$lib/server/security/api-keys", () => ({
  requireScope: () => null,
}));

// ── EZ action registry mock ───────────────────────────────────────────
//
// The route still gates on `getEzAction(name)` for non-bundled names.
// We return null by default so the route's 404 path fires when the
// resolver also returns null (unknown action name).
const mockGetEzAction = vi.fn();
vi.mock("$server/runtime/ez-actions/registry", () => ({
  getEzAction: mockGetEzAction,
}));

const { POST } = await import("../routes/api/ez-actions/[name]/+server");

const USER = { id: "u1", email: "u@x", name: "u", role: "user" } as const;

function makeEvent(
  name: string,
  body?: unknown,
  locals: { user?: typeof USER | undefined } = { user: USER },
) {
  const href = `http://localhost/api/ez-actions/${encodeURIComponent(name)}`;
  return {
    params: { name },
    request: new Request(href, {
      method: "POST",
      body: body !== undefined ? JSON.stringify(body) : undefined,
      headers: { "Content-Type": "application/json" },
    }),
    locals,
    url: new URL(href),
  } as never;
}

/** Distiller envelope shape. */
function distillerEnvelope(outcome: unknown): {
  content: { type: "text"; text: string }[];
  isError: boolean;
} {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ __ezDistillerOutcome: true, outcome }),
      },
    ],
    isError: false,
  };
}

/** Plain text result for the non-distill minimal-card branch. */
function plainTextResult(text: string, isError = false): {
  content: { type: "text"; text: string }[];
  isError: boolean;
} {
  return { content: [{ type: "text" as const, text }], isError };
}

beforeEach(() => {
  registryGetTool.mockReset();
  registryLoadFromDb.mockReset();
  registryLoadFromDb.mockResolvedValue(undefined);
  executeToolCall.mockReset();
  setCurrentUserId.mockReset();
  getPermissionEngineSpy.mockClear();
  mockGetConversation.mockReset();
  mockCreateMessage.mockReset();
  mockGetLatestLeaf.mockReset();
  mockGetLatestLeaf.mockResolvedValue(null);
  mockGetEzAction.mockReset();
  // Default: registry has no static action — non-bundled names 404.
  mockGetEzAction.mockReturnValue(null);
  mockGetConversation.mockResolvedValue({
    id: "c1",
    userId: USER.id,
    projectId: "p1",
  });
  mockCreateMessage.mockImplementation(
    async (_convId: string, data: { role: string; content: string }) => ({
      id: "msg-X",
      role: data.role,
      content: data.content,
    }),
  );
  // Default: tools are registered. Tests that exercise the
  // missing-tool branch override this with `mockReturnValue(null)`.
  registryGetTool.mockImplementation((name: string) => ({
    name,
    handler: vi.fn(),
  }));
});

async function dispatch(
  name: string,
  body: unknown = { conversationId: "c1" },
  locals: { user?: typeof USER | undefined } = { user: USER },
) {
  // The route's auth middleware (`requireAuth`) THROWS a `Response`
  // when locals.user is missing — it's the project's
  // throw-Response-as-error pattern, predates SvelteKit's `error()`.
  // The test harness has to catch the throw so the auth-gate
  // assertions can inspect the rejected response.
  let res: Response;
  try {
    res = await POST(makeEvent(name, body, locals));
  } catch (thrown) {
    if (thrown instanceof Response) {
      res = thrown;
    } else {
      throw thrown;
    }
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // Some 4xx responses have no JSON body.
  }
  return { status: res.status, json: json as { error?: string; result?: { kind: string; card: { title: string; body: string; variant: string }; ref?: unknown } } | null };
}

// ─────────────────────────────────────────────────────────────────────
// Backward-compat parity: legacy `distill` alias === canonical name
// ─────────────────────────────────────────────────────────────────────

describe("legacy `distill` alias and canonical name produce identical results", () => {
  test("alias and canonical both invoke lessons-distiller__distill_now with the distiller-envelope mapping", async () => {
    const successOutcome = {
      kind: "success",
      lesson: { title: "Use parameterized queries", slug: "use-parameterized-queries" },
    };

    // First call — legacy alias.
    executeToolCall.mockResolvedValueOnce(distillerEnvelope(successOutcome));
    const aliasRun = await dispatch("distill");

    // Second call — canonical name.
    executeToolCall.mockResolvedValueOnce(distillerEnvelope(successOutcome));
    const canonicalRun = await dispatch("lessons-distiller:distill_now");

    // Same EzActionResult (only the message id differs, which we
    // strip below). The richer `__ezDistillerOutcome` mapping fired
    // in BOTH cases — verifying the v1.4 forwarder routes both names
    // through the same envelope-parsing branch.
    expect(aliasRun.status).toBe(200);
    expect(canonicalRun.status).toBe(200);
    expect(aliasRun.json?.result).toEqual(canonicalRun.json?.result);
    expect(aliasRun.json?.result?.kind).toBe("success");
    expect(aliasRun.json?.result?.card.title).toMatch(/lesson captured/i);
    expect(aliasRun.json?.result?.ref).toEqual({
      kind: "lesson",
      slug: "use-parameterized-queries",
    });

    // Both calls hit the same namespaced tool name.
    expect(executeToolCall).toHaveBeenCalledTimes(2);
    const firstCallTool = executeToolCall.mock.calls[0]![0];
    const secondCallTool = executeToolCall.mock.calls[1]![0];
    expect(firstCallTool).toBe("lessons-distiller__distill_now");
    expect(secondCallTool).toBe("lessons-distiller__distill_now");
  });

  test("alias decline propagates the same way as canonical decline", async () => {
    executeToolCall.mockResolvedValueOnce(
      distillerEnvelope({ kind: "decline", reason: "empty_conversation" }),
    );
    const aliasRun = await dispatch("distill");
    executeToolCall.mockResolvedValueOnce(
      distillerEnvelope({ kind: "decline", reason: "empty_conversation" }),
    );
    const canonicalRun = await dispatch("lessons-distiller:distill_now");

    expect(aliasRun.json?.result).toEqual(canonicalRun.json?.result);
    expect(aliasRun.json?.result?.kind).toBe("decline");
    expect(aliasRun.json?.result?.card.title).toMatch(/not enough context/i);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Minimal-card mapping for non-distill bundled tools
// ─────────────────────────────────────────────────────────────────────

describe("non-distill bundled tools → minimal-card mapping", () => {
  test("memory-extractor:any-tool with text output → success card carrying the text body", async () => {
    executeToolCall.mockResolvedValueOnce(
      plainTextResult("compaction merged 3 memories"),
    );
    const { status, json } = await dispatch("memory-extractor:any-tool");
    expect(status).toBe(200);
    expect(json?.result?.kind).toBe("success");
    expect(json?.result?.card.title).toMatch(/memory-extractor ran successfully/i);
    expect(json?.result?.card.body).toBe("compaction merged 3 memories");
    expect(json?.result?.card.variant).toBe("success");
    // No `ref` field — that's distiller-specific.
    expect(json?.result?.ref).toBeUndefined();

    // Tool was invoked with the namespaced name `<ext>__<tool>`.
    const tool = executeToolCall.mock.calls[0]![0];
    expect(tool).toBe("memory-extractor__any-tool");
  });

  test("non-distill bundled tool with isError=true → error card with text body", async () => {
    executeToolCall.mockResolvedValueOnce(
      plainTextResult("compaction failed: db unavailable", true),
    );
    const { status, json } = await dispatch("memory-extractor:any-tool");
    expect(status).toBe(200);
    expect(json?.result?.kind).toBe("error");
    expect(json?.result?.card.title).toMatch(/memory-extractor returned an error/i);
    expect(json?.result?.card.body).toBe("compaction failed: db unavailable");
    expect(json?.result?.card.variant).toBe("error");
  });

  test("non-distill bundled tool with empty text output → '(no output)' placeholder", async () => {
    executeToolCall.mockResolvedValueOnce(plainTextResult(""));
    const { json } = await dispatch("memory-extractor:any-tool");
    expect(json?.result?.kind).toBe("success");
    expect(json?.result?.card.body).toBe("(no output)");
  });

  test("non-distill bundled tool with empty error output → '(no detail)' placeholder", async () => {
    executeToolCall.mockResolvedValueOnce(plainTextResult("", true));
    const { json } = await dispatch("memory-extractor:any-tool");
    expect(json?.result?.kind).toBe("error");
    expect(json?.result?.card.body).toBe("(no detail)");
  });

  test("the distiller-envelope text on a NON-distill tool is NOT parsed — raw text body", async () => {
    // Defense-in-depth — only `lessons-distiller:distill_now` parses
    // the `__ezDistillerOutcome` envelope. Other extensions returning
    // identically-shaped JSON would still get the minimal-card path
    // (and the body is the verbatim JSON text, not the parsed
    // outcome).
    executeToolCall.mockResolvedValueOnce(
      plainTextResult(
        JSON.stringify({ __ezDistillerOutcome: true, outcome: { kind: "success" } }),
      ),
    );
    const { json } = await dispatch("memory-extractor:any-tool");
    expect(json?.result?.kind).toBe("success");
    // Minimal-card title — NOT "Lesson captured".
    expect(json?.result?.card.title).toMatch(/memory-extractor ran successfully/i);
    expect(json?.result?.card.body).toContain("__ezDistillerOutcome");
  });

  test("non-distill bundled tool throws → minimal-card error labelled with the extension name", async () => {
    executeToolCall.mockRejectedValueOnce(new Error("tool exploded"));
    const { json } = await dispatch("memory-extractor:any-tool");
    expect(json?.result?.kind).toBe("error");
    expect(json?.result?.card.title).toMatch(/memory-extractor failed/i);
    expect(json?.result?.card.body).toMatch(/tool exploded/);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 404 paths
// ─────────────────────────────────────────────────────────────────────

describe("404 — non-bundled extension name", () => {
  test("user-installed (non-bundled) extension name → 404", async () => {
    const { status } = await dispatch("user-ext-fake:do-thing");
    expect(status).toBe(404);
    // Tool was never invoked.
    expect(executeToolCall).not.toHaveBeenCalled();
  });

  test("non-existent action name (no colon, not in registry) → 404", async () => {
    mockGetEzAction.mockReturnValue(null);
    const { status } = await dispatch("definitely-not-an-action");
    expect(status).toBe(404);
  });
});

describe("404 — bundled extension + missing tool", () => {
  test("memory-extractor:nonexistent-tool not in registry → minimal-card error", async () => {
    // Registry's getRegisteredTool returns null for both the initial
    // lookup AND the post-loadFromDb retry — same path the distill
    // forwarder takes when lessons-distiller is uninstalled.
    registryGetTool.mockReturnValue(null);
    const { status, json } = await dispatch("memory-extractor:nonexistent-tool");
    // The route returns 200 with an error CARD (not an HTTP 404) —
    // the EzActionResult contract is "always render a card". The
    // card is the user-facing 404.
    expect(status).toBe(200);
    expect(json?.result?.kind).toBe("error");
    expect(json?.result?.card.title).toMatch(/memory-extractor not available/i);
    expect(json?.result?.card.body).toMatch(/nonexistent-tool/i);
    // Self-heal attempted exactly once.
    expect(registryLoadFromDb).toHaveBeenCalledTimes(1);
    // Tool was never executed.
    expect(executeToolCall).not.toHaveBeenCalled();
  });

  test("missing distiller tool retains the v1.3 'Distiller unavailable' wording (backward compat)", async () => {
    registryGetTool.mockReturnValue(null);
    const { json } = await dispatch("distill");
    expect(json?.result?.card.title).toMatch(/distiller unavailable/i);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Auth gates
// ─────────────────────────────────────────────────────────────────────

describe("auth gates", () => {
  test("missing user (unauthed) → 401", async () => {
    // requireAuth throws a SvelteKit `error(401, ...)` when
    // `locals.user` is missing; the framework converts that to a
    // 401 Response with a JSON body. The exact body text is the
    // SvelteKit-default `{message}` shape; we only assert the status
    // here because the body wording is framework-owned, not ours.
    const { status } = await dispatch(
      "memory-extractor:any-tool",
      { conversationId: "c1" },
      { user: undefined },
    );
    expect(status).toBe(401);
    // Tool was never executed.
    expect(executeToolCall).not.toHaveBeenCalled();
  });

  test("conversation owned by a different user → 404 (id-enumeration defense)", async () => {
    mockGetConversation.mockResolvedValue({
      id: "c1",
      userId: "other-user",
      projectId: "p1",
    });
    const { status, json } = await dispatch("memory-extractor:any-tool");
    expect(status).toBe(404);
    // No tool call leaked through the ownership gate.
    expect(executeToolCall).not.toHaveBeenCalled();
    // 404 body carries the same wording for "missing" and
    // "not-yours" — that's the id-enumeration defense pattern (the
    // client can't distinguish "this id doesn't exist" from "this
    // id exists but isn't yours").
    expect(json).toEqual({ error: "Conversation not found" });
  });

  test("missing conversationId in body → 400", async () => {
    const { status } = await dispatch("memory-extractor:any-tool", {});
    expect(status).toBe(400);
  });
});
