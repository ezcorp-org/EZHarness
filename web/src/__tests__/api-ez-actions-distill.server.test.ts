/**
 * Vitest server-handler tests for the `name === "distill"` forwarder
 * in `POST /api/ez-actions/[name]/+server.ts`.
 *
 * The sibling `api-ez-actions.server.test.ts` covers the generic
 * action-registry path (auth, ownership gate, persistence shape) using
 * `name=test-action`. This file targets `forwardDistillToBundled` —
 * the Phase 53 Stage 1 routing that hands `!EZ:distill` to the bundled
 * `lessons-distiller` extension's `distill_now` tool. Coverage gap
 * called out by the audit (HIGH): the parity test exercises the
 * extension's `distill()` directly, not the forwarder's
 * `DistillerEnvelope` → `EzActionResult` mapping.
 *
 * What the forwarder does, condensed:
 *   1. Resolve `lessons-distiller__distill_now` via ExtensionRegistry.
 *      Not registered (even after `loadFromDb`) → "Distiller unavailable".
 *   2. Build a ToolExecutor + invoke the tool with the conversation id.
 *      Throw → "Distiller failed (Unexpected error: …)".
 *   3. Parse the tool's text result as a `DistillerEnvelope`. Non-JSON
 *      OR missing `__ezDistillerOutcome` flag → "Distiller failed
 *      (unexpected response shape)".
 *   4. Map the parsed outcome to one of the 11 `EzActionResult`
 *      variants:
 *        - 1 success
 *        - 7 declines (empty_conversation, llm_empty, llm_malformed,
 *          slug_collision, settings_disabled, trigger_gate_blocked,
 *          default-branch fallback)
 *        - 3 errors (llm_error, db_error, internal/default)
 *
 * Each branch gets its own test below — that's the regression matrix
 * the audit asked for. Mocks are scoped to the modules the route
 * imports via `$server/...` aliases.
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

// ── ToolExecutor mock — captures the JSON envelope each test feeds ────
const executeToolCall = vi.fn();
const setCurrentUserId = vi.fn();
vi.mock("$server/extensions/tool-executor", () => ({
  ToolExecutor: class {
    executeToolCall = executeToolCall;
    setCurrentUserId = setCurrentUserId;
  },
}));

// ── PermissionEngine + bus + ensureInitialized mocks ─────────────────
//
// Phase 53.7 — capture the deps object passed to `getPermissionEngine`.
// Pre-fix the forwarder called `getPermissionEngine()` zero-arg, which
// threw "not initialized" on cold start (the forwarder is the FIRST
// touch in the boot sequence — no agent has streamed yet so the
// engine singleton hasn't been built). Commit `275ebce` switched it to
// `getPermissionEngine({registry, bus, db})`. Lock that signature in.
const getPermissionEngineSpy = vi.fn((..._args: unknown[]): Record<string, unknown> => ({}));
vi.mock("$server/extensions/permission-engine", () => ({
  getPermissionEngine: (...args: unknown[]) => getPermissionEngineSpy(...args),
}));

vi.mock("$lib/server/context", () => ({
  ensureInitialized: vi.fn(async () => undefined),
  getBus: () => ({ emit: vi.fn(), on: vi.fn(() => () => undefined) }),
}));

// ── Conversation/message DB mocks (mirrors api-ez-actions.server.test.ts) ──
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

// ── EZ action registry mock — the route still calls `getEzAction(name)`
// to gate the 404 "no such ez action" branch BEFORE the distill
// special-case fires. Returning a stub action keeps the route past
// that gate; the action's handler is never invoked because the
// forwarder takes over for `name === "distill"`. ─────────────────────
const mockGetEzAction = vi.fn();
vi.mock("$server/runtime/ez-actions/registry", () => ({
  getEzAction: mockGetEzAction,
}));

const { POST } = await import("../routes/api/ez-actions/[name]/+server");

const USER = { id: "u1", email: "u@x", name: "u", role: "user" } as const;

function makeEvent(body?: unknown) {
  const href = "http://localhost/api/ez-actions/distill";
  return {
    params: { name: "distill" },
    request: new Request(href, {
      method: "POST",
      body: body !== undefined ? JSON.stringify(body) : undefined,
      headers: { "Content-Type": "application/json" },
    }),
    locals: { user: USER },
    url: new URL(href),
  } as never;
}

/** Assemble the tool-result envelope the forwarder parses. */
function envelopeResult(outcome: unknown): { content: { type: "text"; text: string }[]; isError: boolean } {
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
  // The route's `getEzAction("distill")` call must return a truthy
  // action (legacy in-process handler stays registered through Stage 2)
  // to bypass the 404 gate and reach the forwarder.
  mockGetEzAction.mockReset();
  mockGetEzAction.mockReturnValue({
    name: "distill",
    description: "(legacy registry stub — never invoked by forwarder)",
    handler: vi.fn(),
  });
  // Conversation lookup + ownership pass by default; persistence stub.
  mockGetConversation.mockResolvedValue({ id: "c1", userId: USER.id, projectId: "p1" });
  mockCreateMessage.mockImplementation(async (_convId: string, data: { role: string; content: string }) => ({
    id: "msg-X",
    role: data.role,
    content: data.content,
  }));
  // Default: tool IS registered so the "unavailable" branch is opt-in.
  registryGetTool.mockReturnValue({
    name: "lessons-distiller__distill_now",
    handler: vi.fn(),
  });
});

// Helper — invoke the route, fetch the persisted EzActionResult.
async function dispatchAndParse(): Promise<{
  status: number;
  result: { kind: string; card: { title: string; body: string; variant: string }; ref?: unknown };
}> {
  const res = await POST(makeEvent({ conversationId: "c1" }));
  const json = (await res.json()) as {
    result: { kind: string; card: { title: string; body: string; variant: string }; ref?: unknown };
  };
  return { status: res.status, result: json.result };
}

// ── Pre-tool branches ─────────────────────────────────────────────────

describe("forwardDistillToBundled — pre-tool branches", () => {
  test("tool not registered (even after loadFromDb) → 'Distiller unavailable' error card", async () => {
    // Both the initial lookup AND the post-loadFromDb retry return
    // null → forwarder bails before constructing a ToolExecutor.
    registryGetTool.mockReturnValue(null);
    const { result } = await dispatchAndParse();
    expect(result.kind).toBe("error");
    expect(result.card.title).toMatch(/distiller unavailable/i);
    expect(result.card.variant).toBe("error");
    // loadFromDb attempted exactly once — the registry self-heal is
    // fire-once per request; without that ceiling a missing tool would
    // hammer the DB on every dispatch.
    expect(registryLoadFromDb).toHaveBeenCalledTimes(1);
    // Tool was NEVER invoked.
    expect(executeToolCall).not.toHaveBeenCalled();
  });

  test("tool registered after loadFromDb retry → forwarder proceeds", async () => {
    // First lookup misses (cold registry), `loadFromDb` populates it,
    // second lookup finds the tool. Same outcome as the happy path.
    registryGetTool
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ name: "lessons-distiller__distill_now", handler: vi.fn() });
    executeToolCall.mockResolvedValueOnce(
      envelopeResult({
        kind: "success",
        lesson: { title: "Use parameterized queries", slug: "use-parameterized-queries" },
      }),
    );
    const { result } = await dispatchAndParse();
    expect(result.kind).toBe("success");
    expect(registryGetTool).toHaveBeenCalledTimes(2);
    expect(registryLoadFromDb).toHaveBeenCalledTimes(1);
  });

  test("tool throws → 'Distiller failed' error card with the thrown message", async () => {
    executeToolCall.mockRejectedValueOnce(new Error("oom"));
    const { result } = await dispatchAndParse();
    expect(result.kind).toBe("error");
    expect(result.card.title).toMatch(/distiller failed/i);
    expect(result.card.body).toMatch(/oom/);
    expect(result.card.variant).toBe("error");
  });

  test("tool returns non-envelope text → 'unexpected response shape' error", async () => {
    // Some other tool implementation returning plain text — the
    // forwarder's envelope flag is missing, so it falls through to
    // the "unexpected response shape" branch.
    executeToolCall.mockResolvedValueOnce({
      content: [{ type: "text", text: '{"someOther":"json"}' }],
      isError: false,
    });
    const { result } = await dispatchAndParse();
    expect(result.kind).toBe("error");
    expect(result.card.body).toMatch(/unexpected response shape/i);
  });

  test("tool returns non-JSON text → also lands in 'unexpected response shape'", async () => {
    // JSON.parse throws → the catch in the forwarder swallows it,
    // envelope stays null, same fallthrough as the missing-flag case.
    executeToolCall.mockResolvedValueOnce({
      content: [{ type: "text", text: "not json at all" }],
      isError: false,
    });
    const { result } = await dispatchAndParse();
    expect(result.kind).toBe("error");
    expect(result.card.body).toMatch(/unexpected response shape/i);
  });

  test("tool returns isError=true with non-envelope text → error card with the tool's text", async () => {
    // Pre-envelope error path — surface the tool's error text in the
    // body so the user sees something useful, not a bare "unexpected".
    executeToolCall.mockResolvedValueOnce({
      content: [{ type: "text", text: "tool internal failure" }],
      isError: true,
    });
    const { result } = await dispatchAndParse();
    expect(result.kind).toBe("error");
    expect(result.card.body).toMatch(/tool returned error.*tool internal failure/i);
  });
});

// ── Outcome → card mapping (success) ─────────────────────────────────

describe("forwardDistillToBundled — success outcome", () => {
  test("success → 'Lesson captured' card with title + slug + ref", async () => {
    executeToolCall.mockResolvedValueOnce(
      envelopeResult({
        kind: "success",
        lesson: { title: "Use parameterized queries", slug: "use-parameterized-queries" },
      }),
    );
    const { result } = await dispatchAndParse();
    expect(result.kind).toBe("success");
    expect(result.card.title).toMatch(/lesson captured/i);
    // Body interpolates both title and slug — the chat renderer relies
    // on the slug appearing for the inline link.
    expect(result.card.body).toMatch(/use parameterized queries/i);
    expect(result.card.body).toMatch(/use-parameterized-queries/);
    expect(result.card.variant).toBe("success");
    expect(result.ref).toEqual({ kind: "lesson", slug: "use-parameterized-queries" });
  });
});

// ── Outcome → card mapping (declines) ────────────────────────────────

describe("forwardDistillToBundled — decline outcomes (7 variants)", () => {
  test("decline:empty_conversation → 'Not enough context' info card", async () => {
    executeToolCall.mockResolvedValueOnce(
      envelopeResult({ kind: "decline", reason: "empty_conversation" }),
    );
    const { result } = await dispatchAndParse();
    expect(result.kind).toBe("decline");
    expect(result.card.title).toMatch(/not enough context/i);
    expect(result.card.variant).toBe("info");
  });

  test("decline:llm_empty → 'Distiller declined' info card", async () => {
    executeToolCall.mockResolvedValueOnce(envelopeResult({ kind: "decline", reason: "llm_empty" }));
    const { result } = await dispatchAndParse();
    expect(result.kind).toBe("decline");
    expect(result.card.title).toMatch(/distiller declined/i);
    expect(result.card.body).toMatch(/no reusable insight/i);
    expect(result.card.variant).toBe("info");
  });

  test("decline:llm_malformed → warning card with the parse-error detail", async () => {
    executeToolCall.mockResolvedValueOnce(
      envelopeResult({ kind: "decline", reason: "llm_malformed", detail: "missing required fields" }),
    );
    const { result } = await dispatchAndParse();
    expect(result.kind).toBe("decline");
    expect(result.card.body).toMatch(/missing required fields/);
    expect(result.card.variant).toBe("warning");
  });

  test("decline:llm_malformed without detail → fallback wording", async () => {
    executeToolCall.mockResolvedValueOnce(envelopeResult({ kind: "decline", reason: "llm_malformed" }));
    const { result } = await dispatchAndParse();
    expect(result.card.body).toMatch(/unknown parse error/i);
  });

  test("decline:slug_collision → 'Already captured' info card with existingSlug", async () => {
    executeToolCall.mockResolvedValueOnce(
      envelopeResult({ kind: "decline", reason: "slug_collision", existingSlug: "older-lesson" }),
    );
    const { result } = await dispatchAndParse();
    expect(result.kind).toBe("decline");
    expect(result.card.title).toMatch(/already captured/i);
    expect(result.card.body).toMatch(/older-lesson/);
    expect(result.card.variant).toBe("info");
  });

  test("decline:slug_collision without existingSlug → fallback '(unknown)'", async () => {
    executeToolCall.mockResolvedValueOnce(envelopeResult({ kind: "decline", reason: "slug_collision" }));
    const { result } = await dispatchAndParse();
    expect(result.card.body).toMatch(/\(unknown\)/);
  });

  test("decline:settings_disabled → warning card pointing to extension settings", async () => {
    // settings_disabled is the bundled extension's own decline reason
    // (the legacy distillNow had a 'no_chat_run' equivalent that does
    // not appear here). The card variant is `warning`, not `info`,
    // because the user's expectation was "this should run" and an off
    // setting is the kind of misconfig they want flagged.
    executeToolCall.mockResolvedValueOnce(
      envelopeResult({ kind: "decline", reason: "settings_disabled" }),
    );
    const { result } = await dispatchAndParse();
    expect(result.kind).toBe("decline");
    expect(result.card.title).toMatch(/distiller is disabled/i);
    expect(result.card.body).toMatch(/turned off/i);
    expect(result.card.variant).toBe("warning");
  });

  test("decline:trigger_gate_blocked → ERROR card (manual handler should never see this)", async () => {
    // The manual `!EZ:distill` path passes skipTriggerGate=true so
    // this branch is unreachable in practice. The forwarder maps it
    // to an error card (NOT a decline) so the bug surfaces visibly
    // if it ever fires — defensive programming, not user-facing UX.
    executeToolCall.mockResolvedValueOnce(
      envelopeResult({ kind: "decline", reason: "trigger_gate_blocked" }),
    );
    const { result } = await dispatchAndParse();
    expect(result.kind).toBe("error");
    expect(result.card.body).toMatch(/please report this bug/i);
    expect(result.card.variant).toBe("error");
  });

  test("decline with an unknown reason → default-branch info card with the raw reason", async () => {
    // Forward-compat: a future bundled-extension upgrade may add new
    // decline reasons before the host fans them out into bespoke
    // cards. Fall through to a generic "Reason: …" rather than 500.
    executeToolCall.mockResolvedValueOnce(
      envelopeResult({ kind: "decline", reason: "future_unknown_reason" }),
    );
    const { result } = await dispatchAndParse();
    expect(result.kind).toBe("decline");
    expect(result.card.body).toMatch(/reason: future_unknown_reason/i);
    expect(result.card.variant).toBe("info");
  });
});

// ── Outcome → card mapping (errors) ──────────────────────────────────

describe("forwardDistillToBundled — error outcomes (3 variants)", () => {
  test("error:llm_error → 'LLM call failed' error card with detail", async () => {
    executeToolCall.mockResolvedValueOnce(
      envelopeResult({ kind: "error", reason: "llm_error", detail: "rate limited" }),
    );
    const { result } = await dispatchAndParse();
    expect(result.kind).toBe("error");
    expect(result.card.title).toMatch(/distiller failed/i);
    expect(result.card.body).toMatch(/llm call failed.*rate limited/i);
    expect(result.card.variant).toBe("error");
  });

  test("error:llm_error without detail → fallback 'unknown LLM error'", async () => {
    executeToolCall.mockResolvedValueOnce(envelopeResult({ kind: "error", reason: "llm_error" }));
    const { result } = await dispatchAndParse();
    expect(result.card.body).toMatch(/unknown llm error/i);
  });

  test("error:db_error → 'Database error' error card with detail", async () => {
    executeToolCall.mockResolvedValueOnce(
      envelopeResult({ kind: "error", reason: "db_error", detail: "connection refused" }),
    );
    const { result } = await dispatchAndParse();
    expect(result.kind).toBe("error");
    expect(result.card.body).toMatch(/database error.*connection refused/i);
  });

  test("error:internal → fallback error card with detail", async () => {
    executeToolCall.mockResolvedValueOnce(
      envelopeResult({ kind: "error", reason: "internal", detail: "no projectId" }),
    );
    const { result } = await dispatchAndParse();
    expect(result.kind).toBe("error");
    // The "internal" branch ends up in the catch-all error mapper —
    // body interpolates `detail` (preferred) over the raw reason.
    expect(result.card.body).toMatch(/no projectId/);
  });

  test("error with an unknown reason and no detail → fallback uses the reason string", async () => {
    executeToolCall.mockResolvedValueOnce(
      envelopeResult({ kind: "error", reason: "future_error_reason" }),
    );
    const { result } = await dispatchAndParse();
    expect(result.kind).toBe("error");
    expect(result.card.body).toMatch(/future_error_reason/);
  });
});

// ── Cross-cutting wiring ─────────────────────────────────────────────

describe("forwardDistillToBundled — wiring invariants", () => {
  test("ToolExecutor.setCurrentUserId is called with the authenticated user id", async () => {
    // Wiring sanity: the executor's cross-extension auth threading
    // depends on this — the forwarder is the entry point that hands
    // the user id from the request locals to the runtime.
    executeToolCall.mockResolvedValueOnce(
      envelopeResult({
        kind: "success",
        lesson: { title: "x", slug: "x" },
      }),
    );
    await dispatchAndParse();
    expect(setCurrentUserId).toHaveBeenCalledWith(USER.id);
  });

  test("executeToolCall receives the namespaced tool name + conversationId + a unique sentinel", async () => {
    executeToolCall.mockResolvedValueOnce(
      envelopeResult({
        kind: "success",
        lesson: { title: "x", slug: "x" },
      }),
    );
    await dispatchAndParse();
    expect(executeToolCall).toHaveBeenCalledTimes(1);
    const [tool, args, convId, sentinel] = executeToolCall.mock.calls[0]!;
    expect(tool).toBe("lessons-distiller__distill_now");
    expect(args).toEqual({ conversationId: "c1" });
    expect(convId).toBe("c1");
    // [S2] Pre-fix this was `ez-action-distill-${Date.now()}` which
    // collided under burst load. The randomUUID rewrite means the
    // sentinel always carries the prefix + a UUIDv4 suffix.
    //
    // v1.4 — the generic forwarder builds the prefix from the
    // resolved `<ext>-<tool>` pair (the legacy `distill` alias
    // rewrites to `lessons-distiller:distill_now` before reaching the
    // forwarder). Pre-v1.4 prefix was `ez-action-distill-`; new
    // prefix is `ez-action-lessons-distiller-distill_now-`.
    expect(sentinel).toMatch(/^ez-action-lessons-distiller-distill_now-[0-9a-f-]{36}$/i);
  });

  test("[S2] two back-to-back dispatches in the same ms → distinct messageIdSentinels", async () => {
    // Regression guard for the burst-load uniqueness fix. The two
    // dispatches will resolve in this test's tick window — pre-fix
    // they'd produce identical Date.now()-based sentinels.
    executeToolCall.mockResolvedValue(
      envelopeResult({ kind: "success", lesson: { title: "x", slug: "x" } }),
    );
    await dispatchAndParse();
    await dispatchAndParse();
    const [, , , firstSentinel] = executeToolCall.mock.calls[0]!;
    const [, , , secondSentinel] = executeToolCall.mock.calls[1]!;
    expect(firstSentinel).not.toBe(secondSentinel);
  });

  test("[N4] getPermissionEngine is called with a {registry, bus, db} deps object (cold-start guard for 275ebce)", async () => {
    // Pre-fix `getPermissionEngine()` zero-arg threw on cold start; the
    // forwarder is the FIRST PermissionEngine touch in the boot
    // sequence (no agent has streamed yet), so a missing deps object
    // would surface as "Distiller failed (Unexpected error: ...not
    // initialized)" on the first `!EZ:distill` after a restart. Locking
    // the signature in so a future refactor can't silently drop the
    // deps argument again.
    executeToolCall.mockResolvedValueOnce(
      envelopeResult({
        kind: "success",
        lesson: { title: "x", slug: "x" },
      }),
    );
    await dispatchAndParse();
    expect(getPermissionEngineSpy).toHaveBeenCalled();
    const callArgs = getPermissionEngineSpy.mock.calls[0]!;
    expect(callArgs.length).toBeGreaterThanOrEqual(1);
    const deps = callArgs[0] as { registry?: unknown; bus?: unknown; db?: unknown };
    expect(deps).toBeDefined();
    expect(deps.registry).toBeDefined();
    expect(deps.bus).toBeDefined();
    expect(deps.db).toBeDefined();
  });

  test("the EzActionResult is persisted as a synthetic ez-action-result message", async () => {
    // Same persistence contract as the registry-handler path; this
    // assertion catches a regression where the forwarder forgets to
    // round-trip back through the persistence path.
    executeToolCall.mockResolvedValueOnce(
      envelopeResult({
        kind: "success",
        lesson: { title: "X", slug: "x" },
      }),
    );
    const { status, result } = await dispatchAndParse();
    expect(status).toBe(200);
    expect(result.kind).toBe("success");
    expect(mockCreateMessage).toHaveBeenCalledTimes(1);
    const [, data] = mockCreateMessage.mock.calls[0]!;
    expect(data.role).toBe("ez-action-result");
    expect(JSON.parse(data.content).kind).toBe("success");
  });
});
