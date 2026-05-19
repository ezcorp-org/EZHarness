/**
 * Unit tests for `src/extensions/runtime-invoke-handler.ts` — the host-
 * side dispatcher for `runtime.*` `ezcorp/invoke` methods used by the
 * lessons-distiller bundled extension (Phase 53 Stage 1).
 *
 * Covers:
 *   - `isRuntimeInvokeMethod` prefix routing.
 *   - JSON-RPC error codes for unknown methods (-32601).
 *   - The conversation-scope auth gate ([C1]/[C2]):
 *       `args.conversationId === ctx.currentConversationId`. Mismatch →
 *       -32604, regardless of whether the row actually exists. This
 *       gate is the regression guard for the cross-user message-leak
 *       audit finding — without it any installed extension could read
 *       any conversation's messages.
 *   - Param-shape validation (-32602) when `conversationId` is missing /
 *     wrong type.
 *   - Not-found vs DB-error distinction on `getConversation` ([S3]):
 *     null result → -32604, throw → -32603. Pre-fix this branch was
 *     silent + returned `projectId: null`, indistinguishable from a
 *     legit projectless conversation.
 *   - Error mapping for `getMessages` and `triggerGate` DB throws (-32603).
 *   - Happy paths for all three methods (`getMessages`, `triggerGate`,
 *     `getMySettings`) including the `triggerGate` reason-string format.
 *
 * Mocks: the imported queries are stubbed via `mock.module`. No DB,
 * no network. The `triggers.*` heuristics are mocked too so each
 * `triggerGate` test can assert on the reason string deterministically
 * (the real heuristics are covered by `lesson-distiller-triggers.test.ts`).
 */

import { test, expect, describe, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { JsonRpcRequest } from "../extensions/types";

// ── Module mocks (must precede the import-under-test) ─────────────────

const mockGetConversation = mock(async (_id: string) => null as { id: string; projectId: string | null } | null);
const mockGetMessages = mock(async (_id: string) => [] as { id: string; role: string; content: string }[]);
const mockListToolCallsByConversation = mock(async (_id: string) => [] as { success: boolean }[]);
const mockResolveExtensionSettings = mock(
  async (_extId: string, _userId: string | null, _schema: unknown) => ({}) as Record<string, unknown>,
);
const mockShouldDistill = mock((_input: unknown) => false);
const mockDetectErrorRecovery = mock((_rows: unknown) => false);
const mockDetectExplicitTag = mock((_texts: unknown) => false);
const mockDetectUserCorrection = mock((_texts: unknown) => false);

mock.module("../db/queries/conversations", () => ({
  getConversation: (id: string) => mockGetConversation(id),
  getMessages: (id: string) => mockGetMessages(id),
}));
mock.module("../db/queries/tool-calls", () => ({
  listToolCallsByConversation: (id: string) => mockListToolCallsByConversation(id),
}));
mock.module("../db/queries/extension-settings", () => ({
  resolveExtensionSettings: (extId: string, userId: string | null, schema: unknown) =>
    mockResolveExtensionSettings(extId, userId, schema),
}));
mock.module("../runtime/lessons/triggers", () => ({
  shouldDistill: (input: unknown) => mockShouldDistill(input),
  detectErrorRecovery: (rows: unknown) => mockDetectErrorRecovery(rows),
  detectExplicitTag: (texts: unknown) => mockDetectExplicitTag(texts),
  detectUserCorrection: (texts: unknown) => mockDetectUserCorrection(texts),
}));

// Import after mocks so the handler picks up the mocked dependencies.
const { handleRuntimeInvoke, isRuntimeInvokeMethod } = await import(
  "../extensions/runtime-invoke-handler"
);
type RuntimeInvokeContext = import("../extensions/runtime-invoke-handler").RuntimeInvokeContext;

afterAll(() => {
  restoreModuleMocks();
});

// ── Fixtures ──────────────────────────────────────────────────────────

function makeReq(method: string, params: Record<string, unknown> = {}): JsonRpcRequest {
  return { jsonrpc: "2.0", id: 1, method: "ezcorp/invoke", params: { tool: method, arguments: params } };
}

function makeCtx(overrides: Partial<RuntimeInvokeContext> = {}): RuntimeInvokeContext {
  return {
    extensionId: "ext-caller",
    userId: "u1",
    currentConversationId: "conv-1",
    granted: { grantedAt: {} },
    ...overrides,
  };
}

beforeEach(() => {
  mockGetConversation.mockReset();
  mockGetMessages.mockReset();
  mockListToolCallsByConversation.mockReset();
  mockResolveExtensionSettings.mockReset();
  mockShouldDistill.mockReset();
  mockDetectErrorRecovery.mockReset();
  mockDetectExplicitTag.mockReset();
  mockDetectUserCorrection.mockReset();
  // Default sensible returns; individual tests override.
  mockGetConversation.mockImplementation(async (_id: string) => ({ id: _id, projectId: "proj-1" }));
  mockGetMessages.mockImplementation(async () => []);
  mockListToolCallsByConversation.mockImplementation(async () => []);
  mockResolveExtensionSettings.mockImplementation(async () => ({}));
  mockShouldDistill.mockImplementation(() => false);
  mockDetectErrorRecovery.mockImplementation(() => false);
  mockDetectExplicitTag.mockImplementation(() => false);
  mockDetectUserCorrection.mockImplementation(() => false);
});

// ── Method routing / unknown-method handling ──────────────────────────

describe("isRuntimeInvokeMethod", () => {
  test("returns true on the runtime.* prefix", () => {
    expect(isRuntimeInvokeMethod("runtime.conversations.getMessages")).toBe(true);
    expect(isRuntimeInvokeMethod("runtime.lessons.triggerGate")).toBe(true);
    expect(isRuntimeInvokeMethod("runtime.settings.getMine")).toBe(true);
    // Future-proof: any runtime.* string routes through here, even
    // unknown ones (which then fall through to the -32601 case).
    expect(isRuntimeInvokeMethod("runtime.future.method")).toBe(true);
  });

  test("returns false for non-runtime targets", () => {
    expect(isRuntimeInvokeMethod("lessons-distiller__distill_now")).toBe(false);
    expect(isRuntimeInvokeMethod("foo__bar")).toBe(false);
    // Edge: empty / no-prefix names are not runtime targets.
    expect(isRuntimeInvokeMethod("")).toBe(false);
    expect(isRuntimeInvokeMethod("runtime")).toBe(false); // no trailing dot
  });
});

describe("handleRuntimeInvoke — unknown methods", () => {
  test("unknown runtime.* method → JSON-RPC -32601 (Method not found)", async () => {
    const res = await handleRuntimeInvoke(
      "runtime.unknown.thing",
      {},
      makeCtx(),
      makeReq("runtime.unknown.thing"),
    );
    expect(res.error?.code).toBe(-32601);
    expect(res.error?.message).toMatch(/unknown runtime invoke method/i);
    expect(res.result).toBeUndefined();
  });
});

// ── runtime.conversations.getMessages ─────────────────────────────────

describe("handleRuntimeInvoke — runtime.conversations.getMessages", () => {
  test("non-string conversationId → -32602 (Invalid params)", async () => {
    const res = await handleRuntimeInvoke(
      "runtime.conversations.getMessages",
      { conversationId: 42 },
      makeCtx(),
      makeReq("runtime.conversations.getMessages"),
    );
    expect(res.error?.code).toBe(-32602);
    expect(res.error?.message).toMatch(/conversationid required/i);
    // Not even a DB call should happen on a param-shape failure.
    expect(mockGetConversation).not.toHaveBeenCalled();
    expect(mockGetMessages).not.toHaveBeenCalled();
  });

  test("missing conversationId → -32602", async () => {
    const res = await handleRuntimeInvoke(
      "runtime.conversations.getMessages",
      {},
      makeCtx(),
      makeReq("runtime.conversations.getMessages"),
    );
    expect(res.error?.code).toBe(-32602);
  });

  test("[C1] conversationId mismatch vs ctx.currentConversationId → -32604", async () => {
    // The regression guard for the cross-user message-leak audit
    // finding. Pre-fix this returned the messages of conv-OTHER even
    // though the executor was wired into conv-1.
    const res = await handleRuntimeInvoke(
      "runtime.conversations.getMessages",
      { conversationId: "conv-OTHER" },
      makeCtx({ currentConversationId: "conv-1" }),
      makeReq("runtime.conversations.getMessages"),
    );
    expect(res.error?.code).toBe(-32604);
    expect(res.error?.message).toMatch(/conversationid must match current conversation/i);
    // CRITICAL: the gate fires BEFORE any DB read, so a mismatched
    // call cannot oracle-leak even existence info.
    expect(mockGetConversation).not.toHaveBeenCalled();
    expect(mockGetMessages).not.toHaveBeenCalled();
  });

  test("[C1] currentConversationId === null (system / scheduled context) → -32604", async () => {
    // Schedule-fired and other system-driven calls have no
    // conversation context; the only safe answer is "no". A null ctx
    // value means even a perfectly-formed args.conversationId rejects.
    const res = await handleRuntimeInvoke(
      "runtime.conversations.getMessages",
      { conversationId: "conv-1" },
      makeCtx({ currentConversationId: null }),
      makeReq("runtime.conversations.getMessages"),
    );
    expect(res.error?.code).toBe(-32604);
    expect(mockGetConversation).not.toHaveBeenCalled();
  });

  test("happy path — returns {messages, projectId} envelope", async () => {
    mockGetConversation.mockImplementation(async () => ({ id: "conv-1", projectId: "proj-7" }));
    mockGetMessages.mockImplementation(async () => [
      { id: "m1", role: "user", content: "hi" },
      { id: "m2", role: "assistant", content: "hello" },
    ]);
    const res = await handleRuntimeInvoke(
      "runtime.conversations.getMessages",
      { conversationId: "conv-1" },
      makeCtx({ currentConversationId: "conv-1" }),
      makeReq("runtime.conversations.getMessages"),
    );
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({
      messages: [
        { id: "m1", role: "user", content: "hi" },
        { id: "m2", role: "assistant", content: "hello" },
      ],
      projectId: "proj-7",
    });
  });

  test("[S3] conversation not found (getConversation returns null) → -32604", async () => {
    // Distinguishes a deleted/missing conversation from a transient
    // DB error. Pre-S3-fix both produced `projectId: null` envelopes.
    mockGetConversation.mockImplementation(async () => null);
    const res = await handleRuntimeInvoke(
      "runtime.conversations.getMessages",
      { conversationId: "conv-1" },
      makeCtx({ currentConversationId: "conv-1" }),
      makeReq("runtime.conversations.getMessages"),
    );
    expect(res.error?.code).toBe(-32604);
    expect(res.error?.message).toMatch(/conversation not found/i);
    // getMessages MUST NOT be called once the conversation is known to
    // be missing — saves a useless query and prevents the listener-
    // path race where the row is gone but the messages haven't been
    // GC'd yet from leaking ghost rows.
    expect(mockGetMessages).not.toHaveBeenCalled();
  });

  test("[S3] getConversation throws (DB error) → -32603", async () => {
    mockGetConversation.mockImplementation(async () => {
      throw new Error("connection refused");
    });
    const res = await handleRuntimeInvoke(
      "runtime.conversations.getMessages",
      { conversationId: "conv-1" },
      makeCtx({ currentConversationId: "conv-1" }),
      makeReq("runtime.conversations.getMessages"),
    );
    expect(res.error?.code).toBe(-32603);
    expect(res.error?.message).toMatch(/getconversation failed.*connection refused/i);
    expect(mockGetMessages).not.toHaveBeenCalled();
  });

  test("getMessages throws (DB error after conversation row found) → -32603", async () => {
    mockGetConversation.mockImplementation(async () => ({ id: "conv-1", projectId: "proj-1" }));
    mockGetMessages.mockImplementation(async () => {
      throw new Error("query timeout");
    });
    const res = await handleRuntimeInvoke(
      "runtime.conversations.getMessages",
      { conversationId: "conv-1" },
      makeCtx({ currentConversationId: "conv-1" }),
      makeReq("runtime.conversations.getMessages"),
    );
    expect(res.error?.code).toBe(-32603);
    expect(res.error?.message).toMatch(/getmessages failed.*query timeout/i);
  });

  test("non-string message content gets coerced to string", async () => {
    mockGetConversation.mockImplementation(async () => ({ id: "conv-1", projectId: "proj-1" }));
    // Some assistant rows carry structured content blocks; the handler
    // coerces with String(...) so the SDK contract stays text-only.
    mockGetMessages.mockImplementation(async () => [
      // Synthetic row with non-string content to exercise the coercion
      // branch; cast through `unknown` keeps the type system happy
      // without an `any` escape hatch.
      { id: "m1", role: "assistant", content: { blocks: ["x"] } as unknown as string },
    ]);
    const res = await handleRuntimeInvoke(
      "runtime.conversations.getMessages",
      { conversationId: "conv-1" },
      makeCtx({ currentConversationId: "conv-1" }),
      makeReq("runtime.conversations.getMessages"),
    );
    const result = res.result as { messages: { id: string; content: string }[] };
    expect(typeof result.messages[0]!.content).toBe("string");
  });
});

// ── runtime.lessons.triggerGate ───────────────────────────────────────

describe("handleRuntimeInvoke — runtime.lessons.triggerGate", () => {
  test("non-string conversationId → -32602", async () => {
    const res = await handleRuntimeInvoke(
      "runtime.lessons.triggerGate",
      { conversationId: null },
      makeCtx(),
      makeReq("runtime.lessons.triggerGate"),
    );
    expect(res.error?.code).toBe(-32602);
    expect(mockListToolCallsByConversation).not.toHaveBeenCalled();
  });

  test("[C2] conversationId mismatch vs ctx.currentConversationId → -32604", async () => {
    // Same auth gate as getMessages, same regression guard. The
    // trigger-reasoning string exposes recent message-text signals
    // (user-correction, explicit-tag matches), so the cross-user leak
    // here is just as sensitive — possibly more so, since the LLM-
    // generated text is the thing operators are trying to redact.
    const res = await handleRuntimeInvoke(
      "runtime.lessons.triggerGate",
      { conversationId: "conv-EVIL" },
      makeCtx({ currentConversationId: "conv-1" }),
      makeReq("runtime.lessons.triggerGate"),
    );
    expect(res.error?.code).toBe(-32604);
    expect(res.error?.message).toMatch(/conversationid must match current conversation/i);
    expect(mockListToolCallsByConversation).not.toHaveBeenCalled();
    expect(mockGetMessages).not.toHaveBeenCalled();
  });

  test("[C2] currentConversationId === null → -32604", async () => {
    const res = await handleRuntimeInvoke(
      "runtime.lessons.triggerGate",
      { conversationId: "conv-1" },
      makeCtx({ currentConversationId: null }),
      makeReq("runtime.lessons.triggerGate"),
    );
    expect(res.error?.code).toBe(-32604);
    expect(mockListToolCallsByConversation).not.toHaveBeenCalled();
  });

  test("happy path — fire=true returns {shouldDistill: true, reason: 'trigger-fired'}", async () => {
    mockListToolCallsByConversation.mockImplementation(async () => [
      { success: true },
      { success: false },
    ]);
    mockGetMessages.mockImplementation(async () => [
      { id: "m1", role: "user", content: "this is wrong, please redo" },
    ]);
    mockShouldDistill.mockImplementation(() => true);
    const res = await handleRuntimeInvoke(
      "runtime.lessons.triggerGate",
      { conversationId: "conv-1" },
      makeCtx({ currentConversationId: "conv-1" }),
      makeReq("runtime.lessons.triggerGate"),
    );
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ shouldDistill: true, reason: "trigger-fired" });
    // Argument shape we hand `shouldDistill` is the contract the
    // bundled distiller relies on — assert it once here so a refactor
    // can't silently shrink the input.
    expect(mockShouldDistill).toHaveBeenCalledWith({
      toolCallCount: 2,
      errorRecoveryObserved: false,
      userCorrectionObserved: false,
      explicitlyTagged: false,
    });
  });

  test("happy path — fire=false returns no-signal reason with all 4 components", async () => {
    mockListToolCallsByConversation.mockImplementation(async () => []);
    mockGetMessages.mockImplementation(async () => []);
    mockShouldDistill.mockImplementation(() => false);
    const res = await handleRuntimeInvoke(
      "runtime.lessons.triggerGate",
      { conversationId: "conv-1" },
      makeCtx({ currentConversationId: "conv-1" }),
      makeReq("runtime.lessons.triggerGate"),
    );
    const result = res.result as { shouldDistill: boolean; reason: string };
    expect(result.shouldDistill).toBe(false);
    // The reason format is part of the operator-facing contract — the
    // listener path logs it on declines for debugging trigger
    // misfires. Asserting the shape locks it in.
    expect(result.reason).toMatch(/no-signal/);
    expect(result.reason).toMatch(/toolCalls=0/);
    expect(result.reason).toMatch(/errorRecovery=false/);
    expect(result.reason).toMatch(/userCorrection=false/);
    expect(result.reason).toMatch(/tagged=false/);
  });

  test("listToolCallsByConversation throws (DB error) → -32603", async () => {
    mockListToolCallsByConversation.mockImplementation(async () => {
      throw new Error("pglite died");
    });
    const res = await handleRuntimeInvoke(
      "runtime.lessons.triggerGate",
      { conversationId: "conv-1" },
      makeCtx({ currentConversationId: "conv-1" }),
      makeReq("runtime.lessons.triggerGate"),
    );
    expect(res.error?.code).toBe(-32603);
    expect(res.error?.message).toMatch(/triggergate read failed.*pglite died/i);
  });
});

// ── runtime.settings.getMine ──────────────────────────────────────────

describe("handleRuntimeInvoke — runtime.settings.getMine", () => {
  test("happy path — passes ctx.extensionId/userId/schema to resolver and returns the resolved settings", async () => {
    mockResolveExtensionSettings.mockImplementation(async () => ({ enabled: true, provider: "google" }));
    const ctx = makeCtx({
      extensionId: "ext-caller",
      userId: "u1",
      // SettingsSchema shape — the handler just passes it through.
      settingsSchema: { enabled: { type: "boolean", default: true } } as never,
    });
    const res = await handleRuntimeInvoke(
      "runtime.settings.getMine",
      {},
      ctx,
      makeReq("runtime.settings.getMine"),
    );
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ enabled: true, provider: "google" });
    // CRITICAL invariant: the resolver gets ctx.extensionId, NOT a
    // value pulled from caller-supplied args. This is what makes
    // `settings.getMine` structurally immune to the [C1]/[C2] family
    // of bugs — the auth identity comes from the host, not the wire.
    expect(mockResolveExtensionSettings).toHaveBeenCalledWith(
      "ext-caller",
      "u1",
      { enabled: { type: "boolean", default: true } },
    );
  });

  test("resolveExtensionSettings throws → -32603", async () => {
    mockResolveExtensionSettings.mockImplementation(async () => {
      throw new Error("schema validation failed");
    });
    const res = await handleRuntimeInvoke(
      "runtime.settings.getMine",
      {},
      makeCtx(),
      makeReq("runtime.settings.getMine"),
    );
    expect(res.error?.code).toBe(-32603);
    expect(res.error?.message).toMatch(/settings resolve failed.*schema validation failed/i);
  });
});
